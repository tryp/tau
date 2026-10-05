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
import { getTmuxContext } from "../features/bash-tmux.ts";
import { TauState } from "../state.ts";
import { listWindows, queryWindows, sessionNameForGitRoot } from "../tmux.ts";

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

/** Run `fn` with temporary env overrides, restoring them afterwards. */
async function withEnv<T>(
    overrides: Record<string, string>,
    fn: () => Promise<T>
): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

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

/**
 * These tests drive real tmux sessions and need a git work tree to take the
 * tmux path. Skip (rather than fail) where either is missing.
 */
const TMUX_AND_GIT_AVAILABLE = ((): boolean => {
    try {
        execSync("tmux -V", { stdio: "ignore" });
        execSync("git --version", { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

const TMUX_SUITE_OPTIONS = {
    concurrency: 1,
    skip: !TMUX_AND_GIT_AVAILABLE,
};

void describe(
    "tmux bash backgrounding — completion + backgroundAfter",
    TMUX_SUITE_OPTIONS,
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

        void it("detaches non-interactive silent tmux commands and preserves a newer tool owner", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            state.nonInteractive = true;
            const { tool } = captureBashTool(state);
            const previousWakeMs = process.env.PI_TAU_STALL_WAKE_MS;
            process.env.PI_TAU_STALL_WAKE_MS = "100";

            try {
                const execution = tool.execute(
                    "tc-stall-detach-tmux",
                    { command: "tail -f /dev/null" },
                    null,
                    null,
                    { cwd: TEST_RUN_DIR, ui: stubUi }
                );
                setTimeout(() => {
                    state.currentlyRunningToolCallId = "newer-tool-call";
                }, 100);

                const result = await execution;
                const first = result.content[0] as { text: string };
                assert.match(
                    first.text,
                    /detached the still-running command to the background instead of killing it/
                );
                assert.equal(
                    state.currentlyRunningToolCallId,
                    "newer-tool-call",
                    "stall cleanup must not clear a newer tool call's ownership"
                );
                const stalledJob = [...state.backgroundJobs.values()].find(
                    (job) => job.command === "tail -f /dev/null"
                );
                assert.equal(
                    stalledJob?.status,
                    "running",
                    "detached tmux command must keep running, not be killed"
                );
                assert.equal(
                    state.backgroundJobs.size,
                    1,
                    "the detached tmux command must be the only tracked job"
                );
                assert.equal(
                    stalledJob?.isBackgrounded,
                    true,
                    "the detached tmux job must be marked as backgrounded"
                );
                // The window must actually still exist: the detach keeps the
                // in-flight work alive instead of killing the window.
                const tmuxCtx = getTmuxContext(stalledJob);
                assert.ok(tmuxCtx, "detached tmux job must carry its context");
                assert.ok(
                    listWindows(tmuxCtx.session).some(
                        (window) => window.id === tmuxCtx.windowId
                    ),
                    "the detached tmux window must still be alive"
                );
                assert.equal(
                    state.pendingDecisionJobId,
                    undefined,
                    "non-interactive sessions must not arm the job_decide gate"
                );
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

            // The backgrounding notice states the wake guarantee and how to
            // subscribe to events — the agent otherwise has to infer that a
            // successful completion is suppressed until a reminder is linked.
            const noticeText = String(
                (result.content[0] as { text?: string })?.text ?? ""
            );
            assert.ok(
                noticeText.includes(
                    "You will be notified if it fails. To be notified on success too, link a reminder (remind with jobId)."
                ),
                "auto-backgrounded notice must state the failure-only wake guarantee"
            );
            assert.ok(
                noticeText.includes(
                    "To subscribe to events while it runs, use remind with jobId and triggers"
                ),
                "auto-backgrounded notice must include the event-subscription reminder"
            );
            assert.ok(
                noticeText.includes(
                    'triggers: [{type:"outputLines", value: 200}]'
                ),
                "subscription reminder must give a concrete trigger example"
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

        void it("does not let a later abort kill an already-detached tmux window", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            state.nonInteractive = true;
            const { tool } = captureBashTool(state);
            const controller = new AbortController();
            let windowId: string | undefined;

            await withEnv({ PI_TAU_STALL_WAKE_MS: "100" }, async () => {
                const result = await tool.execute(
                    "tc-tmux-detach-then-abort",
                    { command: "tail -f /dev/null" },
                    controller.signal,
                    null,
                    { cwd: TEST_RUN_DIR, ui: stubUi }
                );
                assert.match(
                    (result.content[0] as { text: string }).text,
                    /detached the still-running command to the background instead of killing it/
                );
                const job = [...state.backgroundJobs.values()].find(
                    (candidate) => candidate.isBackgrounded
                );
                assert.ok(job, "detached tmux job must be tracked");
                windowId = getTmuxContext(job)?.windowId;
                assert.ok(
                    windowId,
                    "detached tmux job must carry its window id"
                );

                // The tool call is over; an abort now belongs to a later turn
                // and must not reach back and kill the detached window.
                controller.abort();
            });

            assert.ok(windowId);
            // Give the tmux server a moment to reap the window if the abort did
            // kill it, then require a definitive answer: an inconclusive query
            // (undefined) must not be read as "the window is gone".
            await new Promise((resolve) => setTimeout(resolve, 300));
            await waitFor(
                () => {
                    const windows = queryWindows(
                        sessionNameForGitRoot(TEST_RUN_DIR)
                    );
                    return (
                        windows === undefined ||
                        windows.some((window) => window.id === windowId)
                    );
                },
                3_000,
                "aborting the finished tool call must not kill the detached tmux window"
            );
            assert.equal(
                state.backgroundJobs.size,
                1,
                "the detached job must still be tracked after the abort"
            );
        });

        void it("finalizes a tmux job whose window dies without a sentinel", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            const { tool } = captureBashTool(state);

            await withEnv(
                { PI_TAU_TMUX_LIVENESS_POLL_EVERY: "1" },
                async () => {
                    const result = await tool.execute(
                        "tc-vanished",
                        {
                            command: "tail -f /dev/null",
                            backgroundAfter: 1,
                        },
                        null,
                        null,
                        { cwd: TEST_RUN_DIR, ui: stubUi }
                    );
                    assert.match(
                        String(
                            (result.content[0] as { text?: string })?.text ?? ""
                        ),
                        /Process backgrounded as /
                    );
                    assert.ok(
                        String(
                            (result.content[0] as { text?: string })?.text ?? ""
                        ).includes(
                            "You will be notified if it fails. To be notified on success too, link a reminder (remind with jobId)."
                        ),
                        "auto-backgrounded notice must state the failure-only wake guarantee"
                    );

                    const job = [...state.backgroundJobs.values()].find(
                        (candidate) => candidate.isBackgrounded
                    );
                    assert.ok(job, "backgrounded job must be tracked");
                    const tmuxCtx = getTmuxContext(job);
                    assert.ok(
                        tmuxCtx,
                        "backgrounded tmux job must carry context"
                    );

                    // Kill the window out from under the job without letting
                    // the wrapper script write its exit-code sentinel — the
                    // SIGKILL / kill-window / host-reboot case.
                    execSync(`tmux kill-window -t ${tmuxCtx.windowId}`);

                    // Polling only the sentinel left this job "running"
                    // forever, and `jobs attach` would await a donePromise that
                    // never resolves. It must reach terminal status instead.
                    await waitFor(
                        () => job.status !== "running",
                        10_000,
                        `vanished tmux job ${job.id} must reach terminal status ` +
                            `(got status=${job.status})`
                    );
                    assert.equal(job.status, "failed");
                    assert.equal(
                        job.exitCode,
                        undefined,
                        "a vanished window has no exit code to report"
                    );
                }
            );
        });

        void it("still kills a silent command in an interactive session (tmux)", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            state.nonInteractive = false;
            const { tool } = captureBashTool(state);
            const toolCallId = "tc-tmux-interactive-kill";
            let windowId: string | undefined;

            await withEnv(
                {
                    PI_TAU_STALL_WAKE_MS: "100",
                    PI_TAU_INTERACTIVE_STALL_MARGIN_MS: "0",
                },
                async () => {
                    const execution = tool.execute(
                        toolCallId,
                        {
                            command: "tail -f /dev/null",
                            backgroundAfter: 1,
                        },
                        null,
                        null,
                        { cwd: TEST_RUN_DIR, ui: stubUi }
                    );
                    // Orphan the foreground entry so the background/kill timer
                    // has nothing to act on and the stall watchdog — the
                    // interactive kill arm under test — is what ends it.
                    setTimeout(() => {
                        const job = [...state.backgroundJobs.values()].find(
                            (candidate) => candidate.toolCallId === toolCallId
                        );
                        windowId = job
                            ? getTmuxContext(job)?.windowId
                            : undefined;
                        state.runningProcesses.delete(toolCallId);
                    }, 300);

                    await assert.rejects(
                        execution,
                        /Possibly stuck: no output for 1s\. Killed tmux job/
                    );
                }
            );

            assert.ok(windowId, "the foreground tmux window must have existed");
            assert.equal(
                listWindows(sessionNameForGitRoot(TEST_RUN_DIR)).some(
                    (window) => window.id === windowId
                ),
                false,
                "the interactively stalled tmux window must be killed"
            );
            assert.equal(
                state.backgroundJobs.size,
                0,
                "a killed tmux command must not linger as a tracked job"
            );
            assert.equal(state.runningProcesses.size, 0);
        });

        void it("settles the race after timeout-killing a disallowed command (24.7h stall regression)", async () => {
            const state = new TauState();
            state.tmuxAvailable = true;
            // Force the interactive timer path: under node --test stdin is
            // piped, so construction-time detection may mark nonInteractive.
            state.nonInteractive = false;
            const { tool } = captureBashTool(state);
            const previousBgMs = process.env.PI_TAU_BACKGROUND_AFTER_MS;
            process.env.PI_TAU_BACKGROUND_AFTER_MS = "300";
            try {
                // `sleep ${X:-8}`: basename sleep takes the disallowed kill
                // path, but the shell-expanded duration evades the upfront
                // block — the exact shape that hung the session ~24.7h
                // waiting for a sentinel that a killed tmux window never
                // writes. The killed race arm must settle this in ~300ms,
                // not at the 4-minute stall watchdog.
                const started = Date.now();
                await assert.rejects(
                    tool.execute(
                        "tc-kill-settle",
                        { command: "sleep ${X:-8}" },
                        null,
                        null,
                        { cwd: TEST_RUN_DIR, ui: stubUi }
                    ),
                    /Command killed on timeout \(timeout-disallowed\)/
                );
                const elapsed = Date.now() - started;
                assert.ok(
                    elapsed < 30_000,
                    `killed race settled in ${elapsed}ms; expected well under the 4-min watchdog`
                );
            } finally {
                if (previousBgMs === undefined)
                    delete process.env.PI_TAU_BACKGROUND_AFTER_MS;
                else process.env.PI_TAU_BACKGROUND_AFTER_MS = previousBgMs;
            }
        });
    }
);
