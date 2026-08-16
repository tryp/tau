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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    registerBackgroundJobs,
    startStallWatchdog,
} from "../features/background.ts";
import { TauState } from "../state.ts";
import { STALL_CHECK_INTERVAL_MS, STALL_THRESHOLD_MS } from "../utils.ts";

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
