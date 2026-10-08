/**
 * Timeout-nerf regression and corpus-equivalence tests.
 *
 * The fixture contains sanitized commands sampled from a 30-day session corpus;
 * expected spans were computed by the independently mutation-tested Python
 * oracle. In particular, the redirection tests below fail against the original
 * background-operator regex, which misclassified `2>&1` as a background `&`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    bashGuidelines,
    findTimeoutInvocation,
    nerfNote,
    parseDurationSeconds,
    planNerf,
    registerTimeoutNerf,
    type NerfPlan,
} from "../features/timeout-nerf/index.ts";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolCallEvent,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";

interface CorpusExpected {
    token: string;
    seconds: number;
    start: number;
    end: number;
}

interface CorpusCase {
    category: string;
    command: string;
    expected: CorpusExpected | null;
}

interface CorpusFixture {
    generated_by: string;
    window_days: number;
    files_scanned: number;
    cases: CorpusCase[];
}

const corpus = JSON.parse(
    readFileSync(
        new URL("./fixtures/timeout-nerf-corpus.json", import.meta.url),
        "utf8"
    )
) as CorpusFixture;

void describe("timeout-nerf parser", () => {
    void it("matches the Python oracle for every sanitized corpus command", () => {
        const counts = new Map<string, { passed: number; total: number }>();

        for (const fixtureCase of corpus.cases) {
            const result = findTimeoutInvocation(fixtureCase.command);
            // The fixture holds the Python oracle's spans, and the oracle has no
            // notion of `flags` (a rewrite-side addition), so compare the fields
            // the oracle defines rather than the whole object.
            const oracleFields = result
                ? {
                      token: result.token,
                      seconds: result.seconds,
                      start: result.start,
                      end: result.end,
                  }
                : null;
            assert.deepEqual(
                oracleFields,
                fixtureCase.expected,
                `category=${fixtureCase.category} command=${JSON.stringify(fixtureCase.command)}`
            );
            const category = counts.get(fixtureCase.category) ?? {
                passed: 0,
                total: 0,
            };
            category.passed += 1;
            category.total += 1;
            counts.set(fixtureCase.category, category);
        }

        assert.equal(corpus.cases.length, 173);
        assert.equal(
            corpus.cases.filter((fixtureCase) => fixtureCase.expected === null)
                .length,
            25
        );
        const summary = [...counts.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(
                ([category, count]) =>
                    `${category}:${count.passed}/${count.total}`
            )
            .join(", ");
        assert.equal(
            [...counts.values()].reduce((sum, count) => sum + count.passed, 0),
            corpus.cases.length,
            `per-category corpus results: ${summary}`
        );
    });

    void it("parses fractional durations and rejects compound ones", () => {
        assert.equal(parseDurationSeconds("1.5h"), 5400);
        assert.equal(parseDurationSeconds("90s"), 90);
        assert.equal(parseDurationSeconds("2d"), 172800);

        // GNU `timeout` accepts one number with at most ONE unit suffix. A
        // compound token is rejected outright (`timeout: invalid time interval`,
        // exit 125), so accepting it would rewrite a command that FAILS into one
        // that runs — a silent success where the agent saw a failure.
        for (const invalid of ["2h30m", "1m30s", "1h30m30s", "", "abc", "1x"]) {
            assert.equal(parseDurationSeconds(invalid), null, invalid);
        }

        assert.deepEqual(findTimeoutInvocation("timeout 1.5h x"), {
            token: "1.5h",
            seconds: 5400,
            start: 0,
            end: "timeout 1.5h".length,
            flags: [],
        });
        assert.deepEqual(findTimeoutInvocation("/usr/bin/timeout 300 x"), {
            token: "300",
            seconds: 300,
            start: 0,
            end: "/usr/bin/timeout 300".length,
            flags: [],
        });
        assert.equal(findTimeoutInvocation("timeout -k 5 300 x")?.token, "300");
        assert.equal(
            findTimeoutInvocation("timeout --kill-after=5 300 x")?.token,
            "300"
        );
        assert.equal(
            findTimeoutInvocation("timeout -s TERM 300 x")?.token,
            "300"
        );
    });
});

void describe("timeout-nerf rewrite planning", () => {
    void it("does not confuse redirections or command chains with backgrounding", () => {
        const redirectionCases = [
            "timeout 300 make 2>&1 | tail -20",
            "cd /x && timeout 300 pytest 2>&1",
            "timeout 300 pytest > out.txt 2>&1",
        ];
        for (const command of redirectionCases) {
            const plan = planNerf(command);
            assert.equal(plan.action, "rewrite", command);
            assert.notEqual(plan.reason, "self-backgrounded", command);
        }

        const actualBackgroundCases = [
            "timeout 300 a &",
            "nohup timeout 300 a",
        ];
        for (const command of actualBackgroundCases) {
            const plan = planNerf(command);
            assert.equal(plan.action, "skip", command);
            assert.equal(plan.rewritten, command);
        }
        assert.equal(planNerf("timeout 300 a &").reason, "self-backgrounded");
        // `nohup` before `timeout` is non-leading; after it, it is detected as
        // an already-backgrounding wrapped command.
        assert.equal(planNerf("nohup timeout 300 a").reason, "not-leading");
        assert.equal(
            planNerf("timeout 300 nohup a").reason,
            "self-backgrounded"
        );

        assert.equal(planNerf("timeout 300 a && b").action, "rewrite");
        assert.equal(planNerf("timeout 300 a &> f").action, "rewrite");
    });

    void it("lifts simple cd prologues into cwd, including quoted paths", () => {
        const simple = planNerf("cd /repo && timeout 300 pytest");
        assert.equal(simple.action, "rewrite");
        assert.equal(simple.cwd, "/repo");
        assert.equal(simple.rewritten, "pytest");

        const quoted = planNerf('cd "a b" && timeout 300 pytest');
        assert.equal(quoted.action, "rewrite");
        assert.equal(quoted.cwd, "a b");
        assert.equal(quoted.rewritten, "pytest");
    });

    void it("keeps a cd prologue verbatim when lifting it would change its meaning", () => {
        // The bash tool resolves a per-call `cwd` with a plain path.resolve and
        // does NOT expand `~` or `$VAR`. Lifting these would resolve to a
        // literal relative path under the session cwd and run the command in
        // the WRONG directory, so the prologue must survive in the command.
        const cases: Array<[string, string]> = [
            ["cd ~/x && timeout 300 make", "cd ~/x && make"],
            ["cd $HOME/x && timeout 300 make", "cd $HOME/x && make"],
            ["cd /a/*/b && timeout 300 make", "cd /a/*/b && make"],
            ["cd /x && echo hi && timeout 300 y", "cd /x && echo hi && y"],
        ];

        for (const [command, expected] of cases) {
            const plan = planNerf(command);
            assert.equal(plan.action, "rewrite", command);
            assert.equal(plan.cwd, null, command);
            assert.equal(plan.rewritten, expected, command);
            // The seam between a kept prologue and the tail must not leave a
            // double space, which would be a visible artefact of the rewrite.
            assert.ok(!/\s\s/.test(plan.rewritten), plan.rewritten);
        }
    });

    void it("only lifts a `cd` prologue joined by `&&`", () => {
        // `&&` short-circuits, so a `cd` that fails also skips the rest of the
        // command — a lifted cwd reproduces that. After `;` the rest runs in the
        // ORIGINAL directory even when the `cd` failed, and no `cwd` can
        // reproduce that, so the prologue has to stay in the command.
        const lifted = planNerf("cd /repo && timeout 300 pytest");
        assert.equal(lifted.action, "rewrite");
        assert.equal(lifted.cwd, "/repo");
        assert.equal(lifted.rewritten, "pytest");

        const kept = planNerf("cd /definitely-missing; timeout 300 pwd");
        assert.equal(kept.action, "rewrite");
        assert.equal(kept.cwd, null);
        assert.equal(kept.rewritten, "cd /definitely-missing; pwd");
    });

    void it("never lifts a shell-relative or option-like cd target", () => {
        // `cd -` means `$OLDPWD`, and `cd --` / `cd -P` are shell options. The
        // tool would resolve them as literal relative paths, or fail outright.
        for (const directory of ["-", "--", "-P /tmp", "-LP /tmp"]) {
            const plan = planNerf(`cd ${directory} && timeout 300 pwd`);
            assert.equal(plan.action, "rewrite", directory);
            assert.equal(plan.cwd, null, directory);
            assert.equal(plan.rewritten, `cd ${directory} && pwd`, directory);
        }

        // Quoting does not help: `cd "-"` still means `$OLDPWD`, because `cd`
        // interprets the argument rather than the shell.
        const quoted = planNerf('cd "-" && timeout 300 pwd');
        assert.equal(quoted.action, "rewrite");
        assert.equal(quoted.cwd, null);
        assert.equal(quoted.rewritten, 'cd "-" && pwd');
    });

    void it("leaves a target that `timeout` could not have exec'd", () => {
        // These are builtins with no external counterpart, so the original
        // command fails with 127; rewriting it would report success instead.
        for (const builtin of [
            "cd /tmp",
            "export A=1",
            "source x.sh",
            "set -e",
        ]) {
            const plan = planNerf(`timeout 300 ${builtin}`);
            assert.equal(plan.action, "skip", builtin);
            assert.equal(plan.reason, "shell-builtin", builtin);
            assert.equal(plan.rewritten, `timeout 300 ${builtin}`, builtin);
        }
        // Builtins that DO have an external counterpart still rewrite, because
        // `timeout` runs them and the result matches.
        for (const external of ["pwd", "echo hi", "true"]) {
            assert.equal(planNerf(`timeout 300 ${external}`).action, "rewrite");
        }
    });

    void it("keeps the prologue when the caller forbids lifting", () => {
        // The hook forbids lifting when the directory is reachable only through
        // a symlink, because the tool's `cwd` would change the shell's logical
        // PWD. The timeout is still stripped, which is the main win.
        const plan = planNerf("cd /repo && timeout 300 pytest", {
            liftCwd: false,
        });
        assert.equal(plan.action, "rewrite");
        assert.equal(plan.cwd, null);
        assert.equal(plan.rewritten, "cd /repo && pytest");
    });

    void it("makes every documented skip reason reachable and preserves skipped commands", () => {
        const cases: Array<{ command: string; reason: NerfPlan["reason"] }> = [
            { command: "echo ready", reason: "no-invocation" },
            { command: "timeout maybe pytest", reason: "no-duration" },
            {
                command: "echo ready && timeout 300 pytest",
                reason: "not-leading",
            },
            { command: "timeout 300 pytest &", reason: "self-backgrounded" },
            {
                command: "timeout 300 curl https://example.invalid",
                reason: "network-client",
            },
            // GNU `timeout` with nothing to run exits 125, while an empty or
            // comment-only rewrite would exit 0 — a failure turned into a
            // success, so both forms must be left alone.
            { command: "timeout 300", reason: "no-command" },
            { command: "timeout 300 # nothing to run", reason: "no-command" },
            // A duration of 0 disables the shell's timeout rather than killing
            // at once, so the wrapper applies no bound to translate.
            { command: "timeout 0 pytest", reason: "no-bound" },
            // `timeout` cannot exec a builtin, so these exit 127 as written;
            // stripping the wrapper would turn that failure into a success.
            { command: "timeout 300 cd /tmp", reason: "shell-builtin" },
            { command: "timeout 300 export A=1", reason: "shell-builtin" },
            { command: "timeout 300 pytest", reason: "tool-timeout-set" },
            { command: "timeout 300 pytest", reason: "disabled" },
        ];

        for (const testCase of cases) {
            const options =
                testCase.reason === "tool-timeout-set"
                    ? { toolTimeoutSeconds: 30 }
                    : testCase.reason === "disabled"
                      ? { enabled: false }
                      : undefined;
            const plan = planNerf(testCase.command, options);
            assert.equal(plan.action, "skip", testCase.reason ?? "skip");
            assert.equal(plan.reason, testCase.reason);
            assert.equal(plan.rewritten, plan.original);
        }
    });
});

void describe("timeout-nerf agent messaging", () => {
    void it("explains the rewrite and succinctly names the safer alternatives", () => {
        const plan = planNerf("timeout 300 make test");
        assert.equal(plan.action, "rewrite");
        const note = nerfNote(plan);

        assert.match(note, /timeout 300/);
        assert.match(note, /make test/);
        assert.match(note, /240|budget|detach/i);
        assert.match(note, /timeout.{0,30}parameter|parameter.{0,30}timeout/i);
        assert.match(note, /bash_bg/);
        assert.match(note, /remindDelay/);
        assert.match(note, /jobs/);
        assert.ok(note.length < 900, `note was ${note.length} characters`);

        const guidelines = bashGuidelines();
        assert.ok(guidelines.length > 0);
        assert.ok(guidelines.every((guideline) => guideline.length > 0));
        assert.ok(guidelines.every((guideline) => guideline.length < 500));
    });

    void it("suggests a bash_bg call that preserves the original semantics", () => {
        // The suggested call must reproduce what the agent originally asked for.
        // `wrappedCommand` drops any `cd` prologue that was kept rather than
        // lifted, so suggesting it would run the job in the wrong directory.
        const cases = [
            "timeout 300 make",
            "cd /repo && timeout 300 pytest",
            "cd ~/x && timeout 300 make",
            "cd $HOME/x && timeout 300 make",
        ];

        for (const command of cases) {
            const plan = planNerf(command);
            assert.equal(plan.action, "rewrite", command);
            const suggested = /bash_bg\((\{.*?\})\)/s.exec(nerfNote(plan));
            assert.ok(suggested?.[1], `no bash_bg suggestion for ${command}`);
            const args = JSON.parse(suggested[1]) as {
                command: string;
                cwd?: string;
                timeout: number;
                remindDelay: string;
            };

            // The command plus any lifted cwd must equal the effective command.
            assert.equal(args.command, plan.rewritten, command);
            assert.equal(args.cwd, plan.cwd ?? undefined, command);

            // A wake-up must arrive before the kill deadline, or it is useless.
            const remind = Number.parseInt(args.remindDelay, 10);
            assert.ok(
                remind < args.timeout,
                `${command}: remindDelay ${args.remindDelay} >= timeout ${args.timeout}s`
            );
        }
    });
});

void describe("timeout-nerf alignment with upstream's timeout handling", () => {
    void it("refuses an unrecognised flag, which GNU timeout would reject", () => {
        // `timeout -x 300 make` exits 125 ("invalid option") without running the
        // command, so stripping the wrapper would convert a failure into a
        // success. Only the flags upstream's wrapper pattern accepts are allowed.
        const plan = planNerf("timeout -x 300 make");
        assert.equal(plan.action, "skip");
        assert.equal(plan.reason, "unknown-flag");
    });

    void it("accepts the flags whose values GNU's grammar can verify", () => {
        // A signal flag is accepted when its value is a name GNU resolves; a
        // number or an unknown name is refused (see the signal test).
        for (const flags of [
            "-v 300",
            "--verbose 300",
            "--foreground 300",
            "--preserve-status 300",
            "-k 5s 300",
            "-k5s 300",
            "--kill-after=5s 300",
            "--kill-after 5s 300",
            "-s KILL 300",
            "-sKILL 300",
            "--signal=KILL 300",
            "--signal KILL 300",
            "-s TERM 300",
            "--signal=SIGTERM 300",
            "-s RTMIN 300",
            "-- 300",
        ]) {
            const plan = planNerf(`timeout ${flags} make`);
            assert.equal(plan.action, "rewrite", flags);
            assert.equal(plan.rewritten, "make", flags);
        }
    });

    void it("records each flag with the value it owns", () => {
        assert.deepEqual(
            findTimeoutInvocation("timeout -v -k 5s 300 make")?.flags,
            [
                { name: "-v", value: null },
                { name: "-k", value: "5s" },
            ]
        );
        assert.deepEqual(
            findTimeoutInvocation("timeout --signal=KILL -k5s 300 make")?.flags,
            [
                { name: "--signal", value: "KILL" },
                { name: "-k", value: "5s" },
            ]
        );
        assert.deepEqual(findTimeoutInvocation("timeout 300 make")?.flags, []);
    });

    void it("refuses a kill-after value GNU would reject", () => {
        // `-k` takes a time interval, so `timeout -k foo 300 make` exits 125
        // ("invalid time interval") without running `make`; stripping the wrapper
        // would hide that failure. The bound's own parser validates it here.
        for (const command of [
            "timeout -k foo 300 make",
            "timeout -k 2h30m 300 make",
            "timeout --kill-after=foo 300 make",
            "timeout -k= 300 make",
        ]) {
            const plan = planNerf(command);
            assert.equal(plan.action, "skip", command);
            assert.equal(plan.reason, "unknown-flag", command);
        }
    });

    void it("refuses a duration GNU rejects even though the oracle accepts it", () => {
        // `parseDurationSeconds` lowercases the unit because it also mirrors the
        // habit-counting oracle; GNU does not. `timeout 5S true` exits 125
        // ("invalid time interval '5S'") without running `true`, so stripping
        // that wrapper would turn a command that never ran into one that runs.
        for (const duration of ["5S", "5M", "5H", "5D", "2H", "1H"]) {
            const plan = planNerf(`timeout ${duration} make`);
            assert.equal(plan.action, "skip", duration);
            assert.equal(plan.reason, "non-gnu-duration", duration);
        }
        // `-k` takes the same grammar, so its value is checked by the same rule.
        for (const flag of ["-k 5S 300", "--kill-after=5S 300"]) {
            const plan = planNerf(`timeout ${flag} make`);
            assert.equal(plan.action, "skip", flag);
            assert.equal(plan.reason, "unknown-flag", flag);
        }
        // The forms GNU accepts still rewrite. `+5s`, `.5s`, `5.` and `1e3` are
        // also GNU-valid but are not recognised by the shared parser at all, so
        // they are skipped earlier as `no-duration` -- a missed rewrite, never a
        // wrong one.
        for (const duration of ["300", "1.5h", "05s", "5m", "90s"]) {
            const plan = planNerf(`timeout ${duration} make`);
            assert.equal(plan.action, "rewrite", duration);
        }
        for (const duration of ["+5s", ".5s", "5.", "1e3"]) {
            assert.equal(
                planNerf(`timeout ${duration} make`).reason,
                "no-duration"
            );
        }
    });

    void it("refuses a signal value it cannot resolve", () => {
        // GNU's acceptance of a `-s` NUMBER is not reproducible: `-s 65` and
        // `-s 100` exit 125, but `-s 128`, `-s 256` and `-s 300` are accepted
        // (the number wraps to a byte before the range check), so no numeric
        // bound is right and every number is refused. An unknown name exits 125
        // too, and an RT offset's bound is the libc's (`RTMIN+30` accepted,
        // `RTMIN+31` rejected), so offsets are refused as well.
        for (const signal of [
            "9",
            "0",
            "65",
            "999",
            "FOO",
            "SIGFOO",
            "RTMINX",
            "RTMIN+3",
            "SIGRTMAX-1",
        ]) {
            for (const form of [
                `-s ${signal} 300 make`,
                `-s${signal} 300 make`,
                `--signal=${signal} 300 make`,
                `--signal ${signal} 300 make`,
            ]) {
                const plan = planNerf(`timeout ${form}`);
                assert.equal(plan.action, "skip", form);
                assert.equal(plan.reason, "signal-value", form);
            }
        }
        // An empty value is refused too. The `-s` forms above cannot express it:
        // `-s` takes the next token as its value, which shifts the duration and
        // fails recognition instead.
        assert.equal(
            planNerf("timeout --signal= 300 make").reason,
            "signal-value"
        );
        // A name GNU resolves is accepted in every spelling and case, which is
        // what keeps the corpus's `--signal=TERM` invocations rewritable.
        for (const signal of [
            "TERM",
            "KILL",
            "SIGKILL",
            "kill",
            "INT",
            "SIGTERM",
            "RTMIN",
            "SIGRTMAX",
        ]) {
            for (const form of [
                `-s ${signal} 300 make`,
                `-s${signal} 300 make`,
                `--signal=${signal} 300 make`,
                `--signal ${signal} 300 make`,
            ]) {
                const plan = planNerf(`timeout ${form}`);
                assert.equal(plan.action, "rewrite", form);
                assert.equal(plan.rewritten, "make", form);
            }
        }
    });

    void it("refuses a prefix that spans a line break", () => {
        // A newline is a command separator in bash, so a flag or duration on the
        // next line belongs to a different command. Upstream guards the same
        // boundary by matching `[ \t]+` rather than `\s+`.
        const plan = planNerf("timeout\n300 make");
        assert.equal(plan.action, "skip");
        assert.equal(plan.reason, "line-break");
    });

    void it("refuses when the wrapped command starts on a later line", () => {
        // `timeout 300` with no operand exits 125, so the original run failed
        // before `make` ran; stripping the wrapper would hide that failure.
        const plan = planNerf("timeout 300\nmake");
        assert.equal(plan.action, "skip");
        assert.equal(plan.reason, "not-a-command");
    });

    void it("refuses a tail with no command after the prefix", () => {
        // Each of these leaves no command to strip the wrapper from. Measured,
        // original vs the rewrite the extension used to produce:
        //   `timeout 300 | cat`    exit 0   -> `| cat`    exit 2 (syntax error)
        //   `timeout 300 > f`      exit 125 -> `> f`      exit 0, creates f
        //   `timeout 300 2>&1`     exit 125 -> `2>&1`     exit 0
        //   `timeout 300 && make`  exit 125 -> `&& make`  exit 2
        for (const tail of [
            "&& make",
            "|| make",
            "| cat",
            "> f",
            ">> f",
            "< in",
            "2>&1",
            "2>&1 make",
            "& sleep 1",
            ";\nmake",
        ]) {
            const plan = planNerf(`timeout 300 ${tail}`);
            assert.equal(plan.action, "skip", tail);
            assert.equal(plan.reason, "not-a-command", tail);
        }
    });

    void it("still rewrites a tail that starts a command, digit-led included", () => {
        // A leading digit is only a redirection when a separator follows it, so
        // `7z` and `2to3` are commands. `3>&1 make` does have a command, but
        // telling that from `2>&1` needs a shell grammar, and refusing only
        // costs a missed rewrite.
        for (const [command, expected] of [
            ["timeout 300 make -j4", "make -j4"],
            ["timeout 300 7z x a.7z", "7z x a.7z"],
            ["timeout 300 2to3 -w x.py", "2to3 -w x.py"],
        ]) {
            const plan = planNerf(command);
            assert.equal(plan.action, "rewrite", command);
            assert.equal(plan.rewritten, expected, command);
        }
        assert.equal(planNerf("timeout 300 3>&1 make").reason, "not-a-command");
    });

    void it("still rewrites a backslash continuation, which is not a separator", () => {
        const plan = planNerf("timeout 300 \\\n  make");
        assert.equal(plan.action, "rewrite");
        assert.equal(plan.rewritten, "\\\n  make");
    });

    void it("still rewrites a multi-line command whose timeout is on one line", () => {
        const plan = planNerf("cd /tmp &&\n  timeout 300 make");
        assert.equal(plan.action, "rewrite");
        assert.equal(plan.rewritten, "make");
        assert.equal(plan.cwd, "/tmp");
    });
});

void describe("timeout-nerf soft toggle", () => {
    function fakePi() {
        const handlers = new Map<string, unknown[]>();
        const appended: Array<{ customType: string; data: unknown }> = [];
        const pi = {
            on(event: string, handler: unknown) {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
            appendEntry(customType: string, data: unknown) {
                appended.push({ customType, data });
            },
            registerToolPromptGuidelines() {},
        } as unknown as ExtensionAPI;
        return { pi, handlers, appended };
    }

    function toolCallHandler(handlers: Map<string, unknown[]>) {
        return handlers.get("tool_call")?.[0] as
            | ((event: ToolCallEvent) => unknown)
            | undefined;
    }

    function bashCall(command: string): ToolCallEvent {
        // The declared return type supplies the contextual type, so no
        // assertion is needed here.
        return {
            type: "tool_call",
            toolCallId: "call-toggle",
            toolName: "bash",
            input: { command },
        };
    }

    void it("does not rewrite when tau has the feature switched off", async () => {
        const { pi, handlers, appended } = fakePi();
        // tau passes its state, so `/tau set timeout-nerf off` lands in a layer
        // the resolver reads before falling back to its default.
        registerTimeoutNerf(pi, {
            globalFeatures: { "timeout-nerf": false },
        } as unknown as TauState);
        const handler = toolCallHandler(handlers);
        assert.ok(handler);

        const event = bashCall("timeout 300 make");
        await handler(event);
        assert.equal(
            (event.input as { command?: string }).command,
            "timeout 300 make"
        );
        assert.equal(appended.length, 0);
    });

    void it("rewrites when the feature is on, and with no state at all", async () => {
        for (const state of [
            { globalFeatures: { "timeout-nerf": true } } as unknown as TauState,
            undefined,
        ]) {
            const { pi, handlers } = fakePi();
            registerTimeoutNerf(pi, state);
            const handler = toolCallHandler(handlers);
            assert.ok(handler);

            const event = bashCall("timeout 300 make");
            await handler(event);
            assert.equal((event.input as { command?: string }).command, "make");
        }
    });

    void it("reads the toggle per call, so a mid-session flip takes effect", async () => {
        // tau mutates its state object in place, so the handler has to consult
        // the current value rather than one captured when it was registered.
        // Hoisting `isFeatureEnabled` to a `const` at registration time survives
        // every other test in this file, so this one pins that property.
        const state = {
            globalFeatures: { "timeout-nerf": true },
        } as unknown as TauState;
        const { pi, handlers, appended } = fakePi();
        registerTimeoutNerf(pi, state);
        const handler = toolCallHandler(handlers);
        assert.ok(handler);

        const first = bashCall("timeout 300 make");
        await handler(first);
        assert.equal((first.input as { command?: string }).command, "make");

        (state as { globalFeatures: Record<string, boolean> }).globalFeatures[
            "timeout-nerf"
        ] = false;

        const second = bashCall("timeout 300 make");
        await handler(second);
        assert.equal(
            (second.input as { command?: string }).command,
            "timeout 300 make"
        );
        assert.equal(appended.length, 1);
    });
});

void describe("timeout-nerf extension wiring", () => {
    void it("mutates bash input in place, annotates its result, and clears pending rewrites", async (t) => {
        const handlers = new Map<string, unknown[]>();
        const appendedEntries: Array<{ customType: string; data: unknown }> =
            [];
        const fakePi = {
            on(event: string, handler: unknown) {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            },
            appendEntry(customType: string, data: unknown) {
                appendedEntries.push({ customType, data });
            },
            registerToolPromptGuidelines() {},
        } as unknown as ExtensionAPI;

        registerTimeoutNerf(fakePi);
        const toolCallHandler = handlers.get("tool_call")?.[0] as
            | ((event: ToolCallEvent, ctx: ExtensionContext) => unknown)
            | undefined;
        const toolResultHandler = handlers.get("tool_result")?.[0] as
            | ((event: ToolResultEvent, ctx: ExtensionContext) => unknown)
            | undefined;
        const shutdownHandler = handlers.get("session_shutdown")?.[0] as
            | (() => unknown)
            | undefined;
        assert.ok(toolCallHandler);
        assert.ok(toolResultHandler);
        assert.ok(shutdownHandler);

        const context = {} as ExtensionContext;
        // A real directory: the hook refuses to lift one it cannot resolve,
        // because a directory that does not exist cannot be entered.
        const realDir = mkdtempSync(join(tmpdir(), "nerf-wiring-"));
        t.after(() => rmSync(realDir, { recursive: true, force: true }));
        const event = {
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: `cd ${realDir} && timeout 300 pytest` },
        } as ToolCallEvent;
        const originalInput = event.input;
        await toolCallHandler(event, context);

        assert.equal(event.input, originalInput);
        const mutatedInput = event.input as {
            command?: unknown;
            cwd?: unknown;
        };
        assert.equal(mutatedInput.command, "pytest");
        assert.equal(mutatedInput.cwd, realDir);
        assert.equal(appendedEntries.length, 1);
        assert.equal(appendedEntries[0]?.customType, "timeout-nerf");

        const originalContent = [{ type: "text", text: "test output" }];
        const resultEvent = {
            type: "tool_result",
            toolCallId: "call-1",
            toolName: "bash",
            input: event.input,
            content: originalContent,
            isError: false,
            details: undefined,
        } as ToolResultEvent;
        const annotated = (await toolResultHandler(resultEvent, context)) as
            | { content?: Array<{ type: string; text?: string }> }
            | undefined;
        assert.ok(annotated);
        assert.ok(annotated.content);
        assert.match(annotated.content[0]?.text ?? "", /timeout 300/);
        assert.deepEqual(annotated.content.slice(1), originalContent);

        const repeated = await toolResultHandler(resultEvent, context);
        assert.equal(repeated, undefined);

        const pendingEvent = {
            type: "tool_call",
            toolCallId: "call-after-shutdown",
            toolName: "bash",
            input: { command: "timeout 300 make" },
        } as ToolCallEvent;
        await toolCallHandler(pendingEvent, context);
        shutdownHandler();
        const afterShutdown = await toolResultHandler(
            {
                ...resultEvent,
                toolCallId: "call-after-shutdown",
                input: pendingEvent.input,
            },
            context
        );
        assert.equal(afterShutdown, undefined);
    });

    void it("states the removed bound in the unit the agent actually used", () => {
        // The token is recorded as typed, so appending "s" used to claim
        // "1.5hs". The parsed seconds are added because a fractional or
        // unit-suffixed token alone hides the bound the agent actually set.
        const fractional = planNerf("timeout 1.5h make");
        assert.equal(fractional.invocation?.seconds, 5400);
        const fractionalNote = nerfNote(fractional);
        assert.match(fractionalNote, /1\.5h \(5400s\)/);
        assert.ok(!/1\.5hs/.test(fractionalNote), fractionalNote);

        // A plain seconds token stays unadorned.
        assert.match(nerfNote(planNerf("timeout 300 make")), /kill at 300s/);
        assert.match(nerfNote(planNerf("timeout 90s make")), /kill at 90s/);
    });

    void it("bounds the prose preview without truncating the pasteable call", () => {
        const command = `timeout 300 ${"x".repeat(400)}`;
        const plan = planNerf(command);
        assert.equal(plan.action, "rewrite");
        const note = nerfNote(plan);

        const previewMatch = /Effective command: ("[^"]*")/.exec(note);
        assert.ok(previewMatch?.[1], note);
        const shown = JSON.parse(previewMatch[1]) as string;
        assert.ok(shown.endsWith("…"), "a shortened preview must say so");
        assert.ok(shown.length < plan.rewritten.length);

        // The pasteable call must still carry the whole command, or the agent
        // would paste a truncated command into bash_bg.
        const suggested = /bash_bg\((\{.*?\})\)/s.exec(note);
        const args = JSON.parse(suggested?.[1] ?? "{}") as {
            command?: string;
        };
        assert.equal(args.command, plan.rewritten);
    });

    void it("drops the pending note and counts a reused toolCallId", async () => {
        // A duplicate id cannot be attributed to either call, so the entry is
        // dropped: a missing note is recoverable, but a note describing the
        // OTHER call's command and bound is actively misleading. The host
        // generates unique ids, so the branch is counted rather than silent.
        const handlers = new Map<string, unknown[]>();
        const appendedEntries: Array<{ customType: string }> = [];
        const fakePi = {
            on(event: string, handler: unknown) {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            },
            appendEntry(customType: string) {
                appendedEntries.push({ customType });
            },
            registerToolPromptGuidelines() {},
        } as unknown as ExtensionAPI;
        registerTimeoutNerf(fakePi);
        const toolCallHandler = handlers.get("tool_call")?.[0] as (
            event: ToolCallEvent,
            ctx: ExtensionContext
        ) => unknown;
        const toolResultHandler = handlers.get("tool_result")?.[0] as (
            event: ToolResultEvent,
            ctx: ExtensionContext
        ) => unknown;

        for (const command of [
            "timeout 10 first-command",
            "timeout 20 second-command",
        ]) {
            await toolCallHandler(
                {
                    type: "tool_call",
                    toolCallId: "duplicate",
                    toolName: "bash",
                    input: { command },
                },
                {} as ExtensionContext
            );
        }

        const annotated = (await toolResultHandler(
            {
                type: "tool_result",
                toolCallId: "duplicate",
                toolName: "bash",
                input: { command: "first-command" },
                content: [{ type: "text", text: "out" }],
                isError: false,
                details: undefined,
            },
            {} as ExtensionContext
        )) as { content?: Array<{ text?: string }> } | undefined;

        assert.equal(annotated, undefined);
        const countOf = (customType: string) =>
            appendedEntries.filter((entry) => entry.customType === customType)
                .length;
        assert.equal(countOf("timeout-nerf"), 2);
        assert.equal(countOf("timeout-nerf-collision"), 1);
    });

    void it("refuses to lift a `cd` that a symlink would make logical", async (t) => {
        // The tool sets the process working directory, so the shell reports the
        // PHYSICAL path, while `cd` sets the LOGICAL one. `cd <symlink> && pwd`
        // and `pwd` with `cwd: <symlink>` therefore disagree, so the `cd` must
        // stay in the command.
        const handlers = new Map<string, unknown[]>();
        const fakePi = {
            on(event: string, handler: unknown) {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            },
            appendEntry() {},
            registerToolPromptGuidelines() {},
        } as unknown as ExtensionAPI;
        registerTimeoutNerf(fakePi);
        const toolCallHandler = handlers.get("tool_call")?.[0] as (
            event: ToolCallEvent,
            ctx: ExtensionContext
        ) => unknown;

        const real = mkdtempSync(join(tmpdir(), "nerf-real-"));
        t.after(() => rmSync(real, { recursive: true, force: true }));
        const nested = join(real, "nested");
        mkdirSync(nested);
        const link = join(real, "link");
        symlinkSync(nested, link);

        const linked = {
            type: "tool_call",
            toolCallId: "call-symlink",
            toolName: "bash",
            input: { command: `cd ${link} && timeout 300 pwd` },
        } as ToolCallEvent;
        await toolCallHandler(linked, {} as ExtensionContext);
        const linkedInput = linked.input as { command?: string; cwd?: string };
        assert.equal(linkedInput.cwd, undefined);
        assert.equal(linkedInput.command, `cd ${link} && pwd`);

        // A path with no symlink still lifts.
        const plain = {
            type: "tool_call",
            toolCallId: "call-plain",
            toolName: "bash",
            input: { command: `cd ${nested} && timeout 300 pwd` },
        } as ToolCallEvent;
        await toolCallHandler(plain, {} as ExtensionContext);
        const plainInput = plain.input as { command?: string; cwd?: string };
        assert.equal(plainInput.cwd, nested);
        assert.equal(plainInput.command, "pwd");
    });

    void it("leaves non-bash calls untouched", async () => {
        const handlers = new Map<string, unknown[]>();
        const fakePi = {
            on(event: string, handler: unknown) {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            },
            appendEntry() {},
            registerToolPromptGuidelines() {},
        } as unknown as ExtensionAPI;
        registerTimeoutNerf(fakePi);

        const toolCallHandler = handlers.get("tool_call")?.[0] as
            | ((event: ToolCallEvent, ctx: ExtensionContext) => unknown)
            | undefined;
        assert.ok(toolCallHandler);
        const event = {
            type: "tool_call",
            toolCallId: "read-1",
            toolName: "read",
            input: { command: "timeout 300 make" },
        } as unknown as ToolCallEvent;
        const originalInput = event.input;
        await toolCallHandler(event, {} as ExtensionContext);
        assert.equal(event.input, originalInput);
        const untouchedInput = event.input as { command?: unknown };
        assert.equal(untouchedInput.command, "timeout 300 make");
    });

    void it("contributes standing bash guidance when the host supports it", () => {
        const calls: Array<{ tool: string; guidelines: string[] }> = [];
        const fakePi = {
            on() {},
            appendEntry() {},
            registerToolPromptGuidelines(tool: string, guidelines: string[]) {
                calls.push({ tool, guidelines });
            },
        } as unknown as ExtensionAPI;

        registerTimeoutNerf(fakePi);

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.tool, "bash");
        assert.deepEqual(calls[0]?.guidelines, bashGuidelines());
        assert.ok((calls[0]?.guidelines.length ?? 0) > 0);
    });

    void it("exports a default factory so pi can load it as an extension", async () => {
        // pi rejects an extension module that has no default export with
        // "Extension does not export a valid factory function". Named exports
        // alone are not enough, and no test that imports `registerTimeoutNerf`
        // directly would ever notice.
        const module = await import("../features/timeout-nerf/index.ts");
        assert.equal(typeof module.default, "function");

        const handlers = new Map<string, unknown[]>();
        const fakePi = {
            on(event: string, handler: unknown) {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            },
            appendEntry() {},
        } as unknown as ExtensionAPI;
        module.default(fakePi);
        assert.ok(handlers.get("tool_call"));
    });

    void it("stays loadable when the host lacks the prompt-guidelines API", async () => {
        // pi 0.74.0 — the pinned dev type baseline — has no
        // `registerToolPromptGuidelines`; the 0.84.x runtime does. The call is
        // feature-detected so an older host stays loadable instead of throwing
        // during registration, which would take the whole extension down.
        const handlers = new Map<string, unknown[]>();
        const fakePi = {
            on(event: string, handler: unknown) {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            },
            appendEntry() {},
            // deliberately no registerToolPromptGuidelines
        } as unknown as ExtensionAPI;

        assert.doesNotThrow(() => registerTimeoutNerf(fakePi));

        const toolCallHandler = handlers.get("tool_call")?.[0] as
            | ((event: ToolCallEvent, ctx: ExtensionContext) => unknown)
            | undefined;
        assert.ok(toolCallHandler);
        const event = {
            type: "tool_call",
            toolCallId: "call-no-guidelines",
            toolName: "bash",
            input: { command: "timeout 300 make" },
        } as ToolCallEvent;
        await toolCallHandler(event, {} as ExtensionContext);
        assert.equal((event.input as { command?: unknown }).command, "make");
    });
});

/**
 * Semantic equivalence, checked against a real shell.
 *
 * Every rule above is a promise that the command the agent wrote and the
 * command that actually runs mean the same thing. Unit tests assert the plan;
 * these run BOTH commands in bash and compare stdout and exit status, which is
 * the only way to catch a rewrite that is subtly wrong rather than merely
 * unexpected. `/bin/pwd` is used wherever the working directory has to be
 * observable, because `timeout` execs it while the shell would use its own
 * builtin, and those two disagree about logical versus physical paths.
 */
void describe("timeout-nerf shell equivalence", () => {
    /** Run a command through the registered tool_call handler, as pi would. */
    async function effective(command: string): Promise<{
        command: string;
        cwd: string | null;
    }> {
        const handlers = new Map<string, unknown[]>();
        const fakePi = {
            on(event: string, handler: unknown) {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
            appendEntry() {},
            registerToolPromptGuidelines() {},
        } as unknown as ExtensionAPI;
        registerTimeoutNerf(fakePi);
        const handler = handlers.get("tool_call")?.[0] as (
            event: ToolCallEvent,
            ctx: ExtensionContext
        ) => unknown;
        const event = {
            type: "tool_call",
            toolCallId: "equivalence",
            toolName: "bash",
            input: { command },
        } as ToolCallEvent;
        await handler(event, {} as ExtensionContext);
        const input = event.input as { command?: string; cwd?: string };
        return { command: input.command ?? command, cwd: input.cwd ?? null };
    }

    function runShell(command: string): { code: number; output: string } {
        try {
            // `pipefail`, so a pipeline reports its failing member rather than
            // the last command: without it `timeout 300 | /bin/cat` reports 0
            // and the oracle assertion below would pass vacuously.
            const stdout = execFileSync(
                "bash",
                ["-o", "pipefail", "-c", command],
                {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                }
            );
            return { code: 0, output: stdout.trim() };
        } catch (error) {
            const failure = error as {
                status?: number;
                stdout?: string;
                stderr?: string;
            };
            return {
                code: failure.status ?? -1,
                output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim(),
            };
        }
    }

    void it("runs every rewritten command with the original's behavior", async (t) => {
        const tmp = mkdtempSync(join(tmpdir(), "nerf-equiv-"));
        t.after(() => rmSync(tmp, { recursive: true, force: true }));
        const nested = join(tmp, "nested");
        mkdirSync(nested);
        const link = join(tmp, "link");
        symlinkSync(nested, link);

        // [command, setup that makes its cwd-dependence observable]
        const cases: Array<[string, string]> = [
            ["timeout 300 /bin/pwd", ""],
            ["cd /tmp && timeout 300 /bin/pwd", ""],
            ["cd - && timeout 300 /bin/pwd", "cd /tmp; cd /usr; "],
            ["cd /definitely-missing-x; timeout 300 /bin/pwd", ""],
            [`cd ${link} && timeout 300 /bin/pwd`, ""],
            [`cd ${nested} && timeout 300 /bin/pwd`, ""],
            ["timeout 1.5h true", ""],
            ["timeout 300", ""],
            ["timeout 300 # no command", ""],
            ["timeout 2h30m true", ""],
            ["timeout 0 true", ""],
            ["timeout 300 cd /tmp", ""],
        ];

        for (const [command, setup] of cases) {
            const plan = await effective(command);
            const asWritten = runShell(setup + command);
            const asRun = runShell(
                setup +
                    (plan.cwd
                        ? `cd ${plan.cwd} && ${plan.command}`
                        : plan.command)
            );
            assert.deepEqual(
                asRun,
                asWritten,
                `${command} became ${plan.command} (cwd ${plan.cwd})`
            );
        }
    });

    void it("refuses a short option's `=`, and a head that cannot name a program", () => {
        // GNU getopt hands a SHORT option the whole remainder, so `-s=TERM` is
        // the value `=TERM` and GNU exits 125 ("invalid signal"); splitting on
        // `=` would rewrite a command that never ran. A long option does take
        // `=`, and an attached short value does not use one.
        for (const command of [
            "timeout -s=TERM 300 make",
            "timeout -k=5s 300 make",
            "timeout -s= 300 make",
        ]) {
            const plan = planNerf(command);
            assert.equal(plan.action, "skip", command);
            assert.equal(plan.reason, "unknown-flag", command);
        }
        for (const command of [
            "timeout --signal=TERM 300 make",
            "timeout --kill-after=5s 300 make",
            "timeout -sTERM 300 make",
            "timeout -k5s 300 make",
        ]) {
            assert.equal(planNerf(command).action, "rewrite", command);
        }
        // A construct opener is bash syntax rather than a program: `timeout`
        // execs its argument, so these exit 127 as written while the same text
        // alone runs. A quoted or expanded head may expand to nothing, which
        // makes the original a commandless wrapper (exit 125) and the rewrite an
        // empty command (exit 0). Refusing costs a rewrite and cannot produce a
        // wrong one.
        for (const command of [
            "timeout 300 { make; }",
            "timeout 300 [[ 1 ]]",
            "timeout 300 ! make",
            "timeout 300 (make)",
            "timeout 300 ${CMD}",
            "timeout 300 $CMD > /dev/null",
            "timeout 300 $CMD 2>&1",
            "timeout 300 $(which make)",
            // A quote INSIDE an expansion does not save it: the whole expansion
            // disappears, quotes included, so the original is still a
            // commandless wrapper while the rewrite is empty.
            'timeout 300 ${CMD:+"x"}',
            'timeout 300 $(echo"")',
            "timeout 300 `echo`",
            "timeout 300 $@",
            // A standby word that can itself vanish leaves the rewrite empty.
            "timeout 300 $CMD $CMD2",
        ]) {
            const plan = planNerf(command);
            assert.equal(plan.action, "skip", command);
            assert.equal(plan.reason, "not-a-command", command);
        }
        // A quote OUTSIDE an expansion leaves an empty argument behind, which
        // fails identically in both forms, so those heads are kept.
        for (const command of [
            "timeout 300 '' make",
            'timeout 300 "" make',
            "timeout 300 $V/ruff check",
            "timeout 300 'quoted' make",
        ]) {
            assert.equal(planNerf(command).action, "rewrite", command);
        }
        // A builtin with no external counterpart goes to the builtin guard, not
        // to this one.
        for (const command of [
            "timeout 300 command make",
            "timeout 300 time make",
            // `:` is the no-op builtin (`: > file` is the usual idiom) and has
            // no external counterpart, so `timeout 300 :` is 127 as written and
            // 0 rewritten. `break`, `continue` and `coproc` are reserved words
            // rather than programs.
            "timeout 300 : make",
            "timeout 300 break",
            "timeout 300 continue",
            "timeout 300 coproc make",
        ]) {
            const plan = planNerf(command);
            assert.equal(plan.action, "skip", command);
            assert.equal(plan.reason, "shell-builtin", command);
        }
        // Plain heads still rewrite, including the shapes the guard could be
        // tempted to over-refuse: a head with a trailing separator, a quoted
        // expansion and an expansion with literal text all leave an argument
        // behind when the value is empty, so the two forms fail identically.
        for (const command of [
            "timeout 300 make",
            "timeout 300 ./build.sh -j4",
            "timeout 300 /usr/bin/make",
            "timeout 300 [ -f /etc/hostname ]",
            "timeout 300 make -j4",
            "timeout 300 true; echo hi",
            'timeout 300 "$CMD"',
            "timeout 300 $CMD/x",
            "timeout 300 $CMD make",
            "timeout 300 $PY script.py",
        ]) {
            assert.equal(planNerf(command).action, "rewrite", command);
        }
    });

    void it("never rewrites a prefix GNU itself would have rejected", () => {
        // The rewrite claims that stripping the wrapper is equivalent, and for
        // the wrapper to have run the command at all GNU has to accept the
        // prefix. Checking the decision against GNU rather than against the same
        // model the implementation uses is what catches a guard that is too
        // narrow: `timeout 5S true` and `timeout -s 65 300 true` were both
        // rewritten while GNU exited 125 without running the command.
        for (const command of [
            // GNU rejects the prefix, so none of these may be rewritten.
            "timeout 5S true",
            "timeout 5M true",
            "timeout -k 5S 300 true",
            "timeout -k foo 300 true",
            "timeout -s 65 300 true",
            "timeout -s 999 300 true",
            "timeout -s FOO 300 true",
            "timeout -s=TERM 300 true",
            "timeout -k=5s 300 true",
            "timeout -x 300 true",
            "timeout 300 && true",
            "timeout 300 | /bin/cat",
            "timeout 300 > /dev/null",
            "timeout 300 2>&1",
            "timeout 300\ntrue",
            "timeout 300 (true)",
            "timeout 300 { true; }",
            "timeout 300 [[ 1 ]]",
            "timeout 300 ${CMD}",
            "timeout 300 command true",
        ]) {
            const plan = planNerf(command);
            if (plan.action !== "rewrite") continue;
            assert.equal(
                runShell(command).code,
                0,
                `${command}: rewritten although GNU did not accept the prefix`
            );
        }
        // GNU accepts these prefixes, so they must still rewrite. The assertion
        // is on the action itself: a guard that simply refused more would pass
        // the loop above, and an entry that stops rewriting would otherwise be
        // silently skipped (which is how the duration-exponent branch went
        // unpinned).
        for (const command of [
            "timeout 300 true",
            "timeout 1.5h true",
            "timeout -k 5s 300 true",
            "timeout -k 1e3 300 true",
            "timeout -k +5s 300 true",
            "timeout -v 300 true",
            "timeout -- 300 true",
            "timeout -s TERM 300 true",
            "timeout --signal=SIGTERM 300 true",
        ]) {
            assert.equal(planNerf(command).action, "rewrite", command);
            assert.equal(
                runShell(command).code,
                0,
                `${command}: GNU does not accept this prefix, so it does not belong here`
            );
        }
        // The guard refuses some forms GNU accepts, deliberately, and those are
        // the one direction this test cannot check. An RT offset's bound is the
        // libc's (`RTMIN+30` is accepted here, `RTMIN+31` is not) and a `-s`
        // NUMBER is accepted by GNU in bands that no bound can express, so both
        // are left alone rather than guessed at. The reason is asserted so a
        // future guard cannot silently start rewriting them.
        for (const command of [
            "timeout -s RTMIN+3 300 true",
            "timeout -s 9 300 true",
            "timeout -s 15 300 true",
        ]) {
            const plan = planNerf(command);
            assert.equal(plan.action, "skip", command);
            assert.equal(plan.reason, "signal-value", command);
        }
        for (const command of [
            "timeout 300 true",
            "timeout 1.5h true",
            "timeout -k 5s 300 true",
            "timeout -v 300 true",
            "timeout -- 300 true",
            "timeout -s TERM 300 true",
            "timeout --signal=SIGTERM 300 true",
        ]) {
            assert.equal(planNerf(command).action, "rewrite", command);
        }
    });
});
