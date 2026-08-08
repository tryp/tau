/**
 * Unit tests for the trigger monitor (trigger-monitor.ts).
 *
 * Uses a mock ExtensionAPI and a short poll interval so the one-shot
 * firing semantics can be tested without waiting on the real 2s poll.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TauState } from "../state.ts";
import type { BackgroundJob, JobTrigger } from "../types.ts";
import {
    startTriggerMonitor,
    triggerLabel,
} from "../features/trigger-monitor.ts";

// ─── Mock harness ───────────────────────────────────────────────────

let tmpDir: string;

interface SentMessage {
    customType: string;
    content: string;
    details?: unknown;
}

before(() => {
    tmpDir = mkdtempSync("/tmp/pi-trigger-monitor-test-");
});

after(() => {
    try {
        unlinkSync(tmpDir);
    } catch {
        /* dir may already be gone */
    }
});

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
    return {
        id: "job-test-1",
        command: "echo hello",
        pid: process.pid,
        startTime: Date.now(),
        status: "running",
        logPath: join(tmpDir, "job-test-1.log"),
        toolCallId: "tool-call-1",
        isBackgrounded: true,
        ...overrides,
    };
}

// Minimal structural type for the message payload we pass to sendMessage.
interface MockMessage {
    customType: string;
    content: string | unknown[];
    display?: boolean;
    details?: unknown;
}

function makePi(sent: SentMessage[]): ExtensionAPI {
    return {
        sendMessage(message: MockMessage) {
            sent.push({
                customType: message.customType,
                content:
                    typeof message.content === "string"
                        ? message.content
                        : String(message.content),
                details: message.details,
            });
        },
    } as unknown as ExtensionAPI;
}

function makeState(job: BackgroundJob): TauState {
    const state = new TauState();
    state.backgroundJobs.set(job.id, job);
    return state;
}

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── triggerLabel ───────────────────────────────────────────────────

void describe("triggerLabel", () => {
    void it("renders numeric triggers as type=value", () => {
        assert.equal(
            triggerLabel({ type: "outputLines", value: 200 }),
            "outputLines=200"
        );
        assert.equal(
            triggerLabel({ type: "wallTime", value: 60 }),
            "wallTime=60"
        );
    });

    void it("renders outputMatch with pattern and default flags", () => {
        assert.equal(
            triggerLabel({ type: "outputMatch", pattern: "ERROR" }),
            "outputMatch=/ERROR/i"
        );
    });

    void it("omits the i flag when caseSensitive is true", () => {
        assert.equal(
            triggerLabel({
                type: "outputMatch",
                pattern: "ERROR",
                caseSensitive: true,
            }),
            "outputMatch=/ERROR/"
        );
    });
});

// ─── startTriggerMonitor ────────────────────────────────────────────

void describe("startTriggerMonitor", () => {
    void it("fires bg-trigger when an outputMatch pattern appears, then deactivates", async () => {
        const logPath = join(tmpDir, "match.log");
        writeFileSync(logPath, "startup done\n");
        const job = makeJob({ id: "job-match", logPath });
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        const trigger: JobTrigger = {
            type: "outputMatch",
            pattern: "server ready",
        };
        job.triggers = [trigger];

        const cancel = startTriggerMonitor(job, pi, makeState(job), 20);
        try {
            // First window: pattern not yet present.
            await sleep(60);
            assert.equal(sent.length, 0, "should not fire before the match");

            // Append the matching line; next poll fires and removes the trigger.
            writeFileSync(logPath, "startup done\nserver ready\n");
            await sleep(60);

            assert.equal(sent.length, 1, "should fire exactly once");
            assert.equal(sent[0].customType, "bg-trigger");
            assert.match(sent[0].content, /server ready/);
            assert.equal(job.triggers, undefined, "trigger should be removed");

            // Nothing further fires after the one-shot consumed the trigger.
            writeFileSync(logPath, "startup done\nserver ready\nagain\n");
            await sleep(60);
            assert.equal(sent.length, 1);
        } finally {
            cancel();
        }
    });

    void it("reports an invalid regex via a fired error event", async () => {
        const logPath = join(tmpDir, "bad-regex.log");
        writeFileSync(logPath, "anything\n");
        const job = makeJob({ id: "job-bad-regex", logPath });
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [{ type: "outputMatch", pattern: "(" }];

        const cancel = startTriggerMonitor(job, pi, makeState(job), 20);
        try {
            await sleep(60);
            assert.equal(sent.length, 1, "invalid regex should surface");
            assert.match(sent[0].content, /invalid regex/);
            assert.equal(job.triggers, undefined);
        } finally {
            cancel();
        }
    });

    void it("stops polling when the job is no longer running", async () => {
        const logPath = join(tmpDir, "stale.log");
        writeFileSync(logPath, "server ready\n");
        const job = makeJob({ id: "job-stale", logPath });
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        // Trigger would fire, but the job completes first.
        job.triggers = [{ type: "outputMatch", pattern: "server ready" }];

        const cancel = startTriggerMonitor(job, pi, makeState(job), 20);
        try {
            job.status = "completed";
            await sleep(60);
            assert.equal(sent.length, 0, "must not fire for a completed job");
        } finally {
            cancel();
        }
    });

    void it("cancel stops further polls", async () => {
        const logPath = join(tmpDir, "cancel.log");
        writeFileSync(logPath, "server ready\n");
        const job = makeJob({ id: "job-cancel", logPath });
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [{ type: "outputMatch", pattern: "server ready" }];

        const cancel = startTriggerMonitor(job, pi, makeState(job), 20);
        cancel();
        await sleep(60);
        assert.equal(sent.length, 0);
    });
});
