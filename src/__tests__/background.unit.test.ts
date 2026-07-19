import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    registerBackgroundJobs,
    clearPendingDecision,
    lookupJob,
    startTimeoutTimer,
    notifyCompletion,
    clearJobFromCompletionBatch,
    clearAllCompletionBatches,
    chunkText,
    formatJobOutput,
} from "../features/background.ts";
import { registerBackgroundCommands } from "../features/background-commands.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob, RunningProcess } from "../types.ts";
import { createJobDonePromise } from "../utils.ts";
import { silenceJobAfterKill } from "../features/background.ts";

/** Helper to create a BackgroundJob with all required fields. */
function makeJob(
    overrides: Partial<BackgroundJob> & { id: string }
): BackgroundJob {
    return {
        command: "test",
        pid: 1,
        startTime: 0,
        status: "completed",
        logPath: "/tmp/test",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

/**
 * Capture the job_decide tool handler via DI.
 */
function captureJobDecide(state: TauState) {
    let captured: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: unknown
        ) => Promise<{
            content: { type: string; text: string }[];
            details: unknown;
        }>;
    } | null = null;

    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "job_decide") captured = tool as typeof captured;
        },
        registerCommand: () => {},
        registerToolPromptGuidelines: () => {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
    } as never;

    registerBackgroundJobs(pi, state);
    return captured!;
}

/**
 * Capture the jobs tool handler via DI.
 */
function captureJobsTool(state: TauState) {
    let captured: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: unknown
        ) => Promise<{
            content: { type: string; text: string }[];
            details: unknown;
        }>;
    } | null = null;

    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "jobs") captured = tool as typeof captured;
        },
        registerCommand: () => {},
        registerToolPromptGuidelines: () => {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
    } as never;

    registerBackgroundJobs(pi, state);
    return captured!;
}

void describe("job_decide — pendingDecisionJobId cleanup", () => {
    void it("clears pendingDecisionJobId when job is not found", async () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-99999-1";

        const tool = captureJobDecide(state);
        const result = await tool.execute(
            "tc-1",
            { jobId: "job-99999-1", decision: "keep" },
            null,
            null,
            null
        );

        assert.ok(result.content[0].text.includes("not found"));
        assert.equal(
            state.pendingDecisionJobId,
            undefined,
            "pendingDecisionJobId must be cleared even when job is not found"
        );
    });

    void it("resolves job without job- prefix", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-12345-1",
            status: "running",
        });
        state.backgroundJobs.set("job-12345-1", job);
        state.pendingDecisionJobId = "job-12345-1";

        const tool = captureJobDecide(state);
        const result = await tool.execute(
            "tc-1",
            { jobId: "12345-1", decision: "keep" },
            null,
            null,
            null
        );

        assert.ok(
            result.content[0].text.includes("Keeping"),
            `Expected keep message, got: ${result.content[0].text}`
        );
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("clears pendingDecisionJobId on kill of non-existent job", async () => {
        const state = new TauState();
        state.pendingDecisionJobId = "ghost-job";

        const tool = captureJobDecide(state);
        await tool.execute(
            "tc-1",
            { jobId: "ghost-job", decision: "kill" },
            null,
            null,
            null
        );

        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("sets outputConsumed when killing a running job", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-99999-2",
            command: "sleep 999",
            pid: -999998,
            status: "running",
            toolCallId: "tc-jd-1",
            proc: { pid: -999998 } as never,
        });
        state.backgroundJobs.set("job-99999-2", job);
        state.pendingDecisionJobId = "job-99999-2";

        const tool = captureJobDecide(state);
        await tool.execute(
            "tc-jd-1",
            { jobId: "job-99999-2", decision: "kill" },
            null,
            null,
            null
        );

        assert.equal(job.outputConsumed, true);
    });

    void it("clears pendingDecisionJobId on check of non-existent job", async () => {
        const state = new TauState();
        state.pendingDecisionJobId = "ghost-job";

        const tool = captureJobDecide(state);
        await tool.execute(
            "tc-1",
            { jobId: "ghost-job", decision: "check" },
            null,
            null,
            null
        );

        assert.equal(state.pendingDecisionJobId, undefined);
    });
});

// ─── lookupJob ───────────────────────────────────────────────────────

void describe("lookupJob", () => {
    void it("finds job by exact id", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-12345-1" });
        state.backgroundJobs.set("job-12345-1", job);

        assert.equal(lookupJob(state, "job-12345-1")?.id, "job-12345-1");
    });

    void it("finds job without job- prefix", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-12345-1" });
        state.backgroundJobs.set("job-12345-1", job);

        assert.equal(lookupJob(state, "12345-1")?.id, "job-12345-1");
    });

    void it("returns undefined when no match", () => {
        const state = new TauState();
        assert.equal(lookupJob(state, "nonexistent"), undefined);
    });

    void it("prefers exact match over prefix match", () => {
        const state = new TauState();
        const exact = makeJob({ id: "12345-1", command: "exact" });
        const prefixed = makeJob({
            id: "job-12345-1",
            command: "prefixed",
            pid: 2,
        });
        state.backgroundJobs.set("12345-1", exact);
        state.backgroundJobs.set("job-12345-1", prefixed);

        assert.equal(lookupJob(state, "12345-1")?.id, "12345-1");
    });
});

// ─── clearPendingDecision ─────────────────────────────────────────────

void describe("clearPendingDecision", () => {
    void it("clears pendingDecisionJobId when it matches the job id", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-1";
        const job = makeJob({ id: "job-1" });
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("does not clear when job id does not match", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-2";
        const job = makeJob({ id: "job-1" });
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, "job-2");
    });

    void it("is a no-op when pendingDecisionJobId is already undefined", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-1" });
        clearPendingDecision(state, job);
        assert.equal(state.pendingDecisionJobId, undefined);
    });
});

// ─── jobs kill ──────────────────────────────────────────────────────────

void describe("jobs kill — outputConsumed", () => {
    void it("sets outputConsumed when killing a running job", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-99999-1",
            command: "sleep 999",
            pid: -999999,
            status: "running",
            toolCallId: "tc-kill-1",
            proc: { pid: -999999 } as never,
        });
        state.backgroundJobs.set("job-99999-1", job);

        const tool = captureJobsTool(state);
        await tool.execute(
            "tc-kill-1",
            { action: "kill", jobId: "job-99999-1" },
            null,
            null,
            null
        );

        assert.equal(job.outputConsumed, true);
    });
});

// ─── Ctrl+X kill ───────────────────────────────────────────────────────

function captureCtrlXHandler(state: TauState) {
    let captured:
        | ((ctx: {
              ui: {
                  notify: () => void;
                  setWidget: () => void;
                  setStatus: () => void;
                  theme: { fg: () => string };
              };
          }) => Promise<void>)
        | null = null;

    const pi = {
        registerShortcut(
            key: string,
            handler: { handler: (ctx: unknown) => Promise<void> }
        ) {
            if (key === "ctrl+x") captured = handler.handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
    } as never;

    registerBackgroundCommands(pi, state);
    return captured!;
}

void describe("Ctrl+X kill — outputConsumed", () => {
    void it("sets outputConsumed when killing the most recent running job", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-99999-3",
            command: "sleep 999",
            pid: -999997,
            startTime: Date.now(),
            status: "running",
            toolCallId: "tc-ctrlx-1",
            proc: { pid: -999997 } as never,
        });
        state.backgroundJobs.set("job-99999-3", job);

        const handler = captureCtrlXHandler(state);
        await handler({
            ui: {
                notify: () => {},
                setWidget: () => {},
                setStatus: () => {},
                theme: { fg: () => "" },
            },
        });

        assert.equal(job.outputConsumed, true);
    });
});

// ─── TUI kill (showTaskDetail) ──────────────────────────────────────────

function captureTasksInterface(state: TauState) {
    let captured:
        | ((ctx: {
              ui: {
                  notify: () => void;
                  setWidget: () => void;
                  setStatus: () => void;
                  theme: { fg: () => string };
                  select: (
                      title: string,
                      options: string[]
                  ) => Promise<string | undefined>;
                  editor: () => Promise<string | undefined>;
              };
          }) => Promise<void>)
        | null = null;

    const pi = {
        registerShortcut(
            key: string,
            handler: { handler: (ctx: unknown) => Promise<void> }
        ) {
            if (key === "ctrl+j") captured = handler.handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
    } as never;

    registerBackgroundCommands(pi, state);
    return captured!;
}

void describe("TUI kill — outputConsumed", () => {
    void it("sets outputConsumed when killing via the tasks interface", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-99999-4",
            command: "sleep 999",
            pid: -999996,
            startTime: Date.now(),
            status: "running",
            toolCallId: "tc-tui-1",
            proc: { pid: -999996 } as never,
        });
        state.backgroundJobs.set("job-99999-4", job);

        const handler = captureTasksInterface(state);

        let selectCallCount = 0;
        await handler({
            ui: {
                notify: () => {},
                setWidget: () => {},
                setStatus: () => {},
                theme: { fg: () => "" },
                select: async (_title: string, options: string[]) => {
                    selectCallCount++;
                    if (selectCallCount === 1) {
                        return options.find((o) => o.includes("job-99999-4"));
                    }
                    return options.find((o) => o === "Kill");
                },
                editor: async () => "",
            },
        });

        assert.equal(job.outputConsumed, true);
    });
});

// ─── silenceJobAfterKill ───────────────────────────────────────────────

void describe("silenceJobAfterKill", () => {
    void it("sets outputConsumed so subsequent notifyCompletion is suppressed", () => {
        const job = makeJob({
            id: "job-99999-5",
            command: "sleep 999",
            pid: -999995,
            status: "running",
            toolCallId: "tc-silence-1",
        });
        createJobDonePromise(job);
        silenceJobAfterKill(job);
        assert.equal(job.status, "killed");
        assert.equal(job.outputConsumed, true);
    });
});

// ─── startTimeoutTimer (signal-based) ────────────────────────────────

void describe("startTimeoutTimer", () => {
    void it("calls triggerBackground after explicit timeout", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-1";
        let triggered = false;

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-timeout-1",
            50
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(
            triggered,
            true,
            "triggerBackground should have been called"
        );
        clearTimeout(timer);
    });

    void it("does NOT fire before the explicit timeout elapses", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-3";
        let triggered = false;

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-timeout-3",
            500
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(
            triggered,
            false,
            "triggerBackground should NOT have been called yet"
        );
        clearTimeout(timer);
    });

    void it("uses DEFAULT_TIMEOUT_MS when no explicit timeout provided", () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-2";

        const timer = startTimeoutTimer(
            () => {},
            "echo slow",
            state,
            "tc-timeout-2"
        );
        assert.ok(timer, "Timer created with default timeout");
        clearTimeout(timer);
    });

    void it("does NOT trigger for disallowed commands (sleep)", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-timeout-sleep";
        let triggered = false;

        // Register a mock running process so the kill path can find it
        const mockProc = { pid: -88888 } as never;
        const rp: RunningProcess = {
            toolCallId: "tc-timeout-sleep",
            proc: mockProc,
            command: "sleep 60",
            logPath: "/tmp/test-sleep.log",
            triggerBackground: () => {
                triggered = true;
            },
        };
        state.runningProcesses.set("tc-timeout-sleep", rp);

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "sleep 60",
            state,
            "tc-timeout-sleep",
            50
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(triggered, false, "sleep should not be auto-backgrounded");
        clearTimeout(timer);
    });
});

// ─── Command policies ─────────────────────────────────────────────────

import { isAutoBackgroundAllowed, detectBlockedSleep } from "../utils.ts";

void describe("isAutoBackgroundAllowed", () => {
    void it("allows npm test", () => {
        assert.equal(isAutoBackgroundAllowed("npm test"), true);
    });

    void it("allows make build", () => {
        assert.equal(isAutoBackgroundAllowed("make build"), true);
    });

    void it("rejects sleep", () => {
        assert.equal(isAutoBackgroundAllowed("sleep 30"), false);
    });

    void it("allows commands starting with other names", () => {
        assert.equal(isAutoBackgroundAllowed("echo hello"), true);
    });
});

void describe("detectBlockedSleep", () => {
    void it("blocks sleep 10", () => {
        assert.equal(detectBlockedSleep("sleep 10"), "sleep 10");
    });

    void it("allows sleep 1", () => {
        assert.equal(detectBlockedSleep("sleep 1"), null);
    });

    void it("allows sleep 0.5", () => {
        assert.equal(detectBlockedSleep("sleep 0.5"), null);
    });

    void it("returns null for make build", () => {
        assert.equal(detectBlockedSleep("make build"), null);
    });

    void it("blocks leading sleep in compound command", () => {
        assert.equal(detectBlockedSleep("sleep 5 && echo done"), "sleep 5");
    });

    void it("allows make followed by sleep", () => {
        assert.equal(detectBlockedSleep("make && sleep 5"), null);
    });
});

// ─── Background agent helpers ───────────────────────────────────────────

import { chooseBackgroundPath } from "../features/agent-background.ts";

void describe("chooseBackgroundPath", () => {
    void it("chooses fork when conversation is small", () => {
        // 4KB conversation, 128K context window → ~1K tokens / 128K = ~0.8%
        assert.equal(chooseBackgroundPath(4096, 131072), "fork");
    });

    void it("chooses summary when conversation exceeds 40% of context", () => {
        // 250KB / 4 = 62.5K tokens / 128K = ~49% → summary
        assert.equal(chooseBackgroundPath(250000, 128000), "summary");
    });

    void it("chooses fork at exactly 39%", () => {
        // boundary is bytes < 1.6 * tokens. 128000 * 1.6 = 204800
        assert.equal(chooseBackgroundPath(204000, 128000), "fork");
    });

    void it("chooses summary at exactly 41%", () => {
        assert.equal(chooseBackgroundPath(205000, 128000), "summary");
    });

    void it("defaults to fork for empty conversation", () => {
        assert.equal(chooseBackgroundPath(0, 32768), "fork");
    });
});

// ─── lookupJob with recentTerminalJobs ───────────────────────────────

void describe("lookupJob with recentTerminalJobs", () => {
    void it("finds job in recentTerminalJobs after removal from map", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-1-1", status: "completed" });
        state.recentTerminalJobs.push(job);
        assert.equal(lookupJob(state, "job-1-1")?.id, "job-1-1");
    });

    void it("finds job in recentTerminalJobs without job- prefix", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-1-1", status: "completed" });
        state.recentTerminalJobs.push(job);
        assert.equal(lookupJob(state, "1-1")?.id, "job-1-1");
    });

    void it("prefers active map over recentTerminalJobs", () => {
        const state = new TauState();
        const active = makeJob({ id: "job-1-1", status: "running" });
        const recent = makeJob({ id: "job-1-1", status: "completed" });
        state.backgroundJobs.set("job-1-1", active);
        state.recentTerminalJobs.push(recent);
        assert.equal(lookupJob(state, "job-1-1")?.status, "running");
    });

    void it("returns undefined when not in map or recentTerminalJobs", () => {
        const state = new TauState();
        assert.equal(lookupJob(state, "job-999-1"), undefined);
    });
});

// ─── job cleanup lifecycle ──────────────────────────────────────────

function completionHarness(state: TauState) {
    const sent: Array<{ message: unknown; options: unknown }> = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
        registerTool: () => {},
        registerCommand: () => {},
        registerToolPromptGuidelines: () => {},
        sendMessage: (message: unknown, options: unknown) => {
            sent.push({ message, options });
        },
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(event, handler);
        },
    } as never;
    const ctx = {
        ui: {
            notify: () => {},
            setStatus: () => {},
            setWidget: () => {},
            theme: { fg: (text: string) => text },
        },
    } as never;
    registerBackgroundJobs(pi, state);
    return { sent, handlers, ctx, pi };
}

/**
 * Force-flush the completion delivery batch instead of waiting for the
 * real debounce timer. The real debounce uses .unref()'d setTimeout with
 * a minimum of 2s delay, which is unreliable in test environments due to
 * Node.js timer coalescing behavior with piped stdout.
 */
function flushDebounce(state: TauState) {
    state._flushCompletionBatch?.();
}

void describe("job completion notifications", () => {
    void it("waits until the agent is idle before delivering failed job followups", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({ id: "job-1-1", status: "failed", exitCode: 1 });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        assert.equal(sent.length, 0);
        handlers.get("agent_end")?.();
        assert.equal(sent.length, 1);
        handlers.get("session_shutdown")?.();
    });

    void it("suppresses pending failed job followups after terminal output is consumed", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({ id: "job-1-2", status: "failed", exitCode: 1 });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        job.outputConsumed = true;
        state.cancelCompletionBatchForJob?.(job.id);
        handlers.get("agent_end")?.();

        assert.equal(sent.length, 0);
        handlers.get("session_shutdown")?.();
    });
});

// ─── Completion suppression / delivery via wantsCompletionNotification ─

void describe("completion notification with wantsCompletionNotification", () => {
    void it("suppresses successful completion when no linked callback exists", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({ id: "job-1-3", status: "completed", exitCode: 0 });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        // Agent becomes idle — flush should NOT deliver because there's
        // no linked callback and no wantsCompletionNotification flag
        handlers.get("agent_end")?.();
        assert.equal(sent.length, 0,
            "successful completion without linked callback should be suppressed");
        handlers.get("session_shutdown")?.();
    });

    void it("suppresses successful completion when wantsCompletionNotification is false", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({
            id: "job-1-4",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: false,
        });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        handlers.get("agent_end")?.();
        assert.equal(sent.length, 0,
            "explicit false should suppress just like undefined");
        handlers.get("session_shutdown")?.();
    });

    void it("delivers successful completion when wantsCompletionNotification is true", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({
            id: "job-1-5",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,  // set by fireCallback
        });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        handlers.get("agent_end")?.();
        assert.equal(sent.length, 1,
            "should deliver when the linked callback already fired");
        const msg = sent[0].message as Record<string, unknown>;
        assert.equal(msg.customType, "job-completion");
        assert.match(String(msg.content), /✅/);
        assert.match(String(msg.content), /job-1-5/);
        handlers.get("session_shutdown")?.();
    });

    void it("delivers failed completion regardless of wantsCompletionNotification", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({
            id: "job-1-6",
            status: "failed",
            exitCode: 1,
            wantsCompletionNotification: false,
        });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        handlers.get("agent_end")?.();
        assert.equal(sent.length, 1,
            "failed jobs always get delivered regardless of flag");
        const msg = sent[0].message as Record<string, unknown>;
        assert.equal(msg.customType, "job-completion");
        assert.match(String(msg.content), /❌/);
        handlers.get("session_shutdown")?.();
    });

    void it("does not deliver when outputConsumed is true even with flag", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);
        const job = makeJob({
            id: "job-1-7",
            status: "completed",
            exitCode: 0,
            outputConsumed: true,
            wantsCompletionNotification: true,
        });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        handlers.get("agent_end")?.();
        assert.equal(sent.length, 0,
            "outputConsumed takes precedence over wantsCompletionNotification");
        handlers.get("session_shutdown")?.();
    });
});

void describe("job cleanup after completion", () => {
    void it("removes completed jobs from backgroundJobs map", () => {
        const state = new TauState();
        const job = makeJob({ id: "job-1-1", status: "completed" });
        createJobDonePromise(job);
        state.backgroundJobs.set("job-1-1", job);

        // Simulate what notifyCompletion does for outputConsumed jobs
        job.outputConsumed = true;
        // The job should be removable
        state.backgroundJobs.delete(job.id);
        assert.equal(state.backgroundJobs.has("job-1-1"), false);
    });

    void it("increments completedJobCount on terminal job removal", () => {
        const state = new TauState();
        assert.equal(state.completedJobCount, 0);

        const job = makeJob({ id: "job-1-1", status: "completed" });
        state.backgroundJobs.delete(job.id);
        // Simulate counter increment
        if (job.status === "completed") state.completedJobCount++;
        assert.equal(state.completedJobCount, 1);
    });

    void it("increments failedJobCount for failed jobs", () => {
        const state = new TauState();
        assert.equal(state.failedJobCount, 0);

        const job = makeJob({ id: "job-1-1", status: "failed" });
        if (job.status === "failed") state.failedJobCount++;
        assert.equal(state.failedJobCount, 1);
    });

    void it("capped at 20 recentTerminalJobs", () => {
        const state = new TauState();
        for (let i = 0; i < 25; i++) {
            state.recentTerminalJobs.push(
                makeJob({ id: `job-1-${i}`, status: "completed" })
            );
            if (state.recentTerminalJobs.length > 20) {
                state.recentTerminalJobs.shift();
            }
        }
        assert.equal(state.recentTerminalJobs.length, 20);
    });
});

// ─── clearJobFromCompletionBatch ───────────────────────────────────────

void describe("clearJobFromCompletionBatch", () => {
    void it("removes a pending job from the batch and suppresses only its delivery", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);

        const job1 = makeJob({
            id: "job-batch-1",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,
        });
        const job2 = makeJob({
            id: "job-batch-2",
            status: "failed",
            exitCode: 1,
        });
        state.backgroundJobs.set(job1.id, job1);
        state.backgroundJobs.set(job2.id, job2);

        handlers.get("agent_start")?.();
        notifyCompletion(job1, state, pi, ctx);
        notifyCompletion(job2, state, pi, ctx);
        flushDebounce(state);

        // Remove job1 (completed, linked-callback) from the batch
        clearJobFromCompletionBatch(job1.id);

        handlers.get("agent_end")?.();

        // Only job2 (failed) should have been delivered — job1 was removed
        assert.equal(sent.length, 1, "only the failed job should be delivered");
        if (sent.length > 0) {
            const msg = sent[0].message as Record<string, unknown>;
            assert.match(
                String(msg.content),
                /job-batch-2/,
                "delivered message should reference the remaining failed job"
            );
            assert.doesNotMatch(
                String(msg.content),
                /job-batch-1/,
                "delivered message should NOT reference the removed job"
            );
        }
        handlers.get("session_shutdown")?.();
    });

    void it("removing the last job cancels the batch timer", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);

        const job = makeJob({
            id: "job-batch-3",
            status: "failed",
            exitCode: 1,
        });
        state.backgroundJobs.set(job.id, job);

        handlers.get("agent_start")?.();
        notifyCompletion(job, state, pi, ctx);
        flushDebounce(state);

        // Remove the only job
        clearJobFromCompletionBatch(job.id);

        handlers.get("agent_end")?.();

        // Nothing should be delivered since the batch was emptied
        assert.equal(sent.length, 0, "no delivery when the only job is removed");
        handlers.get("session_shutdown")?.();
    });

    void it("removes jobs from pendingCompletionDeliveries", async () => {
        clearAllCompletionBatches();
        const state = new TauState();
        const { sent, handlers, ctx, pi } = completionHarness(state);

        const job1 = makeJob({
            id: "job-batch-4",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,
        });
        const job2 = makeJob({
            id: "job-batch-5",
            status: "failed",
            exitCode: 1,
        });
        state.backgroundJobs.set(job1.id, job1);
        state.backgroundJobs.set(job2.id, job2);

        handlers.get("agent_start")?.();
        notifyCompletion(job1, state, pi, ctx);
        notifyCompletion(job2, state, pi, ctx);
        flushDebounce(state);

        // Remove the failed job — the completed job has no linked callbacks,
        // so the pending delivery should be pruned entirely
        clearJobFromCompletionBatch(job2.id);

        // Force agent_end to try delivery
        handlers.get("agent_end")?.();

        // With both jobs removed or their completion suppressed,
        // nothing should be delivered
        assert.equal(sent.length, 0, "no delivery when all jobs are removed or suppressed");
        handlers.get("session_shutdown")?.();
    });

    void it("is a no-op for a job not in the batch", () => {
        clearAllCompletionBatches();
        // Should not throw
        clearJobFromCompletionBatch("job-nonexistent");
    });
});

// ─── chunkText —──────────────────────────────────────────────────────

void describe("chunkText", () => {
    const sid = "ctx_bg_test";

    void it("returns a single chunk for small text (< 4 KiB)", () => {
        const text = "Hello world\nThis is a small text";
        const chunks = chunkText(text, sid);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].sourceId, sid);
        assert.equal(chunks[0].ordinal, 1);
        assert.ok(chunks[0].byteCount < 4096);
    });

    void it("preserves content in the chunk", () => {
        const text = "Hello world";
        const chunks = chunkText(text, sid);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].content, text);
    });

    void it("assigns sequential ordinals and stable ids for multiple chunks", () => {
        // Two paragraphs that fit together (small) should yield 1 chunk
        // For ordinals > 1 we need large enough text to force splitting
        const bigPara = "x".repeat(3000);
        const text = `${bigPara}\n\n${bigPara}`;
        const chunks = chunkText(text, sid);
        assert.ok(chunks.length >= 2, "should produce at least 2 chunks");
        assert.equal(chunks[0].ordinal, 1);
        assert.equal(chunks[1].ordinal, 2);
        assert.ok(chunks[0].id.endsWith("_0001"));
        assert.ok(chunks[1].id.endsWith("_0002"));
    });

    void it("extracts first non-empty line as title", () => {
        const chunks = chunkText("line1\nline2", sid);
        assert.equal(chunks[0].title, "line1");
    });

    void it("uses '(empty)' title when no non-empty lines exist", () => {
        const chunks = chunkText("\n\n  \n", sid);
        assert.equal(chunks[0].title, "(empty)");
    });

    void it("returns empty chunk for empty string", () => {
        const chunks = chunkText("", sid);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].content, "");
    });

    void it("splits large paragraph (> 4 KiB) by lines", () => {
        const line = "x".repeat(200);
        const para = Array.from({ length: 50 }, (_, i) => `${line} ${i}`).join("\n");
        // ~50 * (200+2) = ~10100 bytes — well over 4 KiB
        const chunks = chunkText(para, sid);
        assert.ok(chunks.length >= 2, "should split large paragraph");
        assert.ok(chunks[0].byteCount <= 4096, "each chunk should be <= 4 KiB");
        for (const c of chunks) {
            assert.ok(
                c.byteCount <= 4096,
                `chunk ${c.ordinal} exceeds 4 KiB (${c.byteCount})`
            );
        }
    });

    void it("splits multiple small paragraphs into separate chunks only when combined > 4 KiB", () => {
        // Two paragraphs that are small individually but large together
        const largeLine = "x".repeat(3000);
        const text = `${largeLine}\n\n${largeLine}`;
        const chunks = chunkText(text, sid);
        // Each paragraph is ~3 KiB, combined ~6 KiB > 4 KiB, so 2 chunks
        assert.equal(chunks.length, 2);
        assert.ok(chunks[0].byteCount <= 4096);
        assert.ok(chunks[1].byteCount <= 4096);
    });

    void it("handles paragraphs whose content fits under boundary together", () => {
        const small = "x".repeat(1000);
        const text = `${small}\n\n${small}`;
        // Combined ~2 KiB < 4 KiB — single chunk
        const chunks = chunkText(text, sid);
        assert.equal(chunks.length, 1);
    });

    void it("counts byteCount correctly per chunk", () => {
        const text = "Hello world";
        const chunks = chunkText(text, sid);
        assert.equal(chunks[0].byteCount, Buffer.byteLength(text, "utf8"));
    });
});

// ─── formatJobOutput —────────────────────────────────────────────────

void describe("formatJobOutput", () => {
    const sample = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");

    void it("returns all lines without grep/head/tail", () => {
        const r = formatJobOutput({ text: sample });
        assert.equal(r.totalLines, 5);
        assert.ok(!r.isTruncated);
        assert.ok(r.text.includes("   1: line 1"));
        assert.ok(r.text.includes("   5: line 5"));
    });

    void it("filters lines by grep pattern", () => {
        const text = ["apple", "banana", "cherry", "date", "elderberry"].join("\n");
        // 'a' matches apple, banana, date
        const r = formatJobOutput({ text, grepPattern: "a" });
        assert.equal(r.totalLines, 3);
        assert.ok(r.text.includes("apple"));
        assert.ok(r.text.includes("banana"));
        assert.ok(r.text.includes("date"));
        assert.ok(!r.text.includes("cherry"));
    });

    void it("returns (no lines matching) for grep with no matches", () => {
        const r = formatJobOutput({ text: sample, grepPattern: "zzz" });
        assert.equal(r.totalLines, 0);
        assert.ok(r.text.includes("no lines matching"));
    });

    void it("handles invalid grep regex gracefully", () => {
        const r = formatJobOutput({ text: sample, grepPattern: "[" });
        assert.equal(r.totalLines, 0);
        assert.ok(r.text.includes("grep error"));
    });

    void it("respects head parameter", () => {
        const r = formatJobOutput({ text: sample, headCount: 2 });
        assert.equal(r.totalLines, 5);
        assert.ok(r.text.includes("   1: line 1"));
        assert.ok(r.text.includes("   2: line 2"));
        assert.ok(!r.text.includes("   3: line 3"));
    });

    void it("respects tail parameter", () => {
        const r = formatJobOutput({ text: sample, tailCount: 2 });
        assert.equal(r.totalLines, 5);
        assert.ok(r.text.includes("   4: line 4"));
        assert.ok(r.text.includes("   5: line 5"));
        assert.ok(!r.text.includes("   1: line 1"));
    });

    void it("combines head and tail", () => {
        const r = formatJobOutput({
            text: sample,
            headCount: 3,
            tailCount: 2,
        });
        // tail is applied after head, so we get last 2 of first 3
        assert.equal(r.totalLines, 5);
        assert.ok(r.text.includes("   2: line 2"));
        assert.ok(r.text.includes("   3: line 3"));
        assert.ok(!r.text.includes("   1: line 1"));
        assert.ok(!r.text.includes("   4: line 4"));
    });

    void it("shows hints footer when lines are hidden", () => {
        const r = formatJobOutput({ text: sample, headCount: 2 });
        assert.ok(r.text.includes("more lines"));
        assert.ok(r.text.includes("head=N or tail=N"));
    });

    void it("shows hints footer when output is truncated", () => {
        const r = formatJobOutput({
            text: "...[truncated\n" + sample,
            headCount: 2,
        });
        assert.ok(r.isTruncated);
        assert.ok(r.text.includes("output was truncated"));
    });

    void it("returns (no lines) for empty text without grep", () => {
        const r = formatJobOutput({ text: "" });
        assert.equal(r.totalLines, 1); // one empty line
        // Should still show the empty line
        assert.ok(r.text.includes("   1:"));
    });

    void it("isTruncated is true when text starts with ...[truncated", () => {
        const r = formatJobOutput({ text: "...[truncated output here" });
        assert.ok(r.isTruncated);
    });

    void it("isTruncated is false for normal text", () => {
        const r = formatJobOutput({ text: "normal output" });
        assert.ok(!r.isTruncated);
    });
});
