/**
 * Tests for the callbacks feature — duration parsing, formatting, and relative time.
 *
 * All tests import directly from the source module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    parseDurationToMs,
    formatDuration,
    formatRelative,
    registerCallbacks,
} from "../features/callbacks.ts";
import { TauState } from "../state.ts";

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

function createCallbackHarness() {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
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
