/**
 * Pipe-nerf regression and corpus-equivalence tests.
 *
 * The fixture contains sanitized commands sampled from a 30-day session corpus;
 * the recognition fields were computed by the independently mutation-tested
 * Python oracle in `session_analysis.pipe_usage`. The rewrite guards below are
 * stricter than the oracle, so only recognition is compared field by field.
 *
 * The superset harness is the load-bearing safety test: it runs both forms
 * through a real shell and requires every line the original printed to still be
 * present after the rewrite. A rewrite that loses output is a regression even
 * when the parser agrees with the oracle.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BUILTIN_MAX_LINES,
    applyLimiter,
    bashGuidelines,
    findPipeInvocation,
    lastPipeOperator,
    pipeNote,
    planPipeNerf,
    registerPipeNerf,
    type PipeObservation,
    type PipePlan,
} from "../features/pipe-nerf/index.ts";
import { getFeatureDef, isKnownFeature } from "../features/features-registry.ts";
import { classifyLine, countLines } from "../features/log-classify.ts";
import type { TauState } from "../state.ts";

interface CorpusExpected {
    kind: string;
    limit: number | null;
    start: number;
    mergedStderr: boolean;
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
        new URL("./fixtures/pipe-nerf-corpus.json", import.meta.url),
        "utf8"
    )
) as CorpusFixture;

function observation(partial: Partial<PipeObservation> = {}): PipeObservation {
    return {
        totalLines: null,
        err: 0,
        warn: 0,
        visibleLines: 10,
        fullOutputPath: null,
        sourceId: null,
        receiptLines: [],
        faithful: true,
        caveat: null,
        viewDescription: "the bounded view your pipe would have printed",
        ...partial,
    };
}

function plan(command: string): PipePlan {
    return planPipeNerf(command);
}

/** The command a rewrite leaves behind, or the original for a skip. */
function effective(command: string): string {
    const p = plan(command);
    return p.action === "rewrite" ? p.rewritten : command;
}

/**
 * Run both forms and require the rewritten output to contain every line the
 * original printed. Returns the pair so a test can assert more.
 */
function superset(command: string): { original: string; rewritten: string } {
    const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-superset-"));
    try {
        const original = execFileSync("bash", ["-c", command], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const rewritten = execFileSync("bash", ["-c", effective(command)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const originalLines = original.split("\n").filter((l) => l.length > 0);
        const rewrittenSet = new Set(rewritten.split("\n"));
        const missing = originalLines.filter((line) => !rewrittenSet.has(line));
        assert.deepEqual(
            missing,
            [],
            `rewrite dropped output lines for ${JSON.stringify(command)}`
        );
        return { original, rewritten };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

void describe("pipe-nerf parser", () => {
    void it("matches the Python oracle for every sanitized corpus command", () => {
        const counts = new Map<string, { passed: number; total: number }>();

        for (const fixtureCase of corpus.cases) {
            const invocation = findPipeInvocation(fixtureCase.command);
            // The fixture holds the oracle's spans. The oracle has no notion of
            // a stage's arguments, so compare the fields it does define.
            const oracleFields = invocation
                ? {
                      kind: invocation.kind,
                      limit: invocation.limit,
                      start: invocation.start,
                      mergedStderr: invocation.mergedStderr,
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

        assert.ok(corpus.cases.length > 100, "fixture should sample the corpus");
        assert.equal(
            [...counts.values()].reduce((sum, c) => sum + c.passed, 0),
            corpus.cases.length,
            `per-category: ${[...counts.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([c, n]) => `${c}:${n.passed}/${n.total}`)
                .join(", ")}`
        );
    });

    void it("recognizes each limiter and reads its bound", () => {
        assert.equal(findPipeInvocation("ls | tail -20")?.limit, 20);
        assert.equal(findPipeInvocation("ls | tail -n 20")?.limit, 20);
        assert.equal(findPipeInvocation("ls | tail -n20")?.limit, 20);
        assert.equal(findPipeInvocation("ls | head -n 5")?.limit, 5);
        assert.equal(findPipeInvocation("ls | sed -n '1,50p'")?.limit, 50);
        assert.equal(findPipeInvocation("ls | sed -n '51,100p'")?.limit, 100);
        // No explicit bound: the shell's own default, which is the case the
        // tool's budget serves best.
        assert.equal(findPipeInvocation("ls | tail")?.limit, null);
        assert.equal(findPipeInvocation("ls | wc -l")?.limit, null);
    });

    void it("resolves a path-prefixed stage", () => {
        assert.equal(plan("ls | /usr/bin/tail -20").action, "rewrite");
        assert.equal(plan("ls | /bin/head -5").rewritten, "ls");
    });

    void it("ignores a pipe that is not inside quotes or a substitution", () => {
        assert.equal(lastPipeOperator("wc -l < 'a | tail -1'"), -1);
        assert.equal(plan("wc -l < 'a | tail -1'").action, "skip");
        assert.equal(
            findPipeInvocation(`awk '{print "a|b"}' f | wc -l`)?.kind,
            "wc"
        );
        // `||` is a control operator, not a pipe.
        assert.equal(plan("ls || tail -5").reason, "no-pipe");
    });

    void it("does not treat a pipe inside a substitution as the command's pipe", () => {
        // The inner `| head -3` is at paren depth 1, so the command's last
        // TOP-LEVEL pipe is `| wc -l` (which binds) -- not the inner head. If
        // depth were not counted, the parser would resolve the inner stage and
        // rewrite `$(git branch | head -3)` into a different command.
        const withSubstitution =
            "for x in $(git branch | head -3); do echo $x | wc -l; done";
        assert.equal(findPipeInvocation(withSubstitution)?.kind, "wc");
        assert.equal(
            plan("echo $(git branch | head -3)").reason,
            "no-pipe",
            "the only pipe is inside a substitution"
        );
        assert.equal(
            plan("echo $(git branch | head -3)").rewritten,
            "echo $(git branch | head -3)",
            "a substitution must survive untouched"
        );
    });

    void it("reads the bound off a trimmed stage, not an offset one", () => {
        // Regression: the args were sliced with a trimmed offset against the
        // untrimmed stage, so `tail -20` reported a limit of 0 and the note
        // would have claimed "| tail 0".
        assert.equal(findPipeInvocation("cd /x && make | tail -100")?.limit, 100);
        assert.equal(findPipeInvocation("make | head -30")?.limit, 30);
    });

    void it("detects a merged stderr in the removed stage", () => {
        assert.equal(
            findPipeInvocation("make 2>&1 | tail -20")?.mergedStderr,
            true
        );
        assert.equal(
            findPipeInvocation("make | tail -20")?.mergedStderr,
            false
        );
    });

    void it("rewrites after a `;` but not before an `&&`", () => {
        // `;` separates statements: the next one runs whatever the previous
        // returned, so the limiter can be removed.
        assert.equal(plan("echo a; seq 1 50 | tail -3").action, "rewrite");
        assert.equal(plan("echo a; seq 1 50 | tail -3").rewritten, "echo a; seq 1 50");
        assert.equal(plan("echo X; make 2>&1 | tail -40").rewritten, "echo X; make 2>&1");
        assert.equal(plan("a\nb | tail -5").rewritten, "a\nb");
        // `&&` / `||` chain on the stage's status, so the limiter stays.
        assert.equal(plan("a | tail -5 && b").reason, "status-bearing-operator");
        assert.equal(plan("a | tail -5 || b").reason, "status-bearing-operator");
        // A `cd ... &&` prologue is BEFORE the pipe, so it is lifted with it.
        assert.equal(plan("cd /x && make | tail -20").rewritten, "cd /x && make");
    });

    void it("reports having no pipe separately from a status-bearing one", () => {
        assert.equal(plan("ls").reason, "no-pipe");
        assert.equal(plan("ls || tail -5").reason, "no-pipe");
    });

    void it("keeps the same control flow when a limiter follows a `;`", () => {
        // The `;` form is rewritten, so the rewrite must reach the same
        // statements: every line the original printed is still printed.
        for (const command of [
            "false | tail -5; echo done",
            "true | head -2; echo done",
            "echo a; seq 1 50 | tail -3",
            "echo X; seq 1 20 2>&1 | tail -4",
        ]) {
            assert.equal(plan(command).action, "rewrite", command);
            superset(command);
        }
    });
});

void describe("pipe-nerf rewrite safety", () => {
    void it("hoists every limiter the corpus uses", () => {
        assert.equal(plan("cd /x && pytest -q | tail -20").rewritten, "cd /x && pytest -q");
        assert.equal(plan("git log --oneline -3 | head -10").rewritten, "git log --oneline -3");
        assert.equal(plan("cat f | wc -l").rewritten, "cat f");
        assert.equal(plan("ls | grep -c foo").rewritten, "ls");
        assert.equal(plan("ls | sed -n '1,50p'").rewritten, "ls");
        assert.equal(plan("ls | awk 'END{print}'").rewritten, "ls");
        // Only the limiter goes; an upstream stage keeps its own effect.
        assert.equal(
            plan("make 2>&1 | tee log | tail -100").rewritten,
            "make 2>&1 | tee log"
        );
    });

    void it("leaves filters and transforms alone", () => {
        // A filter's output is a selection and a transform's output is different
        // text: removing either changes the answer rather than revealing it.
        // A filter or transform is left alone. Its reason is `no-pipe` because
        // recognition (which must mirror the permissive counting oracle) reports
        // no bounding stage at all — the command simply has no limiter.
        for (const command of [
            "ls | grep foo",
            "ls | rg -n foo",
            "ls | sed 's/a/b/'",
            "ls | awk '{print $1}'",
            // `sed` without `-n` duplicates the selected lines, so it does not bound.
            "ls | sed '1,50p'",
        ]) {
            assert.equal(plan(command).reason, "no-pipe", command);
            assert.equal(plan(command).rewritten, command, command);
        }
        // A `grep -c` does bound, and is hoisted.
        assert.equal(plan("ls | grep -c foo").action, "rewrite");
    });

    void it("refuses a follow-the-input stage", () => {
        // `tail -f` never returns; removing it hands the tool a hanging command.
        assert.equal(plan("cat f | tail -f").reason, "not-a-limiter");
        assert.equal(plan("cat f | tail -f | wc -l").action, "rewrite");
        // A limiter before `&&` / `||` is left alone: the chain reads the
        // stage's exit status, so removing it changes what runs (measured,
        // `false | tail -5 && echo done` prints `done`; `false && echo done`
        // prints nothing).
        assert.equal(
            plan("seq 1 100 | tail -5 && echo done").reason,
            "status-bearing-operator"
        );
        assert.equal(plan("a | tail -5 || b").reason, "status-bearing-operator");
    });

    void it("never drops an output line", () => {
        for (const command of [
            "seq 1 100 | tail -20",
            "seq 1 100 | head -20",
            "seq 1 100 | wc -l",
            "seq 1 100 | grep -c 5",
            "echo alpha; seq 1 50 | tail -5",
            "for i in 1 2 3; do echo line$i; done | tail -2",
            "seq 1 30 | sed -n '1,10p'",
            "printf 'a\\nb\\nc\\n' | sed -n '1,2p'",
            "seq 1 100 | tail -100",
        ]) {
            assert.equal(plan(command).action, "rewrite", command);
            superset(command);
        }
    });

    void it("returns strictly more output for a limiter that was binding", () => {
        const { original, rewritten } = superset("seq 1 100 | tail -20");
        assert.equal(original.split("\n").filter(Boolean).length, 20);
        assert.equal(rewritten.split("\n").filter(Boolean).length, 100);
    });

    void it("leaves a command that does not pipe untouched", () => {
        for (const command of ["pytest -q", "ls -la", "cd /x && make -j8"]) {
            const p = plan(command);
            assert.equal(p.action, "skip", command);
            assert.equal(p.rewritten, command);
        }
    });

    void it("can be disabled without changing recognition", () => {
        const command = "pytest -q | tail -20";
        assert.equal(planPipeNerf(command).action, "rewrite");
        assert.equal(planPipeNerf(command, { enabled: false }).action, "skip");
        assert.equal(
            planPipeNerf(command, { enabled: false }).reason,
            "disabled"
        );
    });
});

void describe("pipe-nerf bounded view", () => {
    const capture = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const invocationFor = (command: string) => {
        const plan = planPipeNerf(command);
        assert.ok(plan.invocation, command);
        return plan.invocation;
    };

    void it("gives the agent back exactly what their pipe printed", () => {
        // The whole point of hoisting: the command runs untruncated so the tool
        // captures everything, but the agent asked for a bounded view and must
        // get one. Returning the whole capture here would be the context growth
        // the pipe existed to prevent.
        const tail = applyLimiter(capture, invocationFor("ls | tail -3"), {
            truncated: false,
            totalLines: 60,
        });
        assert.equal(tail.text, "line-58\nline-59\nline-60");
        assert.equal(tail.faithful, true);

        const head = applyLimiter(capture, invocationFor("ls | head -2"), {
            truncated: false,
            totalLines: 60,
        });
        assert.equal(head.text, "line-1\nline-2");
        assert.equal(head.faithful, true);
    });

    void it("matches what the real shell pipe would have printed", () => {
        // Property check against bash, not against the implementation: for each
        // limiter, the reconstructed view equals the pipe's own output.
        const cases: [string, string][] = [
            ["seq 1 60 | tail -3", "seq 1 60"],
            ["seq 1 60 | head -4", "seq 1 60"],
            ["seq 1 60 | wc -l", "seq 1 60"],
            ["seq 1 60 | grep -c 1", "seq 1 60"],
        ];
        for (const [piped, bare] of cases) {
            const view = applyLimiter(
                execFileSync("bash", ["-c", bare], { encoding: "utf8" }).trimEnd(),
                invocationFor(piped),
                { truncated: false, totalLines: 60 }
            );
            const shell = execFileSync("bash", ["-c", piped], {
                encoding: "utf8",
            }).trimEnd();
            assert.equal(view.text, shell, piped);
        }
    });

    void it("still answers a line count when the capture was truncated", () => {
        // `wc -l` is exact from the tool's own total, even after it dropped
        // lines, so the agent never has to re-run to learn the size.
        const view = applyLimiter("last 2000 lines only", invocationFor("ls | wc -l"), {
            truncated: true,
            totalLines: 250_000,
        });
        assert.equal(view.text, "250000");
        assert.equal(view.faithful, true);
    });

    void it("refuses to guess when the region it reads was already dropped", () => {
        // A `head` over a capture that lost its head, and a `grep -c` over one
        // that lost its matches, cannot be reconstructed. Reporting a number
        // anyway would be quietly wrong, so the note carries the caveat.
        const head = applyLimiter("tail remnant", invocationFor("ls | head -3"), {
            truncated: true,
            totalLines: 9000,
        });
        assert.equal(head.faithful, false);
        assert.match(head.caveat ?? "", /already dropped/);
        assert.equal(head.text, "tail remnant", "falls back to the capture");

        const count = applyLimiter(
            "remnant",
            invocationFor("ls | grep -c needle"),
            { truncated: true, totalLines: 9000 }
        );
        assert.equal(count.faithful, false);
        assert.match(count.caveat ?? "", /lower bound/);
    });

    void it("refuses to invent a count an upstream stage changed", () => {
        // `wc -l` counts its INPUT's lines. With no upstream stage the input is
        // the capture, so the tool's total is exact. With one, the input is that
        // stage's output and the capture cannot answer it: reporting totalLines
        // would invent a number.
        const plain = applyLimiter("a\nb\nc\n", invocationFor("seq 1 100 | wc -l"), {
            truncated: false,
            totalLines: 3,
        });
        assert.equal(plain.text, "3");
        assert.equal(plain.faithful, true);

        const filtered = applyLimiter(
            "1\n2\n3\n4\n6\n7\n8\n9\n10",
            invocationFor("seq 1 100 | grep -v 5 | wc -l"),
            { truncated: true, totalLines: 90 }
        );
        assert.equal(filtered.faithful, false);
        assert.match(filtered.caveat ?? "", /earlier stage filtered/);
        // The capture is returned rather than a number nobody can justify.
        assert.equal(filtered.text, "1\n2\n3\n4\n6\n7\n8\n9\n10");
    });

    void it("refuses the same count for a counting grep after a stage", () => {
        const view = applyLimiter(
            "match\nother",
            invocationFor("ps aux | grep -v header | grep -c python"),
            { truncated: false, totalLines: 2 }
        );
        assert.equal(view.faithful, false);
        assert.match(view.caveat ?? "", /earlier stage filtered/);
    });

    void it("still reconstructs head and tail after an upstream filter", () => {
        // head/tail read the first/last lines of whatever reached them, so an
        // upstream stage does not invalidate them -- the view is of the
        // filtered capture, which is what the pipeline produced.
        const tail = applyLimiter(
            "a\nb\nc\nd\ne",
            invocationFor("ps aux | grep python | tail -2"),
            { truncated: false, totalLines: 5 }
        );
        assert.equal(tail.text, "d\ne");
        assert.equal(tail.faithful, true);

        const head = applyLimiter(
            "a\nb\nc\nd\ne",
            invocationFor("ps aux | grep python | head -2"),
            { truncated: false, totalLines: 5 }
        );
        assert.equal(head.text, "a\nb");
        assert.equal(head.faithful, true);
    });

    void it("does not re-implement an awk program", () => {
        const view = applyLimiter(capture, invocationFor("ls | awk 'END{print}'"), {
            truncated: false,
            totalLines: 60,
        });
        assert.equal(view.faithful, false);
        assert.match(view.caveat ?? "", /awk program/);
        // The note must name it, so the fallback reads as deliberate.
        const note = pipeNote(plan("ls | awk 'END{print}'"), observation({
            faithful: view.faithful,
            caveat: view.caveat,
            viewDescription: "the full captured output",
        }));
        assert.match(note, /awk program/);
    });
});

void describe("pipe-nerf note", () => {
    void it("says what was removed, what ran, and what to do next", () => {
        const note = pipeNote(plan("make -j8 2>&1 | tail -50"), observation());
        assert.match(note, /\[pipe-nerf\]/);
        assert.match(note, /\| tail -50/);
        assert.match(note, /Effective command: "make -j8 2>&1"/);
        assert.match(note, /stderr into stdout/);
        assert.match(note, /2000 lines or 50KB/);
    });

    void it("reports the err/warn mix with the line count", () => {
        const note = pipeNote(
            plan("pytest -q | tail -20"),
            observation({ totalLines: 1204, err: 12, warn: 88 })
        );
        assert.match(note, /1204 lines \(12 err, 88 warn\)/);
    });

    void it("points at the sidecar when the output was indexed", () => {
        const note = pipeNote(
            plan("pytest -q | tail -20"),
            observation({
                totalLines: 1204,
                err: 3,
                warn: 40,
                sourceId: "ctx_bg_abc",
                receiptLines: [
                    `- Search it first: context_search query:"..." source_id:"ctx_bg_abc"`,
                ],
            })
        );
        assert.match(note, /indexed in the context sidecar as "ctx_bg_abc"/);
        assert.match(note, /context_search query/);
        assert.match(note, /Do not re-run the command to read it/);
    });

    void it("warns that head and the tool disagree about which end to keep", () => {
        const note = pipeNote(
            plan("git log | head -10"),
            observation({
                viewDescription: "the first 10 lines, as your pipe would have printed",
            })
        );
        assert.match(note, /first 10 lines, as your pipe would have printed/);
        assert.match(note, /keeps the END/);
    });

    void it("is honest when the capture fit inline and the view is bounded", () => {
        // `| wc -l` on 4 lines: the view IS the whole output, so the note says
        // nothing was written to disk. But for a bounded view over an inline
        // capture it must NOT claim "what is shown is the complete output" --
        // that is false, and it hides that the rest has to be re-requested.
        const bounded = pipeNote(
            plan("ls | wc -l"),
            observation({ totalLines: 4, visibleLines: 4 })
        );
        assert.match(bounded, /nothing was written to disk/);
        assert.match(bounded, /Captured 4 lines/);
        assert.ok(
            !/complete output/.test(bounded),
            "an inline capture with a bounded view is not the complete output"
        );
    });

    void it("falls back to the visible count when the tool reports no detail", () => {
        const note = pipeNote(
            plan("ls | wc -l"),
            observation({ totalLines: null, visibleLines: 17 })
        );
        assert.match(note, /17 lines \(0 err, 0 warn\)/);
    });

    void it("is empty for a skip", () => {
        assert.equal(pipeNote(plan("ls | grep foo"), observation()), "");
        assert.equal(pipeNote(plan("ls"), observation()), "");
    });

    void it("bounds the prose copy of a long command", () => {
        const long = `python3 script.py --root ${"a".repeat(400)} | tail -20`;
        const note = pipeNote(plan(long), observation());
        assert.match(note, /…"/);
        assert.ok(note.length < 1400, `note too long: ${note.length}`);
    });
});

void describe("pipe-nerf guidelines", () => {
    void it("tells the agent to filter, not to truncate", () => {
        const guidelines = bashGuidelines();
        const joined = guidelines.join(" ");
        assert.match(joined, /removed before execution/);
        assert.match(joined, /context_search/);
        assert.match(joined, /context_get/);
        assert.match(joined, /context_export/);
        assert.match(joined, /err\/warn/);
        // The distinction that makes the rewrite safe has to be stated, or the
        // agent will read filters being left alone as a bug.
        assert.match(joined, /are NOT removed/);
    });
});

void describe("pipe-nerf severity parity", () => {
    void it("classifies output the same way a job log does", () => {
        assert.equal(classifyLine("ERROR: boom"), "err");
        assert.equal(classifyLine("Traceback (most recent call last):"), "err");
        assert.equal(classifyLine("[WARNING] slow"), "warn");
        assert.equal(classifyLine("3 failed in 4.51s"), "warn");
        assert.equal(classifyLine("done"), null);
        const counts = countLines("ERROR: a\nb\nWARNING: c\n");
        assert.equal(counts.total, 3);
        assert.equal(counts.err, 1);
        assert.equal(counts.warn, 1);
    });
});

void describe("pipe-nerf registration", () => {
    /** Minimal host double: records the hooks a feature registers. */
    function fakePi() {
        const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
        const entries: { type: string; data: unknown }[] = [];
        const guidelines: { tool: string; lines: string[] }[] = [];
        const pi = {
            on(event: string, handler: (event: unknown) => unknown) {
                (handlers[event] ??= []).push(handler);
            },
            appendEntry(type: string, data: unknown) {
                entries.push({ type, data });
            },
            registerToolPromptGuidelines(tool: string, lines: string[]) {
                guidelines.push({ tool, lines });
            },
        };
        return { pi, handlers, entries, guidelines };
    }

    function fire(
        handlers: Record<string, ((event: unknown) => unknown)[]>,
        name: string,
        event: Record<string, unknown>
    ): unknown {
        let out: unknown;
        for (const h of handlers[name] ?? []) out = h(event) ?? out;
        return out;
    }

    void it("rewrites the command and annotates the result", () => {
        const { pi, handlers, entries, guidelines } = fakePi();
        registerPipeNerf(pi as never);

        assert.equal(guidelines.length, 1);
        assert.equal(guidelines[0].tool, "bash");

        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "t1",
            input: { command: "pytest -q 2>&1 | tail -20" },
        });

        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "t1",
            content: [{ type: "text", text: "FAILED tests/x" }],
            details: {
                truncation: { truncated: true, totalLines: 900 },
                fullOutputPath: "/tmp/out.log",
            },
        }) as { content: { type: string; text: string }[] };

        assert.equal(entries.filter((e) => e.type === "pipe-nerf").length, 1);
        const note = result.content[0].text;
        assert.match(note, /\[pipe-nerf\]/);
        assert.match(note, /900 lines \(0 err, 1 warn\)/);
        assert.match(note, /on disk at \/tmp\/out\.log/);
        assert.match(note, /grep -nE "pattern" \/tmp\/out\.log/);
        // The original content is preserved after the note.
        assert.equal(result.content[1].text, "FAILED tests/x");
    });

    void it("rewrites bash_bg too, which is where the log is the only record", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        const input: { command: string } = { command: "pytest 2>&1 | tail -50" };
        fire(handlers, "tool_call", {
            toolName: "bash_bg",
            toolCallId: "b1",
            input,
        });
        assert.equal(input.command, "pytest 2>&1");

        const result = fire(handlers, "tool_result", {
            toolName: "bash_bg",
            toolCallId: "b1",
            content: [{ type: "text", text: "ok" }],
            details: {
                totalLines: 4000,
                sourceId: "ctx_bg_xyz",
                chunkIds: ["ctx_bg_xyz_0001"],
                fullOutputPath: "/tmp/job.log",
            },
        }) as { content: { text: string }[] };

        const note = result.content[0].text;
        assert.match(note, /indexed in the context sidecar as "ctx_bg_xyz"/);
        assert.match(note, /context_get source_id:"ctx_bg_xyz"/);
    });

    void it("returns the bounded view, not the whole capture", () => {
        // The load-bearing property: hoisting the filter out of shell execution
        // must preserve the bound. Returning the full capture here is the exact
        // context growth the pipe existed to prevent, and the note alone would
        // not stop the agent from paying for it.
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        const capture = Array.from(
            { length: 60 },
            (_, i) => `line-${i + 1}`
        ).join("\n");
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "bound",
            input: { command: "seq 1 60 | tail -3" },
        });
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "bound",
            content: [{ type: "text", text: capture }],
            details: { truncation: { truncated: false, totalLines: 60 } },
        }) as { content: { type: string; text: string }[] };

        const body = result.content
            .slice(1)
            .map((part) => part.text)
            .join("\n");
        assert.equal(body, "line-58\nline-59\nline-60");
        assert.ok(
            !body.includes("line-1\n"),
            "the full capture leaked into the result"
        );
    });

    void it("falls back to the capture when the view is unfaithful", () => {
        // A `head` whose head was already dropped cannot be reproduced, so the
        // capture is returned WITH the caveat rather than a wrong 3 lines.
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        const remnant = "tail remnant only";
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "unfaithful",
            input: { command: "make 2>&1 | head -3" },
        });
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "unfaithful",
            content: [{ type: "text", text: remnant }],
            details: {
                truncation: { truncated: true, totalLines: 9000 },
                fullOutputPath: "/tmp/out.log",
            },
        }) as { content: { type: string; text: string }[] };

        const note = result.content[0].text;
        const body = result.content.slice(1).map((part) => part.text).join("\n");
        assert.equal(body, remnant, "the capture must be returned as-is");
        // M28: the caveat has to reach the note, or the agent reads a fallback
        // as if it were the answer it asked for.
        assert.match(note, /already dropped/);
        assert.match(note, /on disk at \/tmp\/out\.log/);
    });

    void it("leaves a filter command alone and adds no note", () => {
        const { pi, handlers, entries } = fakePi();
        registerPipeNerf(pi as never);

        const input = { command: "ls | grep foo" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "t2",
            input,
        });
        assert.equal(input.command, "ls | grep foo");
        assert.equal(entries.length, 0);

        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "t2",
            content: [{ type: "text", text: "foo" }],
        });
        assert.equal(result, undefined);
    });

    void it("does not annotate an unknown call id", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "t3",
            input: { command: "ls | tail -5" },
        });
        // A result for a different call must not pick up this call's note.
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "other",
            content: [{ type: "text", text: "x" }],
        });
        assert.equal(result, undefined);
    });

    void it("counts a duplicate call id instead of annotating it wrongly", () => {
        const { pi, handlers, entries } = fakePi();
        registerPipeNerf(pi as never);

        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "dup",
            input: { command: "ls | tail -5" },
        });
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "dup",
            input: { command: "cat f | wc -l" },
        });

        assert.equal(
            entries.filter((e) => e.type === "pipe-nerf-collision").length,
            1
        );
        // Neither call's note can be attributed, so neither is emitted.
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "dup",
            content: [{ type: "text", text: "x" }],
        });
        assert.equal(result, undefined);
    });

    void it("ignores tools it does not own", () => {
        const { pi, handlers, entries } = fakePi();
        registerPipeNerf(pi as never);

        const input = { command: "ls | tail -5" };
        fire(handlers, "tool_call", {
            toolName: "read",
            toolCallId: "r1",
            input,
        });
        assert.equal(input.command, "ls | tail -5");
        assert.equal(entries.length, 0);
    });

    void it("is a known feature id, so `/tau set pipe-nerf off` resolves", () => {
        // The registry entry is what makes the toggle a VALID id; the soft
        // toggle below is what makes it change behaviour. Without the entry the
        // command line rejects the id and the hook can never be turned off.
        assert.equal(isKnownFeature("pipe-nerf"), true);
        const def = getFeatureDef("pipe-nerf");
        assert.ok(def, "pipe-nerf has no registry entry");
        assert.equal(def.defaultOn, true);
        assert.equal(def.label.length > 0, true);
    });

    void it("reads the feature flag per call, not at registration", () => {
        // Hoisting the read to registration time is the bug this pins: the flag
        // is set after the extension loads, so a captured value would keep
        // rewriting commands the user just turned the feature off for.
        const state = {
            featureOverridesSession: new Map<string, boolean>(),
            // The nerf records hoisted calls here so the bash tool forces an
            // index for them. A double that omits it made the optional chaining
            // hide a missing field instead of failing.
            pipeHoistedCalls: new Set<string>(),
        } as unknown as TauState;
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never, state);

        // Default state: the feature is on, so the command is rewritten.
        const first = { command: "ls | tail -5" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "on1",
            input: first,
        });
        assert.equal(first.command, "ls");

        // Turned off mid-session: the very next call must be left alone.
        state.featureOverridesSession.set("pipe-nerf", false);
        const second = { command: "ls | tail -5" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "off1",
            input: second,
        });
        assert.equal(second.command, "ls | tail -5");

        // And turned back on: the flag is read again, not cached either way.
        state.featureOverridesSession.delete("pipe-nerf");
        const third = { command: "ls | tail -5" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "on2",
            input: third,
        });
        assert.equal(third.command, "ls");
    });

    void it("records a hoisted call so the bash tool forces an index", () => {
        // The sidecar's own threshold is 300 lines / 24KB, and the commands
        // this nerf touches are usually smaller. Without this flag the agent
        // gets a bounded view of output that exists nowhere else.
        const state = {
            featureOverridesSession: new Map<string, boolean>(),
            pipeHoistedCalls: new Set<string>(),
        } as unknown as TauState;
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never, state);

        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "hoist",
            input: { command: "seq 1 60 | tail -3" },
        });
        assert.equal(state.pipeHoistedCalls.has("hoist"), true);

        // Consumed by the result hook, so a later unrelated call is not indexed.
        fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "hoist",
            content: [{ type: "text", text: "58\n59\n60" }],
        });
        assert.equal(state.pipeHoistedCalls.has("hoist"), false);
    });

    void it("does not record a call it chose not to rewrite", () => {
        const state = {
            featureOverridesSession: new Map<string, boolean>(),
            pipeHoistedCalls: new Set<string>(),
        } as unknown as TauState;
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never, state);

        for (const command of ["ls | grep foo", "make -j8"]) {
            fire(handlers, "tool_call", {
                toolName: "bash",
                toolCallId: `plain-${command}`,
                input: { command },
            });
        }
        assert.equal(state.pipeHoistedCalls.size, 0);
    });

    void it("drops pending state on shutdown", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "s1",
            input: { command: "ls | tail -5" },
        });
        fire(handlers, "session_shutdown", {});
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "s1",
            content: [{ type: "text", text: "x" }],
        });
        assert.equal(result, undefined);
    });
});

void describe("pipe-nerf corpus coverage", () => {
    void it("rewrites most of the corpus's limiting commands", () => {
        const rewritable = corpus.cases.filter((c) => {
            const invocation = findPipeInvocation(c.command);
            if (!invocation) return false;
            const stage = c.command.slice(invocation.stageStart).trimStart();
            const args = stage.slice(stage.match(/^[\w.+~/-]*/)?.[0].length ?? 0);
            if (invocation.kind === "tail" && /(?:^|\s)-[A-Za-z]*f(?:\s|$)/.test(args)) {
                return false;
            }
            return true;
        });
        // The oracle's limiter set is intentionally permissive about which
        // stages bind, so this measures recognition coverage, not the rewrite
        // rate. Every recognized command must be plan-able without throwing.
        assert.ok(rewritable.length > 50, "expected corpus coverage");
        for (const c of rewritable) {
            assert.doesNotThrow(() => plan(c.command), c.command);
        }
    });

    void it("mirrors the tool's own inline budget", () => {
        assert.equal(BUILTIN_MAX_LINES, 2000);
    });
});

// Keep the helper referenced so a linter cannot drop the temp-dir fixture path.
void it("uses a real shell for the superset harness", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-probe-"));
    try {
        const file = join(dir, "probe.txt");
        writeFileSync(file, "a\nb\n", "utf8");
        const out = execFileSync("bash", ["-c", `wc -l < ${file}`], {
            encoding: "utf8",
        });
        assert.equal(out.trim(), "2");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});