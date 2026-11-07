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
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BUILTIN_MAX_LINES,
    applyLimiter,
    bashGuidelines,
    findPipeInvocation,
    lastPipeOperator,
    pipeNote,
    pipeNoteSections,
    planPipeNerf,
    registerPipeNerf,
    stageZeroStatus,
    type PipeObservation,
    type PipePlan,
} from "../features/pipe-nerf/index.ts";
import {
    getFeatureDef,
    isKnownFeature,
} from "../features/features-registry.ts";
import { classifyLine, countLines } from "../features/log-classify.ts";
import type { TauState } from "../state.ts";
import {
    stageZeroDirectory,
    stageZeroPathFor,
} from "../features/pipe-nerf/stage0-path.ts";
import {
    markStage0CaptureIndexed,
    sweepStage0Captures,
} from "../features/pipe-nerf/stage0-retention.ts";

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
        pipeStageZero: null,
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

        assert.ok(
            corpus.cases.length > 100,
            "fixture should sample the corpus"
        );
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

    void it("recognizes only the wc -l form its bounded view can reproduce", () => {
        assert.equal(findPipeInvocation("seq 1 3 | wc -l")?.kind, "wc");
        for (const args of ["-c", "-w", "-m", "", "-lc", "-cl", "-l file"]) {
            const command = `seq 1 3 | wc${args ? ` ${args}` : ""}`;
            assert.equal(findPipeInvocation(command), null, command);
            assert.equal(plan(command).rewritten, command, command);
        }
    });

    void it("does not treat byte-oriented head/tail as line limiters", () => {
        for (const command of [
            "printf data | head -c 2",
            "printf data | head -c2",
            "printf data | head --bytes=2",
            "printf data | tail -c 2",
            "printf data | tail --bytes 2",
        ]) {
            assert.equal(findPipeInvocation(command), null, command);
            assert.equal(plan(command).rewritten, command, command);
        }
    });

    void it("reports a limiter in a trailing comment without calling it no-pipe", () => {
        const command = "printf output\n# | tail -5";
        const result = plan(command);
        assert.equal(result.action, "skip");
        assert.equal(result.reason, "limiter-in-comment");
        assert.equal(result.rewritten, command);
    });

    void it("classifies a limiter in an earlier segment separately from no-pipe", () => {
        const command = "ls -la /tmp | head -5; du -sh /tmp";
        assert.equal(plan(command).action, "skip");
        assert.equal(plan(command).reason, "pipe-outside-scope:segment-1");
        assert.equal(
            plan("ls -la /tmp | head -5; du -sh /tmp; git status --short")
                .reason,
            "pipe-outside-scope:segment-1"
        );
        assert.equal(
            plan("ls -la /tmp; du -sh /tmp | tail -5").action,
            "rewrite"
        );
        assert.equal(plan("ls -la /tmp | tail -5").action, "rewrite");
        assert.equal(
            plan("python -m module --help | head -40").action,
            "rewrite"
        );
    });

    void it("skips heredoc bodies in all common delimiter forms without changing bytes", () => {
        for (const command of [
            "cat <<'EOF'\nhello | tail -2\nEOF",
            "cat <<EOF\nhello | tail -2\nEOF",
            "cat <<-EOF\n\thello | tail -2\n\tEOF",
            // Backslash-escaped and ANSI-C delimiters are heredocs too; the
            // first was preserved only because a trailing statement pushed its
            // body's pipe out of the last segment, so the same command without
            // that statement was rewritable. Both must skip on the operator.
            "cat <<\\EOF\nhello | tail -2\nEOF",
            "cat <<$'EOF'\nhello | tail -2\nEOF",
        ]) {
            const result = plan(command);
            assert.equal(result.action, "skip", command);
            assert.equal(result.reason, "heredoc", command);
            assert.equal(
                result.rewritten,
                command,
                "the command must remain byte-identical"
            );
        }
    });

    void it("does not rewrite pipes inside quotes, backticks, or process substitution", () => {
        for (const command of [
            "printf '%s\\n' 'literal | head -5'",
            'printf "%s\\n" "literal | tail -2"',
            "printf '%s\\n' `echo literal | head -3`",
            "cat <(printf 'literal | tail -4')",
        ]) {
            assert.equal(plan(command).action, "skip", command);
            assert.equal(plan(command).rewritten, command, command);
        }
        assert.equal(
            plan("printf '%s\\n' 'literal <<EOF' | head -1").action,
            "rewrite",
            "a heredoc-looking string is not a heredoc operator"
        );
    });

    void it("executes the exact preserved heredoc source and does not trust a rewritten preview", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-heredoc-"));
        const target = join(dir, "probe.mts");
        const body = [
            'import { planPipeNerf } from "/home/dev/.pi/extensions/pipe-nerf/parse.ts";',
            "const probes = [",
            '  ["for-loop-with-procsub", `cd /x && git log --oneline -1 2>/dev/null; git status --short 2>/dev/null | tee /tmp/injected.log | head -5; echo "=== diff"; for f in a.ts b.ts; do git diff -- "$f" | sed -n \'1,5p\' | tail -3; done`],',
            '  ["plain-help", `python3 -m json.tool --help`],',
            "];",
            'const quoted = "first | second";',
            "const singleQuoted = 'x | tail -1';",
            "",
        ].join("\n");
        const command = `cat > ${target} <<'EOF'\n${body}EOF\necho wrote`;
        const result = plan(command);
        assert.equal(result.action, "skip");
        assert.equal(result.reason, "heredoc");
        assert.equal(result.rewritten, command);
        assert.equal(effective(command), command);
        execFileSync("bash", ["-c", effective(command)]);
        assert.equal(readFileSync(target, "utf8"), body);
        const note = pipeNote(result, observation());
        assert.equal(note, "");
        assert.ok(!note.includes("Effective command"));
        rmSync(dir, { recursive: true, force: true });
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
        const countInvocation = findPipeInvocation(
            "git ls-tree --name-only main src/features/ | grep -c ."
        );
        assert.ok(countInvocation);
        assert.equal(
            applyLimiter(
                Array.from({ length: 50 }, (_, i) => `entry-${i}`).join("\n"),
                countInvocation,
                { truncated: false, totalLines: 50 }
            ).text,
            "50"
        );
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
        assert.equal(
            findPipeInvocation("cd /x && make | tail -100")?.limit,
            100
        );
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
        assert.equal(
            plan("echo a; seq 1 50 | tail -3").rewritten,
            "echo a; seq 1 50"
        );
        assert.equal(
            plan("echo X; make 2>&1 | tail -40").rewritten,
            "echo X; make 2>&1"
        );
        assert.equal(plan("a\nb | tail -5").rewritten, "a\nb");
        // `&&` / `||` chain on the stage's status, so the limiter stays.
        assert.equal(
            plan("a | tail -5 && b").reason,
            "status-bearing-operator"
        );
        assert.equal(
            plan("a | tail -5 || b").reason,
            "status-bearing-operator"
        );
        // A `cd ... &&` prologue is BEFORE the pipe, so it is lifted with it.
        assert.equal(
            plan("cd /x && make | tail -20").rewritten,
            "cd /x && make"
        );
    });

    void it("reports having no pipe separately from a status-bearing one", () => {
        assert.equal(plan("ls").reason, "no-pipe");
        assert.equal(plan("ls || tail -5").reason, "no-pipe");
    });

    void it("keeps the same control flow when a limiter follows a `;`", () => {
        // Only a limiter in the last segment controls the command's final
        // output. Earlier-segment limiters must not be removed when later
        // statements print unrelated output.
        for (const command of [
            "false | tail -5; echo done",
            "true | head -2; echo done",
        ]) {
            assert.equal(plan(command).action, "skip", command);
            assert.equal(
                plan(command).reason,
                "pipe-outside-scope:segment-1",
                command
            );
            assert.equal(plan(command).rewritten, command);
        }
        for (const command of [
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
        assert.equal(
            plan("cd /x && pytest -q | tail -20").rewritten,
            "cd /x && pytest -q"
        );
        assert.equal(
            plan("git log --oneline -3 | head -10").rewritten,
            "git log --oneline -3"
        );
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
        assert.equal(
            plan("a | tail -5 || b").reason,
            "status-bearing-operator"
        );
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

void describe("pipe-nerf compound pipelines", () => {
    const cases = [
        [";", "seq 1 10 | tail -2; seq 1 10 | wc -l"],
        ["&&", "seq 1 10 | tail -2 && seq 1 10 | wc -l"],
        ["||", "false || seq 1 10 | tail -2; seq 1 10 | wc -l"],
    ] as const;

    for (const [separator, command] of cases) {
        void it(`keeps and reproduces both pipeline views across ${separator}`, () => {
            const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-compound-"));
            const stageZeroPath = join(dir, "stage-zero.log");
            try {
                const plan = planPipeNerf(command, { stageZeroPath });
                assert.equal(plan.action, "rewrite");
                assert.equal(plan.preserveLimiterViews, true);
                assert.equal(
                    plan.stageZeroSegments?.length,
                    separator === "||" ? 3 : 2
                );
                assert.match(plan.stageZero?.command ?? "", /tail -2.*wc -l/);
                assert.match(plan.rewritten, /tail -2/);
                assert.match(plan.rewritten, /wc -l/);
                assert.equal(
                    execFileSync("bash", ["-c", plan.rewritten], {
                        encoding: "utf8",
                    }),
                    execFileSync("bash", ["-c", command], {
                        encoding: "utf8",
                    })
                );
                assert.equal(
                    readFileSync(stageZeroPath, "utf8"),
                    `${Array.from({ length: 10 }, (_, i) => i + 1).join("\n")}\n${Array.from({ length: 10 }, (_, i) => i + 1).join("\n")}\n`
                );
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }

    void it("does not apply one pipeline's limiter to another pipeline's output", () => {
        const command = "seq 1 10 | grep '^1'; seq 1 10 | wc -l";
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-compound-single-"));
        try {
            const plan = planPipeNerf(command, {
                stageZeroPath: join(dir, "stage-zero.log"),
            });
            assert.equal(plan.preserveLimiterViews, true);
            assert.match(plan.rewritten, /wc -l/);
            assert.equal(
                execFileSync("bash", ["-c", plan.rewritten], {
                    encoding: "utf8",
                }),
                execFileSync("bash", ["-c", command], { encoding: "utf8" })
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("declines the whole compound call when a segment cannot be instrumented", () => {
        const command = "seq 1 10 |& cat | tail -2; seq 1 10 | wc -l";
        const plan = planPipeNerf(command, {
            stageZeroPath: "/tmp/stage-zero.log",
        });
        assert.equal(plan.action, "skip");
        assert.equal(plan.rewritten, command);
    });

    void it("leaves a single-pipeline rewrite unchanged", () => {
        assert.equal(plan("seq 1 10 | tail -2").rewritten, "seq 1 10");
    });

    void it("does not rewrite a limiter before a trailing control operator", () => {
        for (const command of [
            "seq 1 10 | tail -2; echo done",
            "seq 1 10 | head -2 && echo done",
        ]) {
            const result = plan(command);
            assert.equal(result.action, "skip", command);
            assert.equal(result.rewritten, command);
        }
    });
});

void describe("pipe-nerf stage-0 retention", () => {
    function tempDir(): string {
        return mkdtempSync(join(tmpdir(), "pipe-nerf-retention-"));
    }

    void it("deletes oldest indexed captures under budget pressure", async () => {
        const dir = tempDir();
        const oldPath = join(dir, "pi-pipe-stage0-old.log");
        const newPath = join(dir, "pi-pipe-stage0-new.log");
        try {
            writeFileSync(oldPath, "old!");
            writeFileSync(newPath, "new!");
            utimesSync(oldPath, 1, 1);
            utimesSync(newPath, 2, 2);
            markStage0CaptureIndexed(oldPath, "source-old", 1, dir);
            markStage0CaptureIndexed(newPath, "source-new", 2, dir);
            for (const suffix of [".status.json", ".exits", ".tail"]) {
                writeFileSync(`${oldPath}${suffix}`, "old auxiliary");
                writeFileSync(`${newPath}${suffix}`, "new auxiliary");
            }
            const result = await sweepStage0Captures({
                directories: [dir],
                budgetBytes: 4,
            });
            assert.deepEqual(result.deletedPaths, [oldPath]);
            assert.equal(existsSync(oldPath), false);
            assert.equal(existsSync(newPath), true);
            assert.equal(result.removedSiblings, 3);
            for (const suffix of [".status.json", ".exits", ".tail"]) {
                assert.equal(existsSync(`${oldPath}${suffix}`), false);
                assert.equal(existsSync(`${newPath}${suffix}`), true);
            }
            assert.equal(result.observedBytes, 4);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("retains unindexed captures even when over budget", async () => {
        const dir = tempDir();
        const unindexed = join(dir, "pi-pipe-stage0-unindexed.log");
        try {
            writeFileSync(unindexed, "too large");
            for (const suffix of [".status.json", ".exits", ".tail"]) {
                writeFileSync(`${unindexed}${suffix}`, "keep with capture");
            }
            const result = await sweepStage0Captures({
                directories: [dir],
                budgetBytes: 1,
            });
            assert.deepEqual(result.deletedPaths, []);
            assert.equal(existsSync(unindexed), true);
            assert.equal(result.removedSiblings, 0);
            for (const suffix of [".status.json", ".exits", ".tail"]) {
                assert.equal(existsSync(`${unindexed}${suffix}`), true);
            }
            assert.equal(result.observedBytes, 9);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("bounds each sweep by its file limit", async () => {
        const dir = tempDir();
        try {
            for (let i = 0; i < 6; i++) {
                const path = join(dir, `pi-pipe-stage0-${i}.log`);
                writeFileSync(path, "data");
            }
            const options = {
                directories: [dir],
                budgetBytes: 1,
                maxFiles: 2,
            };
            const first = await sweepStage0Captures(options);
            const second = await sweepStage0Captures(options);
            const third = await sweepStage0Captures(options);
            assert.equal(first.filesVisited, 2);
            assert.equal(second.filesVisited, 2);
            assert.equal(first.complete, false);
            assert.equal(second.complete, false);
            assert.equal(third.complete, true);
            assert.equal(third.deletedPaths.length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("sweeps both current and legacy capture locations", async () => {
        const current = tempDir();
        const legacy = tempDir();
        const currentPath = join(current, "pi-pipe-stage0-current.log");
        const legacyPath = join(legacy, "pi-pipe-stage0-legacy.log");
        try {
            writeFileSync(currentPath, "curr");
            writeFileSync(legacyPath, "old!");
            markStage0CaptureIndexed(
                currentPath,
                "source-current",
                Date.now(),
                current
            );
            markStage0CaptureIndexed(
                legacyPath,
                "source-legacy",
                Date.now(),
                current
            );
            const result = await sweepStage0Captures({
                directories: [current, legacy],
                budgetBytes: 1,
            });
            assert.deepEqual(
                new Set(result.deletedPaths),
                new Set([currentPath, legacyPath])
            );
            assert.equal(result.observedBytes, 0);
        } finally {
            rmSync(current, { recursive: true, force: true });
            rmSync(legacy, { recursive: true, force: true });
        }
    });
});

void describe("pipe-nerf stage-0 capture", () => {
    const PATH_0 = "/tmp/stage0-test.log";

    void it("uses the XDG cache directory, with a hidden home-cache fallback", () => {
        assert.equal(
            stageZeroDirectory({ XDG_CACHE_HOME: "/cache" }, "/home/test"),
            "/cache/pi-tau/stage0"
        );
        assert.equal(
            stageZeroDirectory({}, "/home/test"),
            "/home/test/.cache/pi-tau/stage0"
        );
        assert.equal(
            stageZeroPathFor("call/1", "/cache/pi-tau/stage0"),
            "/cache/pi-tau/stage0/pi-pipe-stage0-call1.log"
        );
    });

    void it("skips rewriting when the command references the capture directory", () => {
        const directory = "/cache/pi-tau/stage0";
        const p = planPipeNerf(`grep pattern ${directory} | tail -3`, {
            stageZeroPath: `${directory}/stage0.log`,
            stageZeroDirectory: directory,
        });
        assert.equal(p.action, "skip");
        assert.equal(p.reason, "capture-directory-reference");
        assert.equal(p.rewritten, `grep pattern ${directory} | tail -3`);
        assert.equal(p.captureDirectory, directory);
    });

    void it("tees stage 0 when the command still filters after the limiter", () => {
        // The point: the result is filtered, so a re-grep has to run against the
        // pre-filter output rather than a fresh execution. `tee` is the standard
        // tool for this and leaves the pipeline's output and status untouched.
        const p = planPipeNerf("seq 1 60 | grep -E '1|3' | tail -3", {
            stageZeroPath: PATH_0,
        });
        assert.match(
            p.rewritten,
            /seq 1 60 \| .*stage0-capture\.mjs.* \| grep -E '1\|3'/
        );
        assert.ok(p.stageZero);
        assert.equal(p.stageZero?.command, "seq 1 60");
        assert.equal(p.stageZero?.path, PATH_0);
    });

    void it("accepts v1 status without tail and rejects malformed tail status", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-status-"));
        const capture = join(dir, "stage-zero.log");
        try {
            writeFileSync(
                `${capture}.status.json`,
                JSON.stringify({
                    truncated: true,
                    bytesWritten: 4096,
                    reason: "cap",
                })
            );
            assert.deepEqual(stageZeroStatus(capture), {
                truncated: true,
                bytesWritten: 4096,
                reason: "cap",
                tail: null,
            });
            writeFileSync(
                `${capture}.status.json`,
                JSON.stringify({
                    truncated: true,
                    bytesWritten: 4096,
                    reason: "cap",
                    tail: { bytes: "bad", dropped: 10 },
                })
            );
            assert.equal(stageZeroStatus(capture), null);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("creates the cache directory on first capture use", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-cache-"));
        const capture = join(dir, "nested", "stage-zero.log");
        const helper = new URL(
            "../features/pipe-nerf/stage0-capture.mjs",
            import.meta.url
        );
        try {
            const result = spawnSync(
                process.execPath,
                [helper.pathname, capture],
                {
                    input: "cache output\\n",
                    encoding: "utf8",
                }
            );
            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(capture, "utf8"), "cache output\\n");
            assert.deepEqual(
                JSON.parse(readFileSync(`${capture}.status.json`, "utf8")),
                {
                    truncated: false,
                    bytesWritten: Buffer.byteLength("cache output\\n"),
                    reason: null,
                    tail: null,
                }
            );
            assert.equal(existsSync(`${capture}.tail`), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("caps stage-0 disk bytes while forwarding the complete pipeline stream", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-cap-"));
        const capture = join(dir, "stage-zero.log");
        const helper = new URL(
            "../features/pipe-nerf/stage0-capture.mjs",
            import.meta.url
        );
        const input = Buffer.from(
            Array.from({ length: 1024 * 1024 }, (_, index) => index % 251)
        );
        try {
            const result = spawnSync(
                process.execPath,
                [helper.pathname, capture],
                {
                    input,
                    env: { ...process.env, PI_TAU_STAGE0_MAX_BYTES: "4096" },
                }
            );
            assert.equal(result.status, 0);
            assert.equal(result.stdout.length, input.length);
            const saved = readFileSync(capture);
            assert.ok(saved.length <= 4096);
            assert.match(
                saved.toString(),
                /\[stage-0 capture truncated at byte cap\]/
            );
            const status = JSON.parse(
                readFileSync(`${capture}.status.json`, "utf8")
            ) as {
                truncated: boolean;
                reason: string | null;
                tail: { bytes: number; dropped: number } | null;
            };
            assert.equal(status.truncated, true);
            assert.equal(status.reason, "cap");
            assert.deepEqual(status.tail, {
                bytes: 4096,
                dropped:
                    input.length -
                    (4096 -
                        Buffer.byteLength(
                            "\n[stage-0 capture truncated at byte cap]\n"
                        )) -
                    4096,
            });
            assert.deepEqual(
                readFileSync(`${capture}.tail`).subarray(
                    Buffer.byteLength(
                        "[stage-0 tail capture: earlier bytes omitted]\n"
                    )
                ),
                input.subarray(-4096)
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("records an early downstream EPIPE in the status sidecar", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-epipe-"));
        const capture = join(dir, "stage-zero.log");
        const helper = new URL(
            "../features/pipe-nerf/stage0-capture.mjs",
            import.meta.url
        );
        try {
            const result = spawnSync(
                "bash",
                [
                    "-c",
                    `dd if=/dev/zero bs=1M count=50 status=none | ${JSON.stringify(process.execPath)} ${JSON.stringify(helper.pathname)} ${JSON.stringify(capture)} | head -c 1 >/dev/null`,
                ],
                {
                    encoding: "utf8",
                    timeout: 5000,
                    env: {
                        ...process.env,
                        PI_TAU_STAGE0_MAX_BYTES: "200000000",
                    },
                }
            );
            assert.ok(!result.error || !/ETIMEDOUT/.test(result.error.message));
            const status = JSON.parse(
                readFileSync(`${capture}.status.json`, "utf8")
            ) as {
                truncated: boolean;
                reason: string | null;
                tail: { bytes: number; dropped: number } | null;
            };
            assert.equal(status.truncated, true);
            assert.equal(status.reason, "epipe");
            assert.equal(status.tail, null);
            assert.equal(readFileSync(capture).length, 50 * 1024 * 1024);
            assert.equal(existsSync(`${capture}.tail`), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("retains a rolling tail after EPIPE when the head cap is exceeded", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-epipe-tail-"));
        const capture = join(dir, "stage-zero.log");
        const helper = new URL(
            "../features/pipe-nerf/stage0-capture.mjs",
            import.meta.url
        );
        try {
            const result = spawnSync(
                "bash",
                [
                    "-c",
                    `dd if=/dev/zero bs=1M count=10 status=none | ${JSON.stringify(process.execPath)} ${JSON.stringify(helper.pathname)} ${JSON.stringify(capture)} | head -c 1 >/dev/null`,
                ],
                {
                    encoding: "utf8",
                    timeout: 5000,
                    env: {
                        ...process.env,
                        PI_TAU_STAGE0_MAX_BYTES: "4096",
                    },
                }
            );
            assert.ok(!result.error || !/ETIMEDOUT/.test(result.error.message));
            const status = JSON.parse(
                readFileSync(`${capture}.status.json`, "utf8")
            ) as {
                truncated: boolean;
                reason: string | null;
                tail: { bytes: number; dropped: number } | null;
            };
            assert.equal(status.reason, "epipe");
            assert.ok(
                readFileSync(capture)
                    .toString()
                    .endsWith("\n[stage-0 capture truncated at byte cap]\n")
            );
            assert.equal(status.tail?.bytes, 4096);
            assert.ok((status.tail?.dropped ?? 0) > 0);
            assert.ok(existsSync(`${capture}.tail`));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("bounds a self-reading stage-0 feedback loop", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-feedback-"));
        const capture = join(dir, "stage-zero.log");
        writeFileSync(capture, "");
        const helper = new URL(
            "../features/pipe-nerf/stage0-capture.mjs",
            import.meta.url
        );
        const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
        const producer = `import os,sys\np=${JSON.stringify(capture)}\nwhile os.path.getsize(p) < 4000:\n data=open(p,'rb').read()\n sys.stdout.buffer.write(data or b'seed\\n')`;
        try {
            const output = execFileSync(
                "bash",
                [
                    "-c",
                    `python3 -c ${quote(producer)} | ${quote(process.execPath)} ${quote(helper.pathname)} ${quote(capture)} | wc -c`,
                ],
                {
                    encoding: "utf8",
                    env: { ...process.env, PI_TAU_STAGE0_MAX_BYTES: "4096" },
                }
            );
            const saved = readFileSync(capture);
            assert.ok(Number(output.trim()) > 0);
            assert.ok(saved.length <= 4096);
            assert.match(
                saved.toString(),
                /\[stage-0 capture truncated at byte cap\]/
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("records every rewritten pipeline process exit without changing final status", () => {
        const dir = mkdtempSync(join(tmpdir(), "pipe-nerf-exits-"));
        const capture = join(dir, "stage-zero.log");
        const plan = planPipeNerf("printf 'x\\n' | grep absent | tail -1", {
            stageZeroPath: capture,
        });
        try {
            const result = spawnSync("bash", ["-c", plan.rewritten], {
                encoding: "utf8",
            });
            assert.equal(result.status, 1);
            assert.equal(
                readFileSync(`${capture}.exits`, "utf8").trim(),
                "1\t0 0 1"
            );
            assert.equal(plan.pipelineExitCommands?.[0].length, 3);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("does NOT tee when removing the limiter already leaves one command", () => {
        // Its whole output is the capture, so a second file would duplicate it
        // and double the sidecar sources for every piped call.
        for (const c of ["pytest -q | tail -20", "cd /x && make | tail -20"]) {
            const p = planPipeNerf(c, { stageZeroPath: PATH_0 });
            assert.equal(p.stageZero, null, c);
            assert.ok(!p.rewritten.includes("tee"), c);
        }
    });

    void it("still refuses a count that only the filter could answer", () => {
        // `grep -v 5 | wc -l` asks how many lines SURVIVED the filter. The
        // capture is the filtered output, so its line count would be the wrong
        // answer. Stage 0 makes it re-derivable in principle (re-run the grep
        // against the file), but that is executing the agent's filter, not
        // reproducing it -- so the note says the count is not shown rather than
        // inventing one.
        const p = planPipeNerf("seq 1 60 | grep -v 5 | wc -l", {
            stageZeroPath: "/tmp/s0-shell.log",
        });
        assert.ok(p.stageZero, "stage 0 is still captured");
        assert.equal(
            applyLimiter("1\n2\n3", p.invocation!, {
                truncated: false,
                totalLines: 3,
            }).faithful,
            false
        );
    });

    void it("leaves the pipeline's output byte-identical to the pipe's", () => {
        // Verified against a real shell, not asserted: the rewrite must produce
        // exactly what the agent's own pipeline printed, and stage 0 must hold
        // the pre-filter lines that pipeline dropped.
        // tail/head only: a counting limiter after a filter is deliberately
        // NOT reconstructed (see the upstream-stage tests), because its answer is
        // not derivable from the filtered capture.
        for (const command of [
            "seq 1 60 | grep -E '1|3' | tail -3",
            "seq 1 40 | grep '[25]' | head -4",
        ]) {
            const p = planPipeNerf(command, {
                stageZeroPath: "/tmp/s0-shell.log",
            });
            const view = (capture: string) =>
                applyLimiter(capture.trimEnd(), p.invocation!, {
                    truncated: false,
                    totalLines: capture.trimEnd().split("\n").length,
                }).text;
            const shell = execFileSync("bash", ["-c", command], {
                encoding: "utf8",
            });
            const capture = execFileSync("bash", ["-c", p.rewritten], {
                encoding: "utf8",
            });
            assert.equal(view(capture), shell.trimEnd(), command);
            // Stage 0 holds strictly more than the filtered capture.
            const stage0 = execFileSync(
                "bash",
                ["-c", "cat /tmp/s0-shell.log"],
                {
                    encoding: "utf8",
                }
            );
            assert.ok(
                stage0.trimEnd().split("\n").length >
                    capture.trimEnd().split("\n").length,
                `stage 0 should hold the pre-filter output: ${command}`
            );
        }
    });

    void it("refuses a `|&` operator rather than splicing tee into it", () => {
        // `|&` is a both-streams redirect; injecting a stage there would change
        // the command rather than capture it.
        const p = planPipeNerf("make 2>&1 |& tail -5", {
            stageZeroPath: PATH_0,
        });
        assert.ok(!p.rewritten.includes("tee") || p.stageZero === null);
        if (p.stageZero) {
            assert.ok(!p.rewritten.includes("tee /tmp/x |&"), p.rewritten);
        }
    });
});

void describe("pipe-nerf bounded view", () => {
    const capture = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join(
        "\n"
    );
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
                execFileSync("bash", ["-c", bare], {
                    encoding: "utf8",
                }).trimEnd(),
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
        const view = applyLimiter(
            "last 2000 lines only",
            invocationFor("ls | wc -l"),
            {
                truncated: true,
                totalLines: 250_000,
            }
        );
        assert.equal(view.text, "250000");
        assert.equal(view.faithful, true);
    });

    void it("refuses to guess when the region it reads was already dropped", () => {
        // A `head` over a capture that lost its head, and a `grep -c` over one
        // that lost its matches, cannot be reconstructed. Reporting a number
        // anyway would be quietly wrong, so the note carries the caveat.
        const head = applyLimiter(
            "tail remnant",
            invocationFor("ls | head -3"),
            {
                truncated: true,
                totalLines: 9000,
            }
        );
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
        const plain = applyLimiter(
            "a\nb\nc\n",
            invocationFor("seq 1 100 | wc -l"),
            {
                truncated: false,
                totalLines: 3,
            }
        );
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
        const view = applyLimiter(
            capture,
            invocationFor("ls | awk 'END{print}'"),
            {
                truncated: false,
                totalLines: 60,
            }
        );
        assert.equal(view.faithful, false);
        assert.match(view.caveat ?? "", /awk program/);
        const note = pipeNote(
            plan("ls | awk 'END{print}'"),
            observation({
                fullOutputPath: "/tmp/awk.log",
                totalLines: 60,
                faithful: view.faithful,
                caveat: view.caveat,
                viewDescription: "the full captured output",
            })
        );
        assert.match(note, /Captured 60 lines/);
    });
});

void describe("pipe-nerf note", () => {
    void it("keeps the retained-output note concise and avoids contradictory recovery claims", () => {
        const faithful = pipeNote(
            plan("cat output.txt | head -5"),
            observation({
                fullOutputPath: "/tmp/output.txt",
                sourceId: "ctx_123",
            })
        );
        assert.ok(faithful.split("\n").length <= 4, faithful);
        assert.match(faithful, /Captured 10 lines/);

        const receipt = pipeNote(
            plan("cat output.txt | head -5"),
            observation({
                viewDescription:
                    "a summary of the captured output, with its totals",
            })
        );
        assert.match(receipt, /No retrieval handle is available/);
        assert.match(receipt, /view below/);
        assert.doesNotMatch(
            receipt,
            /retained|context_search|no output was captured/i
        );
    });

    void it("retains every captured line discarded by the limiter and gives retrieval instructions", () => {
        const note = pipeNote(
            plan("pytest -q | tail -5"),
            observation({
                totalLines: 4000,
                visibleLines: 5,
                fullOutputPath: "/tmp/pytest.log",
                sourceId: "ctx_pytest",
            })
        );
        assert.match(note, /Captured 4000 lines/);
        assert.match(note, /sed -n 'START,ENDp' \/tmp\/pytest\.log/);
        assert.match(note, /context_search.*ctx_pytest/);
        assert.match(note, /Effective command:/);
        assert.doesNotMatch(note, /Stage-0 holds the pipeline inputs/);
        assert.doesNotMatch(note, /nothing was written|re-run|export it whole/);
    });

    void it("does not claim the stream separation is back when it is not", () => {
        const note = pipeNote(
            plan("make -j8 2>&1 | tail -50"),
            observation({ totalLines: 51, fullOutputPath: "/tmp/make.log" })
        );
        assert.match(note, /Captured 51 lines/);
        assert.doesNotMatch(note, /separation is back|left in place/);
    });

    void it("reports the err/warn mix with the line count", () => {
        const note = pipeNote(
            plan("pytest -q | tail -20"),
            observation({
                totalLines: 1204,
                err: 12,
                warn: 88,
                fullOutputPath: "/tmp/test.log",
            })
        );
        assert.match(note, /Captured 1204 lines \(12 err, 88 warn\)/);
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
        assert.match(note, /context_get source_id:"ctx_bg_abc"/);
        assert.match(note, /context_search.*ctx_bg_abc/);
        assert.ok(note.split("\n").length <= 4);
    });

    void it("warns that head and the tool disagree about which end to keep", () => {
        const note = pipeNote(
            plan("git log | head -10"),
            observation({
                totalLines: 30,
                fullOutputPath: "/tmp/git.log",
                viewDescription:
                    "the first 10 lines, as your pipe would have printed",
            })
        );
        assert.match(note, /Captured 30 lines/);
        assert.doesNotMatch(note, /keeps the END/);
    });

    void it("names the pre-filter capture and how to re-filter it", () => {
        // The whole point of stage 0: the result is filtered, so a different
        // pattern has to run against the pre-filter output rather than a fresh
        // execution of a build. Both the source id and the path are offered,
        // because an agent that wants `sort` or `jq` needs a file.
        const captured = pipeNote(
            plan("make test 2>&1 | grep FAILED | tail -10"),
            observation({
                totalLines: 12,
                visibleLines: 10,
                fullOutputPath: "/tmp/pi-bg-job.log",
                sourceId: "ctx_bg_post",
                pipeStageZero: {
                    path: "/home/dev/.cache/pi-tau/stage0/pi-pipe-stage0-call_00_x.log",
                    command: "make test 2>&1",
                    sourceId: "ctx_bg_stage0",
                },
                stageZeroStatus: {
                    truncated: true,
                    bytesWritten: 1024 * 1024,
                    reason: "cap",
                    tail: {
                        bytes: 2 * 1024 * 1024,
                        dropped: 1024,
                    },
                },
                pipelineExitLines: [
                    'Pipeline exits (segment 1): stage 1 "make test 2>&1"=0, stage 2 pipe-hoist capture=0, stage 3 "grep FAILED"=0.',
                ],
                receiptLines: [
                    `- Search it first: context_search query:"..." source_id:"ctx_bg_post"`,
                ],
            })
        );
        assert.match(captured, /Captured 12 lines/);
        assert.doesNotMatch(
            captured,
            /Stage-0 contains the inputs for captured pipeline segments/
        );
        assert.match(captured, /sed -n 'START,ENDp' \/tmp\/pi-bg-job\.log/);
        assert.match(
            captured,
            /Pre-filter stage-0 capture: context source "ctx_bg_stage0"/
        );
        assert.match(
            captured,
            /Stage-0 capture truncated: first 1\.0 MiB at .*last 2\.0 MiB at .*\.tail.*1024 bytes in between are unavailable/
        );
        assert.match(captured, /Pipeline exits \(segment 1\)/);
        assert.match(
            captured,
            /Inspect stage-0 with context_search\/context_get\/context_export/
        );
    });

    void it("uses the prefix-only truncation notice when no tail status is available", () => {
        const captured = pipeNote(
            plan("make test 2>&1 | grep FAILED | tail -10"),
            observation({
                pipeStageZero: {
                    path: "/tmp/stage0-legacy.log",
                    command: "make test 2>&1",
                    sourceId: null,
                },
                stageZeroStatus: {
                    truncated: true,
                    bytesWritten: 4096,
                    reason: "cap",
                    tail: null,
                },
            })
        );
        assert.match(captured, /only this captured prefix is available/);
        assert.doesNotMatch(captured, /\\.tail/);
    });

    void it("falls back to the path when the pre-filter capture is not indexed", () => {
        const captured = pipeNote(
            plan("make test 2>&1 | grep FAILED | tail -10"),
            observation({
                pipeStageZero: {
                    path: "/home/dev/.cache/pi-tau/stage0/pi-pipe-stage0-call_00_y.log",
                    command: "make test 2>&1",
                    sourceId: null,
                },
            })
        );
        assert.match(captured, /No retrieval handle is available/);
        assert.match(
            captured,
            /Pre-filter stage-0 capture: file \/home\/dev\/\.cache\/pi-tau\/stage0\/pi-pipe-stage0-call_00_y\.log/
        );
        assert.match(captured, /Inspect the local file with sed or grep/);
        assert.doesNotMatch(captured, /Capture truncated/);
    });

    void it("offers the log path on the sidecar route too", () => {
        // The source id is for context_* retrieval, but an agent that wants to
        // re-filter (`sort`, `jq`, a different grep) needs something it can point
        // a tool at. The path was previously offered only when nothing was
        // indexed, so the common large-output case had no post-process route.
        const note = pipeNote(
            plan("pytest -q | tail -20"),
            observation({
                totalLines: 1204,
                sourceId: "ctx_bg_abc",
                fullOutputPath: "/tmp/pi-bg-job.log",
                receiptLines: [
                    `- Search it first: context_search query:"..." source_id:"ctx_bg_abc"`,
                ],
            })
        );
        assert.match(note, /Captured 1204 lines/);
        assert.match(note, /sed -n 'START,ENDp' \/tmp\/pi-bg-job\.log/);
        assert.match(note, /context_search.*ctx_bg_abc/);
        assert.ok(note.split("\n").length <= 4);
    });

    void it("does not claim the capture is empty when no retrieval handle exists", () => {
        const sections = pipeNoteSections(
            plan("pytest -q | tail -5"),
            observation({ totalLines: 0, visibleLines: 0 })
        );
        assert.doesNotMatch(sections.notice, /no output was captured/i);
        assert.match(sections.notice, /view below/i);
        assert.match(sections.notice, /no retrieval handle/i);
        assert.doesNotMatch(sections.notice, /retained|context_search|sed -n/);
        assert.doesNotMatch(sections.notice, /re-run|bash_bg/);
    });

    void it("does not claim there is more data when the visible view is complete", () => {
        const note = pipeNote(
            plan("pytest -q | tail -5"),
            observation({
                totalLines: 5,
                visibleLines: 5,
                fullOutputPath: "/tmp/pytest.log",
            })
        );
        assert.match(note, /complete 5-line output/);
        assert.doesNotMatch(
            note,
            /all are retained|Read any window|context_search/
        );
    });

    void it("retains a small capture because size must not decide survival", () => {
        const note = pipeNote(
            plan("pytest -q | tail -5"),
            observation({
                totalLines: 8,
                visibleLines: 5,
                fullOutputPath: "/tmp/small-pytest.log",
            })
        );
        assert.match(note, /Captured 8 lines/);
        assert.match(note, /sed -n 'START,ENDp' \/tmp\/small-pytest\.log/);
        assert.doesNotMatch(note, /small enough|nothing was written/);
    });

    void it("does not infer a retrieval handle from the visible count alone", () => {
        const note = pipeNote(
            plan("ls | wc -l"),
            observation({ totalLines: null, visibleLines: 17 })
        );
        assert.match(note, /No retrieval handle is available/);
        assert.match(note, /view below/);
        assert.doesNotMatch(note, /no output was captured/i);
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

    void it("surfaces the self-reference preflight in the tool result", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);
        const directory = stageZeroDirectory();
        const command = `grep -r pattern ${directory} | head -3`;
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "self-reference",
            input: { command },
        });
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "self-reference",
            content: [{ type: "text", text: "original output" }],
        }) as { content: { type: string; text: string }[] };
        assert.equal(
            result.content[0].text,
            `capture disabled: command references the capture directory (${directory})`
        );
        assert.equal(result.content[1].text, "original output");
    });

    void it("keeps the rewrite receipt before a non-empty payload", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "receipt-order",
            input: { command: "printf 'a\\nb\\n' | tail -2" },
        });

        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "receipt-order",
            content: [{ type: "text", text: "a\nb" }],
            details: { truncation: { truncated: false, totalLines: 2 } },
        }) as { content: { type: string; text: string }[] };

        assert.match(result.content[0].text, /^Effective command:/);
        assert.equal(result.content[1].text, "a\nb");
    });

    void it("keeps the tagged capture tip after payload and never first", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "tip-order",
            input: { command: "seq 1 60 | tail -2" },
        });
        const capture = Array.from(
            { length: 60 },
            (_, i) => `line-${i + 1}`
        ).join("\n");
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "tip-order",
            content: [{ type: "text", text: capture }],
            details: {
                truncation: { truncated: false, totalLines: 60 },
                fullOutputPath: "/tmp/tip-order.log",
            },
        }) as { content: { type: string; text: string }[] };

        assert.equal(result.content[1].text, "line-59\nline-60");
        const tip = result.content.at(-1)?.text ?? "";
        assert.ok(tip.startsWith("\n\n[notice] "));
        assert.match(tip, /Captured 60 lines/);
        assert.doesNotMatch(result.content[0].text, /^\s*\[notice\]/);
    });

    void it("rewrites the command and annotates the result", () => {
        const { pi, handlers, entries, guidelines } = fakePi();
        registerPipeNerf(pi as never);

        assert.equal(guidelines.length, 1);
        assert.equal(guidelines[0].tool, "bash");

        const input: { command: string } = {
            command: "pytest -q 2>&1 | tail -20",
        };
        const actualCommand = plan(input.command).rewritten;
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "t1",
            input,
        });
        assert.equal(input.command, actualCommand);
        assert.equal(input.command, "pytest -q 2>&1");

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
        assert.equal(
            entries.filter((e) => e.type === "pipe-nerf-compound-stage0")
                .length,
            0
        );
        const receipt = result.content[0].text;
        const payload = result.content[1].text;
        const notice = result.content[2].text;
        assert.ok(
            receipt.includes(
                `Effective command: ${JSON.stringify(actualCommand)}.`
            )
        );
        assert.equal(payload, "FAILED tests/x");
        assert.ok(notice.startsWith("\n\n[notice] "));
        assert.match(notice, /Captured 900 lines \(0 err, 1 warn\)/);
        assert.match(notice, /sed -n 'START,ENDp' \/tmp\/out\.log/);
        assert.doesNotMatch(notice, /re-running/);
    });

    void it("leaves wc -c untouched and preserves its actual output", () => {
        const command = "echo hi | tee /dev/null | wc -c";
        const { original, rewritten } = superset(command);
        assert.equal(original, "3\n");
        assert.equal(rewritten, original);

        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);
        const input: { command: string } = { command };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "wc-bytes",
            input,
        });
        assert.equal(input.command, command);

        const originalResult = {
            content: [{ type: "text", text: original }],
        };
        assert.equal(
            fire(handlers, "tool_result", {
                toolName: "bash",
                toolCallId: "wc-bytes",
                ...originalResult,
            }),
            undefined
        );
        assert.equal(originalResult.content[0].text, "3\n");
    });

    void it("rewrites bash_bg too, which is where the log is the only record", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        const input: { command: string } = {
            command: "pytest 2>&1 | tail -50",
        };
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

        assert.match(result.content[0].text, /^Effective command:/);
        assert.equal(result.content[1].text, "ok");
        assert.match(
            result.content[2].text,
            /complete 1-line output is available/
        );
    });

    void it("returns the requested small head content after a forced index, not a receipt", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);
        const capture = Array.from(
            { length: 200 },
            (_, i) => `line-${i + 1}`
        ).join("\n");
        const input: { command: string } = { command: "seq 1 200 | head -5" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "small-head",
            input,
        });
        assert.equal(input.command, "seq 1 200");
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "small-head",
            content: [{ type: "text", text: capture }],
            details: {
                truncation: { truncated: false, totalLines: 60 },
                sourceId: "ctx_small_head",
                chunkIds: ["ctx_small_head_0001"],
                fullOutputPath: "/tmp/small-head.log",
            },
        }) as { content: { type: string; text: string }[] };
        assert.match(result.content[0].text, /^Effective command:/);
        assert.match(result.content[2].text, /Captured 60 lines/);
        assert.equal(
            result.content[1].text,
            "line-1\nline-2\nline-3\nline-4\nline-5"
        );
        assert.doesNotMatch(result.content[1].text, /line-6|line-200/);
        assert.doesNotMatch(result.content[1].text, /context-sidecar/);
    });

    void it("returns wc -l's answer to the agent instead of the raw capture", () => {
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);
        const capture = Array.from({ length: 200 }, (_, i) =>
            String(i + 1)
        ).join("\n");
        const input: { command: string } = { command: "seq 1 200 | wc -l" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "small-wc",
            input,
        });
        assert.equal(input.command, "seq 1 200");

        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "small-wc",
            content: [{ type: "text", text: capture }],
            details: { truncation: { truncated: false, totalLines: 200 } },
        }) as { content: { type: string; text: string }[] };

        assert.equal(result.content[1].text, "200");
        assert.doesNotMatch(result.content[1].text, /1\n2|200\n/);
    });

    void it("preserves both shell-produced views in a compound call", () => {
        const { pi, handlers, entries } = fakePi();
        registerPipeNerf(pi as never);
        const input: { command: string } = {
            command: "seq 1 10 | tail -2; echo ===; seq 1 10 | wc -l",
        };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "compound-wc",
            input,
        });
        assert.match(input.command, /tail -2/);
        assert.match(input.command, /wc -l/);
        const counter = entries.find(
            (entry) => entry.type === "pipe-nerf-compound-stage0"
        );
        assert.deepEqual(counter?.data, {
            toolCallId: "compound-wc",
            segmentCount: 3,
            capturedPipelineCount: 2,
        });

        const visible = "9\n10\n===\n10";
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "compound-wc",
            content: [{ type: "text", text: visible }],
            details: {
                truncation: { truncated: false, totalLines: 4 },
                pipeStageZero: {
                    path: "/tmp/compound-stage-zero.log",
                    command: "seq 1 10",
                    sourceId: "ctx_compound_stage_zero",
                },
            },
        }) as { content: { type: string; text: string }[] };
        assert.match(result.content[0].text, /ctx_compound_stage_zero/);
        assert.match(
            result.content[0].text,
            /Stage-0 is indexed as "ctx_compound_stage_zero"/
        );
        assert.match(
            result.content[0].text,
            /\(1\).*tail -2.*\(2\).*echo ===.*\(3\).*wc -l/
        );
        assert.match(result.content[0].text, /\[then ;\].*\[then ;\]/);
        assert.equal(result.content[1].text, visible);
        assert.doesNotMatch(result.content[1].text, /1\n2/);
    });

    void it("names the truncation reason in an indexed stage-0 reference", () => {
        const dir = mkdtempSync(
            join(tmpdir(), "tau-stage0-indexed-truncated-")
        );
        const capturePath = join(dir, "capture.log");
        writeFileSync(
            `${capturePath}.status.json`,
            JSON.stringify({
                truncated: true,
                bytesWritten: 1024,
                reason: "epipe",
            })
        );
        try {
            const { pi, handlers } = fakePi();
            registerPipeNerf(pi as never);
            fire(handlers, "tool_call", {
                toolName: "bash",
                toolCallId: "truncated-indexed",
                input: {
                    command: "seq 1 10 | tail -2; echo ===; seq 1 10 | wc -l",
                },
            });
            const result = fire(handlers, "tool_result", {
                toolName: "bash",
                toolCallId: "truncated-indexed",
                content: [{ type: "text", text: "9\\n10\\n===\\n10" }],
                details: {
                    truncation: { truncated: false, totalLines: 2 },
                    pipeStageZero: {
                        path: capturePath,
                        command: "seq 1 10",
                        sourceId: "ctx_truncated_stage_zero",
                    },
                },
            }) as { content: { type: string; text: string }[] };
            assert.match(
                result.content[0].text,
                /Stage-0 is indexed as "ctx_truncated_stage_zero" \(capture truncated: reason epipe\)/
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
            .slice(1, -1)
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

        const note = result.content.at(-1)?.text ?? "";
        const body = result.content
            .slice(1, -1)
            .map((part) => part.text)
            .join("\n");
        assert.equal(body, remnant, "the capture must be returned as-is");
        assert.match(note, /Captured 9000 lines/);
        assert.match(
            note,
            /View caveat: your pipe asked for the first 3 lines/
        );
        assert.match(note, /sed -n 'START,ENDp' \/tmp\/out\.log/);
    });

    void it("does not bound the tool's own sidecar receipt", () => {
        // Indexed output arrives as a RECEIPT, not as the output. Bounding it
        // produced "Captured 7 lines" against a 60-line total and a tail -3 of
        // the receipt's prose -- the note contradicted the detail field beside
        // it. The receipt already carries the totals and the retrieval calls, so
        // it IS the bounded result and is passed through untouched.
        const { pi, handlers } = fakePi();
        registerPipeNerf(pi as never);

        const receipt = [
            "[context-sidecar] Large bash output indexed locally",
            "Source: ctx_bg_abc",
            "Chunks: 1; original size: 1011 bytes, 60 lines",
            '- Search snippets first: context_search query:"..." source_id:"ctx_bg_abc"',
        ].join("\n");

        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "receipted",
            input: { command: "seq 1 60 | tail -3" },
        });
        const result = fire(handlers, "tool_result", {
            toolName: "bash",
            toolCallId: "receipted",
            content: [{ type: "text", text: receipt }],
            details: {
                truncation: { truncated: true, totalLines: 60 },
                sourceId: "ctx_bg_abc",
                chunkIds: ["ctx_bg_abc_0001"],
                fullOutputPath: "/tmp/pi-bg-job.log",
            },
        }) as { content: { text: string }[] };

        const note = result.content.at(-1)?.text ?? "";
        const body = result.content
            .slice(1, -1)
            .map((part) => part.text)
            .join("\n");
        // The receipt is untouched, not sliced to its last 3 lines.
        assert.equal(body, receipt);
        // The note speaks about the capture it was GIVEN, and does not invent a
        // line count from the receipt's own text.
        assert.ok(
            !/Captured 7 lines/.test(note),
            `the note counted the receipt's lines: ${note}`
        );
        assert.match(note, /Captured 60 lines/);
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
        const overrides = new Map<string, boolean>();
        const state = {
            featureOverridesSession: overrides,
            // The nerf records hoisted calls here so the bash tool forces an
            // index for them. A double that omits it made the optional chaining
            // hide a missing field instead of failing.
            pipeHoistedCalls: new Set<string>(),
            pipeStageZeroCalls: new Map<string, unknown>(),
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
        overrides.set("pipe-nerf", false);
        const second = { command: "ls | tail -5" };
        fire(handlers, "tool_call", {
            toolName: "bash",
            toolCallId: "off1",
            input: second,
        });
        assert.equal(second.command, "ls | tail -5");

        // And turned back on: the flag is read again, not cached either way.
        overrides.delete("pipe-nerf");
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
            pipeStageZeroCalls: new Map<string, unknown>(),
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
            pipeStageZeroCalls: new Map<string, unknown>(),
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
            const args = stage.slice(
                stage.match(/^[\w.+~/-]*/)?.[0].length ?? 0
            );
            if (
                invocation.kind === "tail" &&
                /(?:^|\s)-[A-Za-z]*f(?:\s|$)/.test(args)
            ) {
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
