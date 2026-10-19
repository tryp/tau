/**
 * Tests for restoring linked job reminders across session restarts.
 *
 * Pins the guarantee that a linked reminder whose job is not tracked in the
 * new process is never silently dropped: the in-memory job map does not
 * survive reloads, so absence proves nothing about the job (a tmux-backed
 * bash_bg job keeps running while the map is rebuilt). Such reminders are
 * marked orphaned at restore, retained, and fire once with an explicit
 * orphan note; fireCallback re-classifies them as normal reminders if the
 * job has been re-registered by the time the timer fires.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerCallbacks } from "../features/callbacks.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";

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

interface SessionEntry {
    type: string;
    customType: string;
    data: unknown;
}

/** Build a callbacks-state entry as persisted by the feature. */
function seedCallbacksState(
    callbacks: Array<Record<string, unknown>>,
    nextId = 10
): SessionEntry {
    return {
        type: "custom",
        customType: "callbacks-state",
        data: { callbacks, nextId },
    };
}

/** A persisted (pre-fire) linked callback fixture. */
function linkedCallbackFixture(
    overrides: Partial<Record<string, unknown>> & { id: string }
): Record<string, unknown> {
    return {
        message: "check on the export job",
        fireAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        source: "agent",
        linkedJobId: "job-under-test",
        ...overrides,
    };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Harness with a STATEFUL session entry list: appendEntry (persistState)
 * feeds the same list that session_start restore reads, so a test can cycle
 * restore -> fire -> shutdown -> restore the way a real session restart does.
 */
function createRestoreHarness(seedEntries: SessionEntry[] = []) {
    const handlers = new Map<
        string,
        (event: unknown, ctx: unknown) => unknown
    >();
    const entries: SessionEntry[] = [...seedEntries];
    const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
    let remindTool: {
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
        on(
            eventName: string,
            handler: (event: unknown, ctx: unknown) => unknown
        ) {
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
        sendMessage() {},
        appendEntry(customType: string, data: unknown) {
            entries.push({ type: "custom", customType, data });
        },
    } as never;

    const ctx = {
        sessionManager: {
            getSessionId: () => "sess-restore",
            getEntries: () => entries,
        },
    };

    return {
        pi,
        entries,
        sentUserMessages,
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

function deliveredText(h: ReturnType<typeof createRestoreHarness>): string {
    const delivered = h.sentUserMessages[0]?.content;
    return typeof delivered === "string"
        ? delivered
        : JSON.stringify(delivered ?? "");
}

// ─── Restore with the linked job present (unchanged behavior) ────────

void describe("restoring linked reminders with the job present", () => {
    void it("re-arms and delivers without the orphan note, marking the job for completion notification", async () => {
        const state = new TauState();
        const job = makeJob({ id: "job-under-test", status: "running" });
        state.backgroundJobs.set(job.id, job);

        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-1",
                    fireAt: new Date(Date.now() + 60).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");
        await tick(150);

        assert.equal(h.sentUserMessages.length, 1);
        const message = deliveredText(h);
        assert.match(message, /<callback id="cb-restore-1"/);
        assert.match(message, /check on the export job/);
        assert.doesNotMatch(message, /no longer tracked/);
        assert.equal(
            job.wantsCompletionNotification,
            true,
            "a delivered linked reminder must keep the completion notification enabled"
        );
    });
});

// ─── Restore with the linked job absent (the orphan path) ────────────

void describe("restoring linked reminders whose job is not tracked", () => {
    void it("retains the reminder and fires once with an explicit orphan note", async () => {
        const state = new TauState();
        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-o1",
                    fireAt: new Date(Date.now() + 60).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        // The reminder must survive restore: the old behavior deleted it
        // here, delivering nothing. Wait past the due time.
        await tick(150);

        assert.equal(h.sentUserMessages.length, 1);
        const message = deliveredText(h);
        assert.match(
            message,
            /linked job job-under-test is no longer tracked in this session/
        );
        assert.match(message, /jobs output\/attach/);
        assert.match(
            message,
            /check on the export job/,
            "the original reminder message is preserved alongside the note"
        );
    });

    void it("fires an already-due orphaned reminder immediately at restore instead of silently cancelling it", async () => {
        const state = new TauState();
        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-o2",
                    // Already past due: scheduleCallback fires it during the
                    // restore loop itself, so the orphan mark must be applied
                    // BEFORE scheduling.
                    fireAt: new Date(Date.now() - 1_000).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");
        await tick(30);

        assert.equal(h.sentUserMessages.length, 1);
        assert.match(deliveredText(h), /no longer tracked in this session/);
    });

    void it("re-classifies an orphaned reminder at fire time when the job has been re-registered", async () => {
        const state = new TauState();
        const job = makeJob({ id: "job-under-test", status: "running" });
        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-o3",
                    fireAt: new Date(Date.now() + 60).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        // Simulate a background-feature re-discovery landing after the
        // callbacks restore: the job becomes tracked before the timer fires.
        state.backgroundJobs.set(job.id, job);
        await tick(150);

        assert.equal(h.sentUserMessages.length, 1);
        const message = deliveredText(h);
        assert.doesNotMatch(message, /no longer tracked/);
        assert.match(message, /check on the export job/);
        assert.equal(job.wantsCompletionNotification, true);
    });

    void it("keeps the orphan cancelable: action=cancel prevents delivery", async () => {
        const state = new TauState();
        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-o4",
                    fireAt: new Date(Date.now() + 80).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        const result = await h
            .getRemindTool()
            .execute(
                "tc-cancel-orphan",
                { action: "cancel", id: "cb-restore-o4" },
                null,
                null,
                null
            );
        const resultText = result.content.map((c) => c.text).join("\n");
        assert.match(resultText, /cb-restore-o4/);
        await tick(200);

        assert.equal(
            h.sentUserMessages.length,
            0,
            "a cancelled orphaned reminder must not fire"
        );
    });
});

// ─── Exactly-once delivery across restart cycles ─────────────────────

void describe("reminder delivery across restore cycles", () => {
    void it("does not duplicate delivery across a second restore after firing", async () => {
        const state = new TauState();
        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-x1",
                    fireAt: new Date(Date.now() + 60).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");
        await tick(150);
        assert.equal(h.sentUserMessages.length, 1);

        // Simulated process restart: shutdown persists remaining state
        // (fired callbacks are omitted), then the session starts again.
        await h.invoke("session_shutdown");
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");
        await tick(150);

        assert.equal(
            h.sentUserMessages.length,
            1,
            "a fired reminder must not be restored or delivered twice"
        );
    });

    void it("session_shutdown cancels the in-memory timer; the persisted entry survives and the next restore re-arms", async () => {
        const state = new TauState();
        const job = makeJob({ id: "job-under-test", status: "running" });
        state.backgroundJobs.set(job.id, job);

        const h = createRestoreHarness([
            seedCallbacksState([
                linkedCallbackFixture({
                    id: "cb-restore-s1",
                    fireAt: new Date(Date.now() + 60).toISOString(),
                }),
            ]),
        ]);
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");

        // Shut down before the timer fires. In-memory timers are cancelled
        // and the map is cleared, but shutdown's persistState has appended
        // a fresh callbacks-state entry to the session.
        await h.invoke("session_shutdown");
        await tick(120);
        assert.equal(
            h.sentUserMessages.length,
            0,
            "the cancelled in-memory timer must not deliver after shutdown"
        );
        const persisted = h.entries.filter(
            (e) => e.customType === "callbacks-state"
        );
        assert.ok(
            persisted.length >= 2,
            "shutdown must persist the pending reminder for the next restore"
        );

        // New process: restore again with the job still tracked.
        registerCallbacks(h.pi, state);
        await h.invoke("session_start");
        await tick(200);

        assert.equal(h.sentUserMessages.length, 1);
        assert.doesNotMatch(deliveredText(h), /no longer tracked/);
    });
});
