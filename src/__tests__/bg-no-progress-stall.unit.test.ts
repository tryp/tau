/**
 * Regression tests for the stall-watchdog blind spot found during session
 * analysis of a stuck pi session (2026-08-15, sippi linter campaign, WS-D).
 *
 * Incident: an agent dispatched a bash_bg job running a python one-liner that
 * scanned `external/bridge/*.cpp` with a catastrophic-backtracking regex
 * `[\w:*&<>]+(?:\s+|\s*\*\s*)+(vkfft_\w+)\s*\(`. The job:
 *   - produced ZERO bytes of output for its entire lifetime,
 *   - burned one CPU core at 100% for 21.6 hours,
 *   - never completed, and was never killed (no `timeout` was set).
 *
 * The stall watchdog (startStallWatchdog) polls the job log every 5s. Because
 * the log never grew AND never looked like an interactive prompt, the watchdog
 * reset its `lastGrowth` timestamp on every tick (`!looksLikePrompt(tail)` →
 * reset) and never fired. The agent waited on the job forever; its parent
 * session stayed blocked on the parallel subagent batch for 21.7h.
 *
 * Contract under test: a background job that has produced no output for
 * STALL_THRESHOLD_MS must be surfaced to the agent as a `bg-stall` message —
 * exactly like an interactive-prompt stall — so the agent can job_decide
 * keep/kill instead of waiting silently forever. A silent-but-alive job is
 * indistinguishable from a hung one to the waiting agent.
 *
 * The first test below reproduces the gap (fails against current code).
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    registerBackgroundJobs,
    startStallWatchdog,
} from "../features/background.ts";
import { TauState } from "../state.ts";
import {
    MAX_LOG_BYTES,
    STALL_CHECK_INTERVAL_MS,
    STALL_THRESHOLD_MS,
} from "../utils.ts";

interface CapturedMessage {
    customType?: string;
    content: string;
}

function makePi(messages: CapturedMessage[]): never {
    return {
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        registerToolPromptGuidelines() {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
        sendMessage(
            msg: { customType?: string; content?: string },
            _opts?: unknown
        ) {
            messages.push({
                customType: msg.customType ?? "",
                content: msg.content ?? "",
            });
        },
    } as never;
}

type TestTool = {
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: { cwd: string; ui?: unknown }
    ) => Promise<{
        content: { type: string; text: string }[];
        details?: unknown;
    }>;
};

/** Capture a registered tool by name via the standard DI surface. */
function captureTool(state: TauState, toolName: string): TestTool {
    let captured: TestTool | undefined;
    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === toolName) captured = tool as TestTool;
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerToolPromptGuidelines() {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
    } as never;
    registerBackgroundJobs(pi, state);
    assert.ok(captured, `tool ${toolName} must be registered`);
    return captured;
}

const stubUi = {
    notify: () => {},
    setWidget: () => {},
    setStatus: () => {},
    theme: { fg: (_accent: string, text: string) => text },
};

/** Ticks needed to run well past the stall threshold in per-interval steps. */
const STALL_TICKS =
    Math.ceil(
        (STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS) / STALL_CHECK_INTERVAL_MS
    ) + 1;

void describe("stall watchdog — no-progress jobs", () => {
    let dir: string;
    let logPath: string;
    let messages: CapturedMessage[];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-tau-stall-"));
        logPath = join(dir, "job.out");
        writeFileSync(logPath, "");
        messages = [];
        mock.timers.enable({ apis: ["setInterval", "Date"] });
    });

    afterEach(() => {
        mock.timers.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    void it("REPRODUCER: surfaces a job that produces no output (CPU spin) as bg-stall", () => {
        // Mirrors the stuck-session job: a catastrophic-backtracking regex
        // that spins a core at 100% while writing nothing to the log.
        const command =
            "python3 -c \"import re; re.search(r'(a+)+b', 'a'*40 + '!')\"";
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-spin",
            command,
            logPath,
            makePi(messages),
            state
        );

        // Let the job "run" far past the stall threshold with zero output.
        // Tick in per-interval steps: a single large tick makes the mocked
        // Date.now() jump to the final value for every callback, which would
        // hide real elapsed-time logic.
        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        const stalls = messages.filter((m) => m.customType === "bg-stall");
        assert.ok(
            stalls.length > 0,
            "a zero-output job must be surfaced as bg-stall so the agent " +
                "can decide keep/kill instead of waiting forever"
        );
    });

    void it("suppresses stale warnings after a job reaches terminal state", () => {
        const state = new TauState();
        state.backgroundJobs.set("job-killed", {
            id: "job-killed",
            status: "killed",
        } as never);
        const cancel = startStallWatchdog(
            "job-killed",
            "tmux send-keys",
            logPath,
            makePi(messages),
            state
        );

        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.equal(
            messages.length,
            0,
            "terminal jobs must not emit delayed bg-stall notifications"
        );
    });

    void it("still surfaces a job blocked on an interactive prompt", () => {
        writeFileSync(logPath, "Overwrite existing file? (y/n): ");
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-prompt",
            "rm -i some-file",
            logPath,
            makePi(messages),
            state
        );

        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.ok(
            messages.some((m) => m.customType === "bg-stall"),
            "prompt-blocked jobs must keep firing bg-stall"
        );
    });

    void it("does not fire while the log keeps growing", () => {
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-alive",
            "slow but alive",
            logPath,
            makePi(messages),
            state
        );

        // Feed output on every watchdog tick so growth is always visible.
        for (let i = 0; i < 15; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
            writeFileSync(logPath, `line ${i}\n`, { flag: "a" });
        }
        cancel();

        assert.equal(
            messages.filter((m) => m.customType === "bg-stall").length,
            0,
            "a job with steady output must not be flagged as stalled"
        );
    });
});

void describe("stall watchdog — silence notice for a job detached as silent", () => {
    let dir: string;
    let logPath: string;
    let messages: CapturedMessage[];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-tau-stall-detached-"));
        logPath = join(dir, "job.out");
        writeFileSync(logPath, "");
        messages = [];
        mock.timers.enable({ apis: ["setInterval", "Date"] });
    });

    afterEach(() => {
        mock.timers.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    void it("does not repeat the silence the detach notice already reported", () => {
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-detached",
            "long silent computation",
            logPath,
            makePi(messages),
            state,
            undefined,
            { silenceNoticeOnlyAfterGrowth: true }
        );

        for (let i = 0; i < STALL_TICKS * 3; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.equal(
            messages.filter((m) => m.customType === "bg-stall").length,
            0,
            "a job detached because it was already silent must not emit a " +
                "second, contradictory keep-it-or-kill-it prompt"
        );
    });

    void it("announces silence again after the job produces output and goes quiet", () => {
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-detached-then-quiet",
            "long silent computation",
            logPath,
            makePi(messages),
            state,
            undefined,
            { silenceNoticeOnlyAfterGrowth: true }
        );

        // First silence window passes with no notice: the agent was just
        // told this job is silent by the detach notice.
        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        assert.equal(
            messages.length,
            0,
            "no notice during the initial silence window"
        );

        // The job makes progress, then goes quiet again. That is new
        // information and must be surfaced.
        writeFileSync(logPath, "point 1 done\n");
        mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.ok(
            messages.some((m) => m.customType === "bg-stall"),
            "silence after real progress must still be surfaced"
        );
    });

    void it("still terminates an oversize log while the silence notice is suppressed", () => {
        const state = new TauState();
        let oversize = 0;
        const cancel = startStallWatchdog(
            "job-oversize",
            "chatty computation",
            logPath,
            makePi(messages),
            state,
            () => {
                oversize++;
            },
            { silenceNoticeOnlyAfterGrowth: true }
        );

        // Sparse file: only the reported size matters, not bytes on disk.
        truncateSync(logPath, MAX_LOG_BYTES + 1);
        mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        cancel();

        assert.equal(
            oversize,
            1,
            "oversize termination must stay armed for a detached job"
        );
        assert.ok(
            messages.some((m) => /exceeded/.test(m.content)),
            "the oversize notice must still be delivered"
        );
    });

    void it("still surfaces an interactive prompt while the silence notice is suppressed", () => {
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-detached-prompt",
            "rm -i some-file",
            logPath,
            makePi(messages),
            state,
            undefined,
            { silenceNoticeOnlyAfterGrowth: true }
        );

        writeFileSync(logPath, "Overwrite existing file? (y/n): ");
        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.ok(
            messages.some((m) => m.customType === "bg-stall"),
            "prompt detection is distinct information and must still fire"
        );
    });

    void it("still surfaces a prompt that was already present when armed", () => {
        // A pre-existing prompt is not new growth, but it is actionable and
        // distinct from a plain silence stall, so it must still be reported
        // as an interactive-input block rather than swallowed.
        writeFileSync(logPath, "Overwrite existing file? (y/n): ");
        const state = new TauState();
        const cancel = startStallWatchdog(
            "job-prompt-at-arm",
            "rm -i some-file",
            logPath,
            makePi(messages),
            state,
            undefined,
            { silenceNoticeOnlyAfterGrowth: true }
        );

        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.ok(
            messages.some((m) => /interactive input/.test(m.content)),
            "a pre-existing prompt is still actionable and must be surfaced"
        );
        assert.equal(
            messages.filter((m) => /produced no output/.test(m.content)).length,
            0,
            "it must not be reported as a plain silence stall"
        );
    });
});

void describe("bash_bg — tmux launch failure must resolve, not hang", () => {
    void it("rejects with an explicit error when the tmux backend cannot launch (non-git cwd)", async () => {
        const state = new TauState();
        state.tmuxAvailable = true;
        const bashBg = captureTool(state, "bash_bg");

        const nonGitDir = mkdtempSync(join(tmpdir(), "pi-tau-nongit-"));
        try {
            await assert.rejects(
                bashBg.execute("tc-1", { command: "echo hi" }, null, null, {
                    cwd: nonGitDir,
                    ui: stubUi,
                }),
                /Not in a git repository/,
                "a failed tmux launch must surface as an explicit tool error, " +
                    "never leave the agent waiting for a result that will not come"
            );
        } finally {
            rmSync(nonGitDir, { recursive: true, force: true });
        }
    });
});
