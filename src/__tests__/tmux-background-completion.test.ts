/**
 * Integration tests for the tmux-backed bash tool's auto-background path.
 *
 * Regression coverage for two defects found in session analysis
 * (issues/2026-08-02-stale-callback-tmux):
 *
 * 1. A leaked 200ms completion-check interval kept running after backgrounding
 *    and read+unlinked the exit-code sentinel, starving the 500ms bgPoller of
 *    the exit code. The job stayed "running" forever, silently defeating the
 *    linked-callback auto-cancel (callbacks fired stale).
 *
 * 2. The tmux path ignored `backgroundAfter` and used a 15s default timeout,
 *    so `backgroundAfter=300` backgrounded after 15s, not 300s.
 *
 * These tests require tmux and git to be installed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { registerBackgroundJobs } from "../features/background.ts";
import { TauState } from "../state.ts";
import { sessionNameForGitRoot } from "../tmux.ts";

const TEST_RUN_DIR = `/tmp/pi-tmux-bgtest-${process.pid}`;

function killTestSession(): void {
    try {
        execSync(
            `tmux kill-session -t ${sessionNameForGitRoot(TEST_RUN_DIR)} 2>/dev/null`
        );
    } catch {
        /* already gone */
    }
}

/** Record sendMessage calls so tests can assert no duplicate timeout notice. */
interface CapturedMessage {
    type: string;
    content: string;
}

/**
 * Capture the bash tool handler via DI, mirroring background.unit.test.ts
 * but also recording sendMessage payloads.
 */
function captureBashTool(state: TauState): {
    tool: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: { cwd: string; ui?: unknown }
        ) => Promise<{ content: unknown[]; details: unknown }>;
    };
    messages: CapturedMessage[];
} {
    let captured: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: { cwd: string; ui?: unknown }
        ) => Promise<{ content: unknown[]; details: unknown }>;
    } | null = null;
    const messages: CapturedMessage[] = [];

    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "bash") captured = tool as typeof captured;
        },
        registerCommand() {},
        registerToolPromptGuidelines() {},
        sendMessage(
            msg: { customType?: string; content?: string },
            _opts?: unknown
        ) {
            messages.push({
                type: msg.customType ?? "",
                content: msg.content ?? "",
            });
        },
    } as never;

    registerBackgroundJobs(pi, state);
    return { tool: captured!, messages };
}

const stubUi = {
    notify: () => {},
    setWidget: () => {},
    setStatus: () => {},
    theme: { fg: (_accent: string, text: string) => text },
};

/** Wait until a predicate is true or the deadline passes. */
async function waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    label: string
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(predicate(), label);
}

void describe(
    "tmux bash backgrounding — completion + backgroundAfter",
    { concurrency: 1 },
    () => {
        beforeEach(() => {
            killTestSession();
            mkdirSync(TEST_RUN_DIR, { recursive: true });
            execSync("git init -q", { cwd: TEST_RUN_DIR });
        });
        afterEach(() => {
            killTestSession();
            rmSync(TEST_RUN_DIR, { recursive: true, force: true });
        });

        void it("wakes non-interactive silent tmux commands and preserves a newer tool owner", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            state.nonInteractive = true;
            const { tool } = captureBashTool(state);
            const previousWakeMs = process.env.PI_TAU_STALL_WAKE_MS;
            process.env.PI_TAU_STALL_WAKE_MS = "100";

            try {
                const execution = tool.execute(
                    "tc-stall-wake-tmux",
                    { command: "tail -f /dev/null" },
                    null,
                    null,
                    { cwd: TEST_RUN_DIR, ui: stubUi }
                );
                setTimeout(() => {
                    state.currentlyRunningToolCallId = "newer-tool-call";
                }, 100);

                await assert.rejects(
                    execution,
                    /Possibly stuck: no output.*bash_bg/s
                );
                assert.equal(
                    state.currentlyRunningToolCallId,
                    "newer-tool-call",
                    "stall cleanup must not clear a newer tool call's ownership"
                );
                const stalledJob = [...state.backgroundJobs.values()].find(
                    (job) => job.command === "tail -f /dev/null"
                );
                assert.equal(stalledJob?.status, "killed");
            } finally {
                if (previousWakeMs === undefined)
                    delete process.env.PI_TAU_STALL_WAKE_MS;
                else process.env.PI_TAU_STALL_WAKE_MS = previousWakeMs;
            }
        });

        void it("honors backgroundAfter and reaches terminal status so linked callbacks auto-cancel", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            const { tool, messages } = captureBashTool(state);

            const started = Date.now();
            const result = await tool.execute(
                "tc-bg-1",
                {
                    command:
                        "python3 -c 'import time; time.sleep(2.5); print(\"done\")'",
                    backgroundAfter: 1,
                },
                null,
                null,
                { cwd: TEST_RUN_DIR, ui: stubUi }
            );
            const backgroundedAfterMs = Date.now() - started;

            // Fix 2: backgroundAfter=1 backgrounds after ~1s, not the 15s default.
            assert.ok(
                backgroundedAfterMs < 5_000,
                `backgrounded after ${backgroundedAfterMs}ms — ` +
                    "expected < 5s (backgroundAfter honored)"
            );
            assert.match(
                String((result.content[0] as { text?: string })?.text ?? ""),
                /Process backgrounded as/
            );

            // The tool result is the authoritative backgrounding notice; no
            // duplicate bg-timeout follow-up should wake the model.
            assert.equal(
                messages.some((m) => m.type === "bg-timeout"),
                false,
                "bg-timeout should not be sent as a duplicate follow-up"
            );

            // The backgrounded job is tracked in state.
            const job = [...state.backgroundJobs.values()].find(
                (j) => j.isBackgrounded
            );
            assert.ok(
                job,
                "backgrounded job should be registered in state.backgroundJobs"
            );

            // Fix 1: the job must reach terminal status once the command
            // finishes (~2.5s). Before the fix, the leaked 200ms
            // completion-check interval consumed the exit-code sentinel,
            // starving the 500ms bgPoller, so the job stayed "running"
            // forever — defeating the linked-callback auto-cancel.
            await waitFor(
                () => job.status !== "running",
                10_000,
                `job ${job.id} should reach terminal status within 10s ` +
                    `(got status=${job.status})`
            );
            assert.equal(job.status, "completed");
            assert.equal(
                state.pendingDecisionJobId,
                undefined,
                "completed tmux jobs must not leave the tool gate blocked"
            );
        });
    }
);
