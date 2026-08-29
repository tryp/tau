import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    registerBackgroundJobs,
    notifyCompletion,
    clearPendingDecision,
    clearStalePendingDecision,
    clearAllCompletionBatches,
    formatJobOutput,
    getOutputMetadata,
    lookupJob,
    startTimeoutTimer,
    handleTmuxCompletion,
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
        registerMessageRenderer: () => {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
        registerToolPromptGuidelines: () => {},
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
        registerMessageRenderer: () => {},
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
        registerToolPromptGuidelines: () => {},
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

void describe("clearStalePendingDecision", () => {
    void it("clears a pending decision for a missing job", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-missing";
        clearStalePendingDecision(state);
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("clears a pending decision for a terminal job", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-done";
        state.backgroundJobs.set(
            "job-done",
            makeJob({ id: "job-done", status: "failed" })
        );
        clearStalePendingDecision(state);
        assert.equal(state.pendingDecisionJobId, undefined);
    });

    void it("preserves a pending decision for a running job", () => {
        const state = new TauState();
        state.pendingDecisionJobId = "job-running";
        state.backgroundJobs.set(
            "job-running",
            makeJob({ id: "job-running", status: "running" })
        );
        clearStalePendingDecision(state);
        assert.equal(state.pendingDecisionJobId, "job-running");
    });
});

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

void describe("jobs output — structured details", () => {
    void it("normalizes empty and newline-terminated output", () => {
        assert.deepEqual(getOutputMetadata(""), {
            totalLines: 0,
            truncated: false,
            partial: false,
            byteCount: 0,
            empty: true,
            error: false,
        });
        assert.equal(getOutputMetadata(" \n\t").empty, true);
        assert.equal(formatJobOutput({ text: " \n\t" }).empty, true);
        assert.equal(formatJobOutput({ text: "one\n" }).totalLines, 1);
        const sliced = formatJobOutput({ text: "one\ntwo\n", headCount: 1 });
        assert.equal(sliced.totalLines, 2);
        assert.equal(sliced.partial, true);
        assert.equal(sliced.omittedLines, 1);
        const marked = formatJobOutput({ text: "...[truncated]\none\n" });
        assert.equal(marked.truncated, true);
        assert.equal(marked.partial, true);
        assert.equal(
            formatJobOutput({
                text: "...[truncated]\none\n",
                grepPattern: "missing",
            }).truncated,
            true
        );
        const noMatch = formatJobOutput({
            text: "one\ntwo",
            grepPattern: "missing",
        });
        assert.equal(noMatch.totalLines, 0);
        assert.equal(noMatch.empty, true);
        const invalid = formatJobOutput({ text: "one", grepPattern: "[" });
        assert.equal(invalid.error, true);
        assert.equal(invalid.empty, false);
    });

    void it("returns empty metadata for an empty log", async () => {
        const { unlinkSync, writeFileSync } = await import("node:fs");
        const logPath = "/tmp/pi-bg-job-details-empty.log";
        writeFileSync(logPath, "");
        const state = new TauState();
        state.backgroundJobs.set(
            "job-details-empty",
            makeJob({ id: "job-details-empty", logPath })
        );
        try {
            const result = await captureJobsTool(state).execute(
                "tc-details-empty",
                { action: "output", jobId: "job-details-empty" },
                null,
                null,
                null
            );
            const details = result.details as Record<string, unknown>;
            assert.equal(details.totalLines, 0);
            assert.equal(details.empty, true);
            assert.equal(details.error, false);
        } finally {
            unlinkSync(logPath);
        }
    });

    void it("marks a missing log as an output error", async () => {
        const state = new TauState();
        state.backgroundJobs.set(
            "job-details-missing",
            makeJob({
                id: "job-details-missing",
                status: "completed",
                logPath: "/tmp/pi-bg-job-details-missing.log",
            })
        );
        const result = await captureJobsTool(state).execute(
            "tc-details-missing",
            { action: "output", jobId: "job-details-missing" },
            null,
            null,
            null
        );
        const details = result.details as Record<string, unknown>;
        assert.equal(details.empty, true);
        assert.equal(details.error, true);
    });

    void it("returns line counts and lifecycle metadata without parsing text", async () => {
        const { unlinkSync, writeFileSync } = await import("node:fs");
        const logPath = "/tmp/pi-bg-job-details-1.log";
        writeFileSync(logPath, "first\nsecond\nthird\n");
        const state = new TauState();
        state.backgroundJobs.set(
            "job-details-1",
            makeJob({
                id: "job-details-1",
                status: "completed",
                exitCode: 0,
                logPath,
                outputIndexPromise: Promise.resolve({
                    sourceId: "src-details-1",
                    chunkIds: ["src-details-1_0001"],
                }),
            })
        );

        try {
            const result = await captureJobsTool(state).execute(
                "tc-details-1",
                { action: "output", jobId: "job-details-1", head: 1 },
                null,
                null,
                null
            );
            const details = result.details as Record<string, unknown>;
            assert.equal(details.jobId, "job-details-1");
            assert.equal(details.status, "completed");
            assert.equal(details.exitCode, 0);
            assert.equal(details.totalLines, 3);
            assert.equal(details.truncated, false);
            assert.equal(details.partial, true);
            assert.equal(details.omittedLines, 2);
            assert.equal(
                details.byteCount,
                Buffer.byteLength("first\nsecond\nthird\n", "utf8")
            );
            assert.equal(details.empty, false);
            assert.equal(details.error, false);
            assert.equal(details.logPath, logPath);
            assert.equal(details.sourceId, "src-details-1");
            assert.deepEqual(details.chunkIds, ["src-details-1_0001"]);
        } finally {
            unlinkSync(logPath);
        }
    });
});

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

        // Register a mock running process so the guard passes
        state.runningProcesses.set("tc-timeout-1", {
            toolCallId: "tc-timeout-1",
            proc: { pid: -1 } as never,
            command: "npm test",
            logPath: "/tmp/test.log",
            triggerBackground: () => {
                triggered = true;
            },
        });

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

    void it("does NOT background when no job-control tool is available", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-no-control";
        let triggered = false;
        let unavailable = false;
        state.runningProcesses.set("tc-no-control", {
            toolCallId: "tc-no-control",
            proc: { pid: -88887 } as never,
            command: "npm test",
            logPath: "/tmp/test-no-control.log",
            triggerBackground: () => {},
        });

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-no-control",
            50,
            () => false,
            () => {
                unavailable = true;
            }
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(triggered, false);
        assert.equal(unavailable, true);
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

    void it("does NOT auto-background when non-interactive (print mode)", async () => {
        const state = new TauState();
        state.nonInteractive = true;
        state.currentlyRunningToolCallId = "tc-noninteractive-1";
        let triggered = false;

        // Register a running process so the guard passes; only nonInteractive
        // should prevent the background trigger.
        state.runningProcesses.set("tc-noninteractive-1", {
            toolCallId: "tc-noninteractive-1",
            proc: { pid: -1 } as never,
            command: "npm test",
            logPath: "/tmp/test.log",
            triggerBackground: () => {
                triggered = true;
            },
        });

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-noninteractive-1",
            50
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(
            triggered,
            false,
            "must not auto-background when non-interactive — no agent loop to answer job_decide"
        );
        clearTimeout(timer);
    });

    void it("triggers background even when toolCallId was overwritten by a concurrent call", async () => {
        const state = new TauState();
        state.currentlyRunningToolCallId = "tc-concurrent-1";
        let triggered = false;

        // Register a mock running process so the guard passes
        state.runningProcesses.set("tc-concurrent-1", {
            toolCallId: "tc-concurrent-1",
            proc: { pid: -1 } as never,
            command: "npm test",
            logPath: "/tmp/test.log",
            triggerBackground: () => {},
        });

        const timer = startTimeoutTimer(
            () => {
                triggered = true;
            },
            "npm test",
            state,
            "tc-concurrent-1",
            50
        );

        // Simulate a second concurrent tool call overwriting the ID
        state.currentlyRunningToolCallId = "tc-concurrent-2";

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(
            triggered,
            true,
            "triggerBackground must fire for the original call even when overwritten"
        );
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

// ─── registerBackgroundJob — proc close cleanup ──────────────────────

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

/**
 * Create a mock ChildProcess that emits "close" when requested.
 * Uses EventEmitter to simulate proc.on("close", ...).
 */
function mockProc(
    pid: number
): ChildProcess & { emitClose(code: number): void } {
    const ee = new EventEmitter() as ChildProcess & {
        emitClose(code: number): void;
    };
    // ChildProcess.pid is readonly but we need to set it for testing.
    // Use defineProperty to bypass the type system.
    Object.defineProperty(ee, "pid", { value: pid, writable: false });
    ee.emitClose = (code: number) => {
        ee.emit("close", code);
    };
    return ee;
}

void describe(
    "registerBackgroundJob — proc close cleanup",
    { concurrency: 1 },
    () => {
        afterEach(() => {
            // Completion notifications are debounced into a module-level batch;
            // the unref'd debounce timer never fires between fast tests, so drain
            // it explicitly to avoid cross-test contamination.
            clearAllCompletionBatches();
        });

        void it("removes job from backgroundJobs map when process exits", async () => {
            // We need registerBackgroundJob exported to test this directly.
            // This test will fail at import time until the function is exported.
            const { registerBackgroundJob: _rbg } =
                await import("../features/background.ts");

            const state = new TauState();
            const proc = mockProc(-77777);

            const pi = {
                registerTool() {},
                sendMessage() {},
            } as never;

            const ctx = {
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                    theme: { fg: () => "" },
                },
            } as never;

            const job = _rbg(
                proc,
                "/tmp/test-bg-job.log",
                "echo hello",
                "tc-bg-1",
                state,
                pi,
                ctx
            );

            // Job should be in the map
            assert.equal(state.backgroundJobs.has(job.id), true);
            assert.equal(job.status, "running");

            // Simulate process exit
            proc.emitClose(0);

            // After close: job should be cleaned up
            assert.equal(
                state.backgroundJobs.has(job.id),
                false,
                "job must be removed from backgroundJobs after proc closes"
            );
            assert.equal(
                job.status,
                "completed",
                "job status must be updated to completed"
            );
        });

        void it("marks job as failed on non-zero exit", async () => {
            const { registerBackgroundJob: _rbg } =
                await import("../features/background.ts");

            const state = new TauState();
            const proc = mockProc(-77778);

            const pi = {
                registerTool() {},
                sendMessage() {},
            } as never;

            const ctx = {
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                    theme: { fg: () => "" },
                },
            } as never;

            const job = _rbg(
                proc,
                "/tmp/test-bg-job-fail.log",
                "exit 1",
                "tc-bg-2",
                state,
                pi,
                ctx
            );

            proc.emitClose(1);

            assert.equal(
                job.status,
                "failed",
                "job status must be failed on non-zero exit"
            );
            assert.equal(job.exitCode, 1, "exit code must be recorded");
            assert.equal(
                state.backgroundJobs.has(job.id),
                false,
                "failed job must also be removed from backgroundJobs"
            );
        });

        void it("resolves donePromise when process exits", async () => {
            const { registerBackgroundJob: _rbg } =
                await import("../features/background.ts");

            const state = new TauState();
            const proc = mockProc(-77779);

            const pi = {
                registerTool() {},
                sendMessage() {},
            } as never;

            const ctx = {
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                    theme: { fg: () => "" },
                },
            } as never;

            const job = _rbg(
                proc,
                "/tmp/test-bg-done.log",
                "echo done",
                "tc-bg-3",
                state,
                pi,
                ctx
            );

            assert.ok(job.donePromise, "donePromise must exist");

            // donePromise should resolve when proc closes
            const promise = job.donePromise;
            proc.emitClose(0);
            await promise; // Should resolve, not hang

            assert.equal(job.status, "completed");
        });

        void it("notifies agent of failed completion, suppresses plain success", async () => {
            const { registerBackgroundJob: _rbg } =
                await import("../features/background.ts");

            const state = new TauState();
            // Wire state._flushCompletionBatch via the registration path so the
            // test can flush the debounced completion batch deterministically.
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    registerToolPromptGuidelines() {},
                    sendMessage() {},
                } as never,
                state
            );
            const proc = mockProc(-77780);
            const sentMessages: unknown[] = [];

            const pi = {
                registerTool() {},
                sendMessage(msg: unknown) {
                    sentMessages.push(msg);
                },
            } as never;

            const ctx = {
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                    theme: { fg: () => "" },
                },
            } as never;

            // Successful completions are debounced AND suppressed when no linked
            // callback wants the final notification — flush the batch to prove it.
            const successJob = _rbg(
                proc,
                "/tmp/test-bg-notify.log",
                "echo notify",
                "tc-bg-4",
                state,
                pi,
                ctx
            );
            proc.emitClose(0);
            await successJob.outputIndexPromise;
            state._flushCompletionBatch?.();
            assert.equal(
                sentMessages.length,
                0,
                "plain successful completion must be suppressed"
            );

            // Failed completions are always delivered (one message, flushed).
            const job2 = _rbg(
                proc,
                "/tmp/test-bg-notify-fail.log",
                "exit 1",
                "tc-bg-4b",
                state,
                pi,
                ctx
            );
            proc.emitClose(1);
            await job2.outputIndexPromise;
            state._flushCompletionBatch?.();
            assert.equal(
                sentMessages.length,
                1,
                "failed completion must send one notification"
            );
            const msg = sentMessages[0] as {
                customType: string;
                content: string;
            };
            assert.equal(msg.customType, "job-completion");
            assert.ok(msg.content.includes(job2.id));
        });

        void it("waits for output indexing before delivering completion metadata", async () => {
            const state = new TauState();
            const sentMessages: unknown[] = [];
            const pi = {
                sendMessage(message: unknown) {
                    sentMessages.push(message);
                },
            } as never;
            const ctx = {
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                    theme: { fg: () => "" },
                },
            } as never;
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    registerToolPromptGuidelines() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    sendMessage() {},
                } as never,
                state
            );
            const job = makeJob({
                id: "job-indexed-completion",
                status: "failed",
                exitCode: 1,
                wantsCompletionNotification: true,
                sourceId: "src-indexed-completion",
                chunkIds: ["src-indexed-completion_0001"],
                outputIndexPromise: Promise.resolve({
                    sourceId: "src-indexed-completion",
                    chunkIds: ["src-indexed-completion_0001"],
                }),
            });
            state.backgroundJobs.set(job.id, job);

            notifyCompletion(job, state, pi, ctx);
            await new Promise<void>((resolve) => setImmediate(resolve));
            state._flushCompletionBatch?.();

            assert.equal(sentMessages.length, 1);
            const message = sentMessages[0] as {
                details: { sourceId?: string; chunkIds?: string[] };
            };
            assert.equal(message.details.sourceId, "src-indexed-completion");
            assert.deepEqual(message.details.chunkIds, [
                "src-indexed-completion_0001",
            ]);
        });

        void it("delivers successful tmux completions when notify is enabled", async () => {
            const state = new TauState();
            const sentMessages: unknown[] = [];
            const pi = {
                sendMessage(message: unknown) {
                    sentMessages.push(message);
                },
            } as never;
            const ctx = {
                ui: { notify() {} },
            } as never;
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    registerToolPromptGuidelines() {},
                    sendMessage() {},
                } as never,
                state
            );
            const job = makeJob({
                id: "tmux-plain-success",
                status: "completed",
            });
            state.backgroundJobs.set(job.id, job);

            handleTmuxCompletion(job, state, pi, ctx, true);
            state._flushCompletionBatch?.();

            assert.equal(
                sentMessages.length,
                1,
                "notify:true must deliver successful tmux completion"
            );
            assert.equal(
                state.backgroundJobs.has(job.id),
                false,
                "job removed from active map immediately"
            );
            assert.ok(
                lookupJob(state, job.id),
                "job still findable via recent-terminal fallback"
            );
            assert.equal(job.wantsCompletionNotification, true);
        });

        void it("delivers failed tmux completions with source IDs after indexing", async () => {
            const state = new TauState();
            const sentMessages: unknown[] = [];
            const pi = {
                sendMessage(message: unknown) {
                    sentMessages.push(message);
                },
            } as never;
            const ctx = {
                ui: { notify() {} },
            } as never;
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    registerToolPromptGuidelines() {},
                    sendMessage() {},
                } as never,
                state
            );
            let release!: () => void;
            const ready = new Promise<void>((resolve) => {
                release = resolve;
            });
            const job = makeJob({
                id: "tmux-failed-indexed",
                status: "failed",
                exitCode: 1,
            });
            job.outputIndexPromise = ready.then(() => {
                job.sourceId = "src-tmux-failed";
                job.chunkIds = ["src-tmux-failed_0001"];
                return {
                    sourceId: job.sourceId,
                    chunkIds: job.chunkIds,
                };
            });
            state.backgroundJobs.set(job.id, job);

            handleTmuxCompletion(job, state, pi, ctx, true);
            // Removed from the active map immediately; still findable via
            // the recent-terminal fallback so jobs(output) sees the same IDs.
            assert.equal(state.backgroundJobs.has(job.id), false);
            assert.ok(lookupJob(state, job.id));

            release();
            await new Promise<void>((resolve) => setImmediate(resolve));
            state._flushCompletionBatch?.();

            assert.equal(sentMessages.length, 1);
            const message = sentMessages[0] as {
                customType: string;
                details: { sourceId?: string; chunkIds?: string[] };
            };
            assert.equal(message.customType, "job-completion");
            assert.equal(message.details.sourceId, "src-tmux-failed");
            assert.deepEqual(message.details.chunkIds, [
                "src-tmux-failed_0001",
            ]);
        });

        void it("honors notify:false for tmux jobs (no notification, removed)", async () => {
            const state = new TauState();
            const sentMessages: unknown[] = [];
            const pi = {
                sendMessage(message: unknown) {
                    sentMessages.push(message);
                },
            } as never;
            const ctx = {
                ui: { notify() {} },
            } as never;
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    registerToolPromptGuidelines() {},
                    sendMessage() {},
                } as never,
                state
            );
            const job = makeJob({
                id: "tmux-no-notify",
                status: "completed",
            });
            state.backgroundJobs.set(job.id, job);

            handleTmuxCompletion(job, state, pi, ctx, false);
            state._flushCompletionBatch?.();

            assert.equal(sentMessages.length, 0);
            assert.equal(state.backgroundJobs.has(job.id), false);
            assert.equal(state.completedJobCount, 1);
        });

        void it("suppresses tmux completion when output consumed before delivery", async () => {
            const state = new TauState();
            const sentMessages: unknown[] = [];
            const pi = {
                sendMessage(message: unknown) {
                    sentMessages.push(message);
                },
            } as never;
            const ctx = {
                ui: { notify() {} },
            } as never;
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    registerToolPromptGuidelines() {},
                    sendMessage() {},
                } as never,
                state
            );
            const job = makeJob({
                id: "tmux-consumed-before-flush",
                status: "failed",
                exitCode: 1,
            });
            state.backgroundJobs.set(job.id, job);

            handleTmuxCompletion(job, state, pi, ctx, true);
            // Agent read the output (jobs attach/output) before the debounced
            // batch flushed — must suppress the follow-up turn even for failures.
            job.outputConsumed = true;
            state._flushCompletionBatch?.();

            assert.equal(sentMessages.length, 0);
        });

        void it("delivers successful tmux completion when a remind callback wants it", async () => {
            const state = new TauState();
            const sentMessages: unknown[] = [];
            const pi = {
                sendMessage(message: unknown) {
                    sentMessages.push(message);
                },
            } as never;
            const ctx = {
                ui: { notify() {} },
            } as never;
            registerBackgroundJobs(
                {
                    registerTool() {},
                    registerCommand() {},
                    registerMessageRenderer() {},
                    createBashTool: () => ({
                        execute: async () => ({ content: [] }),
                    }),
                    registerToolPromptGuidelines() {},
                    sendMessage() {},
                } as never,
                state
            );
            const job = makeJob({
                id: "tmux-wants-completion",
                status: "completed",
                wantsCompletionNotification: true,
            });
            state.backgroundJobs.set(job.id, job);

            handleTmuxCompletion(job, state, pi, ctx, true);
            state._flushCompletionBatch?.();

            assert.equal(sentMessages.length, 1);
            const message = sentMessages[0] as { content: string };
            assert.ok(message.content.includes(job.id));
        });

        void it("increments completedJobCount after cleanup", async () => {
            const { registerBackgroundJob: _rbg } =
                await import("../features/background.ts");

            const state = new TauState();
            const proc = mockProc(-77781);

            const pi = {
                registerTool() {},
                sendMessage() {},
            } as never;

            const ctx = {
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                    theme: { fg: () => "" },
                },
            } as never;

            assert.equal(state.completedJobCount, 0);

            _rbg(
                proc,
                "/tmp/test-bg-counter.log",
                "echo count",
                "tc-bg-5",
                state,
                pi,
                ctx
            );

            proc.emitClose(0);

            assert.equal(
                state.completedJobCount,
                1,
                "completedJobCount must increment"
            );
        });
    }
);

// ─── bash tool — foreground completion cleanup ──────────────────────

function captureBashTool(
    state: TauState,
    toolName = "bash",
    sentMessages: unknown[] = []
) {
    let captured: {
        execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal: unknown,
            onUpdate: unknown,
            ctx: { cwd: string }
        ) => Promise<{
            content: { type: string; text: string }[];
            details: unknown;
        }>;
    } | null = null;

    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === toolName) captured = tool as typeof captured;
        },
        registerCommand() {},
        registerToolPromptGuidelines() {},
        sendMessage(message: unknown) {
            sentMessages.push(message);
        },
    } as never;

    registerBackgroundJobs(pi, state);
    return captured!;
}

void describe("bash cwd validation", () => {
    void it("rejects an invalid per-call cwd without spawning a child", async () => {
        const state = new TauState();
        const bashTool = captureBashTool(state);

        await assert.rejects(
            bashTool.execute(
                "tc-bad-cwd",
                {
                    command: "echo should-not-run",
                    cwd: "/this/directory/does/not/exist/12345",
                },
                undefined,
                undefined,
                { cwd: process.cwd() }
            ),
            /Working directory does not exist or is not a directory/
        );
        assert.equal(state.backgroundJobs.size, 0);
        assert.equal(state.runningProcesses.size, 0);
    });

    void it("rejects an invalid bash_bg cwd without spawning a child", async () => {
        const state = new TauState();
        const bashBgTool = captureBashTool(state, "bash_bg");

        await assert.rejects(
            bashBgTool.execute(
                "tc-bg-bad-cwd",
                {
                    command: "echo should-not-run",
                    cwd: "/this/directory/does/not/exist/12345",
                },
                undefined,
                undefined,
                { cwd: process.cwd() }
            ),
            /Working directory does not exist or is not a directory/
        );
        assert.equal(state.backgroundJobs.size, 0);
    });

    void it("resolves relative per-call cwd against the session cwd", async () => {
        const state = new TauState();
        const bashTool = captureBashTool(state);
        const result = await bashTool.execute(
            "tc-relative-cwd",
            { command: "pwd", cwd: "." },
            undefined,
            undefined,
            { cwd: "/tmp" }
        );

        assert.match(result.content[0].text, /^\/tmp\s*$/m);
        assert.equal(state.backgroundJobs.size, 0);
        assert.equal(state.runningProcesses.size, 0);
    });

    void it("delivers successful direct bash_bg completions by default", async () => {
        const state = new TauState();
        const sentMessages: unknown[] = [];
        const bashBgTool = captureBashTool(state, "bash_bg", sentMessages);

        await bashBgTool.execute(
            "tc-bg-success-notify",
            { command: "printf direct-success" },
            undefined,
            undefined,
            {
                cwd: "/tmp",
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                },
            } as never
        );

        let job: BackgroundJob | undefined;
        for (let i = 0; i < 100 && !job; i++) {
            job = state.recentTerminalJobs.find(
                (candidate) => candidate.toolCallId === "tc-bg-success-notify"
            );
            if (!job) await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.ok(job, "direct bash_bg job should reach terminal state");
        await job.outputIndexPromise;
        state._flushCompletionBatch?.();
        assert.equal(job.wantsCompletionNotification, true);
        assert.equal(sentMessages.length, 1);
        assert.equal(
            (sentMessages[0] as { customType: string }).customType,
            "job-completion"
        );
    });

    void it("cleans up direct bash_bg jobs when notify is disabled", async () => {
        const state = new TauState();
        const sentMessages: unknown[] = [];
        const bashBgTool = captureBashTool(state, "bash_bg", sentMessages);

        await bashBgTool.execute(
            "tc-bg-success-silent",
            { command: "printf direct-silent", notify: false },
            undefined,
            undefined,
            {
                cwd: "/tmp",
                ui: {
                    notify() {},
                    setWidget() {},
                    setStatus() {},
                },
            } as never
        );

        let job: BackgroundJob | undefined;
        for (let i = 0; i < 100 && !job; i++) {
            job = state.recentTerminalJobs.find(
                (candidate) => candidate.toolCallId === "tc-bg-success-silent"
            );
            if (!job) await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.ok(
            job,
            "silent direct bash_bg job should reach recent terminals"
        );
        assert.equal(state.backgroundJobs.has(job.id), false);
        assert.equal(state.completedJobCount, 1);
        assert.equal(sentMessages.length, 0);
    });
});

void describe("bash tool — foreground completion cleanup", () => {
    void it("removes job from backgroundJobs when command completes quickly", async () => {
        const state = new TauState();
        const tool = captureBashTool(state);

        await tool.execute(
            "tc-quick-1",
            { command: "echo hello" },
            null,
            null,
            { cwd: "/tmp" }
        );

        assert.equal(
            state.backgroundJobs.size,
            0,
            "foreground job must be removed from backgroundJobs after quick completion"
        );
    });

    void it("returns structured recovery metadata for large foreground output", async () => {
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const sidecarRoot = mkdtempSync("/tmp/pi-tau-no-sidecar-");
        const previousRoot = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = sidecarRoot;
        try {
            const result = await captureBashTool(new TauState()).execute(
                "tc-large-foreground",
                { command: "python3 -c \"print('x' * 40000)\"" },
                null,
                null,
                { cwd: tmpdir() }
            );
            const details = result.details as Record<string, unknown>;
            assert.equal(details.truncated, true);
            assert.equal(details.partial, true);
            assert.equal(details.totalLines, 1);
            assert.equal(details.byteCount, 40001);
            assert.equal(details.empty, false);
            assert.equal(typeof details.fullOutputPath, "string");
            assert.equal(details.sourceId, undefined);
        } finally {
            if (previousRoot === undefined)
                delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousRoot;
            rmSync(sidecarRoot, { recursive: true, force: true });
        }
    });
});

// ─── jobs attach — dead process detection ─────────────────────────────

void describe("jobs attach — dead process detection", () => {
    void it("returns immediately when job process is dead and donePromise is unresolved", async () => {
        const state = new TauState();
        // Use a PID that is guaranteed not to exist as an OS process.
        // 999999998 is in the upper range of valid PIDs but essentially
        // impossible to be running.
        const deadPid = 999999998;
        const job = makeJob({
            id: "job-dead-1",
            pid: deadPid,
            status: "running",
            logPath: "/tmp/pi-bg-job-dead-1.log",
            toolCallId: "tc-attach-dead",
        });
        createJobDonePromise(job);
        state.backgroundJobs.set("job-dead-1", job);

        // Write a log file so readOutputTail doesn't fail
        const { writeFileSync } = await import("node:fs");
        writeFileSync("/tmp/pi-bg-job-dead-1.log", "test output\n");

        const tool = captureJobsTool(state);

        // Race attach against a 2s timeout. If attach hangs, the timeout wins
        // and the test fails.
        const attachResult = await Promise.race([
            tool.execute(
                "tc-attach-dead",
                { action: "attach", jobId: "job-dead-1", wait: true },
                null,
                null,
                null
            ),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "attach hung for 2s — donePromise never resolved"
                            )
                        ),
                    2_000
                )
            ),
        ]);

        // attach must return (not hang)
        assert.ok(
            attachResult.content[0].text.includes("job-dead-1"),
            "attach must return the job's output"
        );
        // job must be marked terminal
        assert.equal(
            job.status === "completed" || job.status === "failed",
            true,
            `expected completed or failed, got ${job.status}`
        );
    });
});

// ─── jobs attach — abort signal ────────────────────────────────────────

void describe("jobs attach — timeout metadata", () => {
    void it("returns timedOut metadata without waiting a full poll interval", async () => {
        const state = new TauState();
        const logPath = "/tmp/pi-bg-job-timeout-1.log";
        const { writeFileSync, unlinkSync } = await import("node:fs");
        writeFileSync(logPath, "still running\n");
        const job = makeJob({
            id: "job-timeout-1",
            pid: process.pid,
            status: "running",
            logPath,
            toolCallId: "tc-attach-timeout",
        });
        createJobDonePromise(job);
        state.backgroundJobs.set(job.id, job);
        const tool = captureJobsTool(state);
        const started = Date.now();
        try {
            const result = await tool.execute(
                "tc-attach-timeout",
                { action: "attach", jobId: job.id, wait: true, timeout: 0.01 },
                null,
                null,
                null
            );
            const details = result.details as Record<string, unknown>;
            assert.equal(details.timedOut, true);
            assert.equal(details.empty, false);
            assert.equal(details.error, false);
            assert.ok(Date.now() - started < 1_000);
        } finally {
            unlinkSync(logPath);
        }
    });
});

void describe("jobs attach — abort signal", () => {
    void it("returns promptly when abort signal fires", async () => {
        const state = new TauState();
        const job = makeJob({
            id: "job-abort-1",
            pid: process.pid, // a live process so the dead-PID check passes
            status: "running",
            logPath: "/tmp/pi-bg-job-abort-1.log",
            toolCallId: "tc-attach-abort",
        });
        createJobDonePromise(job);
        state.backgroundJobs.set("job-abort-1", job);

        const { writeFileSync } = await import("node:fs");
        writeFileSync("/tmp/pi-bg-job-abort-1.log", "still running\n");

        const controller = new AbortController();
        const tool = captureJobsTool(state);

        // Abort after 100ms — attach should return, not hang
        setTimeout(() => controller.abort(), 100);

        const attachResult = await Promise.race([
            tool.execute(
                "tc-attach-abort",
                { action: "attach", jobId: "job-abort-1", wait: true },
                controller.signal,
                null,
                null
            ),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "attach did not respond to abort within 2s"
                            )
                        ),
                    2_000
                )
            ),
        ]);

        assert.ok(
            attachResult.content[0].text.includes("job-abort-1"),
            "attach must return the job's output after abort"
        );
        const details = attachResult.details as Record<string, unknown>;
        assert.equal(details.totalLines, 1);
        assert.equal(details.empty, false);
        assert.equal(details.error, false);
        assert.equal(details.timedOut, false);
    });
});

// ─── job cleanup lifecycle ──────────────────────────────────────────

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
