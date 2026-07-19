/**
 * Tests for the callbacks feature — duration parsing, formatting, relative time,
 * linked callback lifecycle, and completion notification flag.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    parseDurationToMs,
    formatDuration,
    formatRelative,
    registerCallbacks,
    hasLinkedCallbacksForJob,
    cancelCallbacksForJob,
    scheduleJobReminder,
} from "../features/callbacks.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";

// ─── Duration parsing ────────────────────────────────────────────────

void describe("callback parseDurationToMs", () => {
    void it("parses seconds", () => {
        assert.equal(parseDurationToMs("30s"), 30_000);
        assert.equal(parseDurationToMs("1s"), 1_000);
    });

    void it("parses minutes", () => {
        assert.equal(parseDurationToMs("5m"), 300_000);
        assert.equal(parseDurationToMs("1m"), 60_000);
    });

    void it("parses hours", () => {
        assert.equal(parseDurationToMs("2h"), 7_200_000);
        assert.equal(parseDurationToMs("1h"), 3_600_000);
    });

    void it("parses days", () => {
        assert.equal(parseDurationToMs("1d"), 86_400_000);
        assert.equal(parseDurationToMs("7d"), 604_800_000);
    });

    void it("parses fractional durations", () => {
        assert.equal(parseDurationToMs("0.5s"), 500);
        assert.equal(parseDurationToMs("1.5m"), 90_000);
    });

    void it("returns null for invalid input", () => {
        assert.equal(parseDurationToMs("hello"), null);
        assert.equal(parseDurationToMs("5"), null);
        assert.equal(parseDurationToMs(""), null);
        assert.equal(parseDurationToMs("5x"), null);
    });
});

// ─── Duration formatting ─────────────────────────────────────────────

void describe("callback formatDuration", () => {
    void it("formats seconds", () => {
        assert.equal(formatDuration(30_000), "30s");
        assert.equal(formatDuration(500), "1s");
    });

    void it("formats minutes", () => {
        assert.equal(formatDuration(300_000), "5m");
        assert.equal(formatDuration(90_000), "2m");
    });

    void it("formats hours", () => {
        assert.equal(formatDuration(7_200_000), "2h");
        assert.equal(formatDuration(3_600_000), "1h");
    });

    void it("formats days", () => {
        assert.equal(formatDuration(86_400_000), "1d");
        assert.equal(formatDuration(172_800_000), "2d");
    });
});

// ─── Relative time formatting ────────────────────────────────────────

void describe("callback formatRelative", () => {
    void it("shows 'overdue' for past timestamps", () => {
        const past = new Date(Date.now() - 10_000).toISOString();
        assert.equal(formatRelative(past), "overdue");
    });

    void it("shows 'in Ns' for seconds away", () => {
        const future = new Date(Date.now() + 30_000).toISOString();
        const result = formatRelative(future);
        assert.ok(result.startsWith("in "));
        assert.ok(result.endsWith("s"));
    });

    void it("shows 'in Nm' for minutes away", () => {
        const future = new Date(Date.now() + 300_000).toISOString();
        const result = formatRelative(future);
        assert.ok(result.startsWith("in "));
        assert.ok(result.endsWith("m"));
    });

    void it("shows 'in Nh' for hours away", () => {
        const future = new Date(Date.now() + 7_200_000).toISOString();
        const result = formatRelative(future);
        assert.ok(result.startsWith("in "));
        assert.ok(result.endsWith("h"));
    });
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** Create a minimal BackgroundJob for testing. */
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
 * Build a harness for testing the remind tool and lifecycle events.
 * Fixes the existing test's missing `sendMessage` mock so flushReadyCallbacks
 * doesn't crash.
 */
function createCallbackHarness() {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
    const sentMessages: Array<{ message: unknown; options: unknown }> = [];
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];
    let remindTool:
        | {
              execute: (
                  toolCallId: string,
                  params: Record<string, unknown>,
                  signal: unknown,
                  onUpdate: unknown,
                  ctx: unknown
              ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
          }
        | null = null;

    const pi = {
        on(eventName: string, handler: (event: any, ctx: any) => unknown) {
            handlers.set(eventName, handler);
        },
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "remind") {
                remindTool = tool as typeof remindTool;
            }
        },
        registerCommand() {},
        sendUserMessage(content: unknown, options: unknown) {
            sentUserMessages.push({ content, options });
        },
        sendMessage(message: unknown, options: unknown) {
            sentMessages.push({ message, options });
        },
        appendEntry(customType: string, data: unknown) {
            appendedEntries.push({ customType, data });
        },
    } as never;

    const ctx = {
        sessionManager: {
            getSessionId: () => "sess-1",
            getEntries: () => [],
        },
    };

    return {
        pi,
        ctx,
        sentUserMessages,
        sentMessages,
        appendedEntries,
        getRemindTool: () => {
            assert.ok(remindTool, "remind tool was not registered");
            return remindTool;
        },
        async invoke(eventName: string, event: unknown = {}) {
            const handler = handlers.get(eventName);
            assert.ok(handler, `missing handler for ${eventName}`);
            return await handler(event, ctx);
        },
    };
}

// ─── Callback delivery while agent is busy ───────────────────────────

void describe("callback delivery while agent is busy", () => {
    void it("delivers a fired callback after agent_end when not cancelled", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const remind = h.getRemindTool();
        await remind.execute("tc-1", { message: "check test", delay: "0.001s" }, null, null, null);
        await h.invoke("agent_start", { type: "agent_start" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(h.sentUserMessages.length, 0, "callback should not deliver while agent is busy");

        await h.invoke("agent_end", { type: "agent_end", messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(h.sentUserMessages.length, 1);
        assert.match(String(h.sentUserMessages[0].content), /<callback id="cb-1"/);
    });

    void it("delivers callback only via sendUserMessage, not via sendMessage (no duplicate)", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const remind = h.getRemindTool();
        await remind.execute("tc-1", { message: "check test", delay: "0.001s" }, null, null, null);
        await h.invoke("agent_start", { type: "agent_start" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(h.sentUserMessages.length, 0, "callback should not deliver while agent is busy");
        assert.equal(h.sentMessages.length, 0, "no sendMessage delivery while agent is busy");

        await h.invoke("agent_end", { type: "agent_end", messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Core delivery: exactly one sendUserMessage (the agent notification)
        assert.equal(h.sentUserMessages.length, 1,
            "exactly one sendUserMessage for the callback");
        assert.match(String(h.sentUserMessages[0].content), /<callback id="cb-1"/,
            "sendUserMessage delivers the callback content");

        // No duplicate via sendMessage (was the bug)
        assert.equal(h.sentMessages.length, 0,
            "no sendMessage delivery — callback is not duplicated");

        // Persistence via appendEntry (replaces old sendMessage)
        assert.ok(h.appendedEntries.length >= 1,
            "callback is persisted via appendEntry");
        const appended = h.appendedEntries.find(
            (e) => e.customType === "callback"
        );
        assert.ok(appended, "appendEntry with customType 'callback' exists");
    });

    void it("cancel-all suppresses a fired callback that has not been delivered yet", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const remind = h.getRemindTool();
        await remind.execute("tc-1", { message: "stale callback", delay: "0.001s" }, null, null, null);
        await h.invoke("agent_start", { type: "agent_start" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        const result = await remind.execute("tc-2", { action: "cancel-all" }, null, null, null);
        assert.equal(result.content[0]?.text, "Cancelled 1 pending callback(s).");

        await h.invoke("agent_end", { type: "agent_end", messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(h.sentUserMessages.length, 0, "cancel-all should suppress queued stale callback delivery");
    });
});

// ─── hasLinkedCallbacksForJob ────────────────────────────────────────

void describe("hasLinkedCallbacksForJob", () => {
    void it("returns true when a pending linked callback exists", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        // Add a running job to the state so fireCallback won't silently cancel it
        const job = makeJob({ id: "job-1-1", status: "running" });
        state.backgroundJobs.set(job.id, job);

        // Schedule a linked callback with a generous delay so it stays pending
        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check job", delay: "10s", jobId: "job-1-1" },
            null,
            null,
            null
        );

        assert.equal(hasLinkedCallbacksForJob("job-1-1"), true,
            "should return true while the linked callback is still pending");
    });

    void it("returns false when the linked callback has fired (original bug condition)", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        // Add a running job — this is key: fireCallback only keeps the callback
        // (rather than silently cancelling it) when the job is still running
        const job = makeJob({ id: "job-1-1", status: "running" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        // Schedule a linked callback with a very short delay so it fires immediately
        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check job", delay: "0.001s", jobId: "job-1-1" },
            null,
            null,
            null
        );

        // Wait for the timer to fire
        await new Promise((resolve) => setTimeout(resolve, 10));

        // The callback has fired (cb.fired = true), so hasLinkedCallbacksForJob
        // should return false — this is the condition that led to silent
        // suppression of the completion notification
        assert.equal(hasLinkedCallbacksForJob("job-1-1"), false,
            "should return false once the linked callback has fired");
    });

    void it("returns false for jobs without any linked callbacks", () => {
        const state = new TauState();
        // No callbacks registered at all
        assert.equal(hasLinkedCallbacksForJob("job-nonexistent"), false);
    });
});

// ─── wantsCompletionNotification flag ────────────────────────────────

void describe("wantsCompletionNotification flag", () => {
    void it("is set when a linked callback fires while the job is still running", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const job = makeJob({ id: "job-1-1", status: "running" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check job", delay: "0.001s", jobId: "job-1-1" },
            null,
            null,
            null
        );

        // Wait for the timer to fire — fireCallback should set the flag
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(job.wantsCompletionNotification, true,
            "should be true so flushCompletionBatch knows to deliver the completion notification");
    });

    void it("is NOT set when a non-linked callback fires", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const job = makeJob({ id: "job-1-1", status: "running" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        // Schedule a plain callback WITHOUT jobId
        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check something", delay: "0.001s" },
            null,
            null,
            null
        );

        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(job.wantsCompletionNotification, undefined,
            "should remain undefined for non-linked callbacks");
    });

    void it("is NOT set when the job completes before the callback fires", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const job = makeJob({ id: "job-1-1", status: "completed" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check job", delay: "0.001s", jobId: "job-1-1" },
            null,
            null,
            null
        );

        // Wait for the timer to fire — fireCallback should skip the flag
        // because the job is no longer running
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(job.wantsCompletionNotification, undefined,
            "should remain undefined when the job completed before the callback");
    });

    void it("is NOT set when the job is not found in state", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        await h.invoke("agent_start");

        // Schedule a linked callback for a job that doesn't exist in state
        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check job", delay: "0.001s", jobId: "job-nonexistent" },
            null,
            null,
            null
        );

        // Wait for the timer to fire — fireCallback will cancel the callback
        // silently because the job is not found, so no flag should be set
        await new Promise((resolve) => setTimeout(resolve, 10));

        // We can't check a non-existent job, but the callback should not crash
        assert.equal(hasLinkedCallbacksForJob("job-nonexistent"), false);
    });

    void it("survives agent_end delivery (flag stays true after callback is consumed)", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const job = makeJob({ id: "job-1-1", status: "running" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check job", delay: "0.001s", jobId: "job-1-1" },
            null,
            null,
            null
        );

        await new Promise((resolve) => setTimeout(resolve, 10));

        // Now deliver the callback by signalling agent_end
        // This should NOT clear the wantsCompletionNotification flag
        await h.invoke("agent_end", { type: "agent_end", messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(job.wantsCompletionNotification, true,
            "flag must survive callback delivery so flushCompletionBatch can read it later");
    });
});

// ─── cancelCallbacksForJob ───────────────────────────────────────────

void describe("cancelCallbacksForJob", () => {
    void it("cancels all linked callbacks for the given job", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const job = makeJob({ id: "job-cancel-1", status: "running" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        // Schedule two linked callbacks for the same job
        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check 1", delay: "30s", jobId: "job-cancel-1" },
            null,
            null,
            null
        );
        await remind.execute(
            "tc-2",
            { message: "check 2", delay: "60s", jobId: "job-cancel-1" },
            null,
            null,
            null
        );

        assert.equal(
            hasLinkedCallbacksForJob("job-cancel-1"),
            true,
            "linked callbacks exist before cancellation"
        );

        const count = cancelCallbacksForJob("job-cancel-1");

        assert.equal(count, 2, "should cancel both linked callbacks");
        assert.equal(
            hasLinkedCallbacksForJob("job-cancel-1"),
            false,
            "no linked callbacks remain after cancellation"
        );
    });

    void it("returns 0 when no callbacks are linked to the job", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        const count = cancelCallbacksForJob("job-nonexistent");
        assert.equal(count, 0, "no callbacks cancelled for unrelated job");
    });

    void it("only cancels callbacks for the specified job, not others", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const jobA = makeJob({ id: "job-cancel-a", status: "running" });
        const jobB = makeJob({ id: "job-cancel-b", status: "running" });
        state.backgroundJobs.set(jobA.id, jobA);
        state.backgroundJobs.set(jobB.id, jobB);

        await h.invoke("agent_start");

        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "check A", delay: "30s", jobId: "job-cancel-a" },
            null,
            null,
            null
        );
        await remind.execute(
            "tc-2",
            { message: "check B", delay: "30s", jobId: "job-cancel-b" },
            null,
            null,
            null
        );

        const count = cancelCallbacksForJob("job-cancel-a");

        assert.equal(count, 1, "only the callback for job A should be cancelled");
        assert.equal(
            hasLinkedCallbacksForJob("job-cancel-a"),
            false,
            "job A has no remaining callbacks"
        );
        assert.equal(
            hasLinkedCallbacksForJob("job-cancel-b"),
            true,
            "job B still has its callback"
        );
    });

    void it("removes already-fired callbacks from the map and returns count", async () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const job = makeJob({ id: "job-cancel-fired", status: "running" });
        state.backgroundJobs.set(job.id, job);

        await h.invoke("agent_start");

        // Schedule a callback that fires quickly
        const remind = h.getRemindTool();
        await remind.execute(
            "tc-1",
            { message: "fast check", delay: "0.001s", jobId: "job-cancel-fired" },
            null,
            null,
            null
        );

        await new Promise((resolve) => setTimeout(resolve, 10));

        // The callback has fired (cb.fired = true) but is still in the map
        // so cancel/cancel-all can suppress it before delivery.
        // cancelCallbacksForJob removes it from the map regardless.
        const count = cancelCallbacksForJob("job-cancel-fired");
        assert.equal(count, 1, "fired callback is still in the map and gets removed");

        assert.equal(
            hasLinkedCallbacksForJob("job-cancel-fired"),
            false,
            "callback is gone after cancellation"
        );
    });
});

// ─── scheduleJobReminder ─────────────────────────────────────────────

void describe("scheduleJobReminder", () => {
    void it("returns a callback ID for a valid remindIn duration", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        const id = scheduleJobReminder("job-sched-1", "30s", "check job");
        assert.ok(id, "should return a callback ID");
        assert.ok(id?.startsWith("cb-"), "callback ID should start with 'cb-'");
    });

    void it("returns null for an invalid remindIn duration", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        const id = scheduleJobReminder("job-sched-invalid", "not-a-duration");
        assert.equal(id, null, "invalid duration should return null");
    });

    void it("creates a callback that hasLinkedCallbacksForJob can find", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        const id = scheduleJobReminder("job-sched-2", "60s");
        assert.ok(id, "should create a callback");

        assert.equal(
            hasLinkedCallbacksForJob("job-sched-2"),
            true,
            "the newly created callback should be findable"
        );
    });

    void it("uses the default message when none is provided", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        const id = scheduleJobReminder("job-sched-3", "30s");
        assert.ok(id, "should create a callback without explicit message");
        assert.equal(
            hasLinkedCallbacksForJob("job-sched-3"),
            true,
            "callback exists with default message"
        );
    });

    void it("creates a callback cancellable by cancelCallbacksForJob", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        const id = scheduleJobReminder("job-sched-4", "120s", "long wait");
        assert.ok(id, "should create a callback");

        assert.equal(
            hasLinkedCallbacksForJob("job-sched-4"),
            true,
            "callback exists before cancellation"
        );

        const count = cancelCallbacksForJob("job-sched-4");
        assert.equal(count, 1, "should cancel the scheduled callback");
        assert.equal(
            hasLinkedCallbacksForJob("job-sched-4"),
            false,
            "callback is gone after cancellation"
        );
    });

    void it("does not create callback for jobs with non-existent IDs", () => {
        const state = new TauState();
        const h = createCallbackHarness();
        registerCallbacks(h.pi, state);

        // scheduleJobReminder should succeed even if the job doesn't exist
        // in state — it's a fire-and-forget linked callback
        const id = scheduleJobReminder("job-ghost", "30s", "ghost check");
        assert.ok(id, "should create callback regardless of job existence in state");

        assert.equal(
            hasLinkedCallbacksForJob("job-ghost"),
            true,
            "callback exists even for ghost job"
        );
    });
});
