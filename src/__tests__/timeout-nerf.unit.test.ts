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
            assert.deepEqual(
                result,
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
        });
        assert.deepEqual(findTimeoutInvocation("/usr/bin/timeout 300 x"), {
            token: "300",
            seconds: 300,
            start: 0,
            end: "/usr/bin/timeout 300".length,
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
            const stdout = execFileSync("bash", ["-c", command], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
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
});
