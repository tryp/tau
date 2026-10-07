/**
 * Unit tests for the trigger monitor (trigger-monitor.ts).
 *
 * Uses a mock ExtensionAPI and a short poll interval so the one-shot
 * firing semantics can be tested without waiting on the real 2s poll.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TauState } from "../state.ts";
import type { BackgroundJob, JobTrigger } from "../types.ts";
import {
    ensureTriggerMonitor,
    startTriggerMonitor,
    triggerLabel,
} from "../features/trigger-monitor.ts";

// ─── Mock harness ───────────────────────────────────────────────────

let tmpDir: string;

interface SentMessage {
    customType: string;
    content: string;
    details?: unknown;
    options?: unknown;
}

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-trigger-monitor-test-"));
});

after(() => {
    // `rmSync` removes the directory. `unlinkSync` was used here before and
    // silently did nothing: removing a DIRECTORY with unlink throws EISDIR, and
    // the bare catch that wrapped the call swallowed it, so every run leaked
    // one directory while the suite still reported success.
    //
    // Guarded because `before` may have failed before assigning `tmpDir`, in
    // which case the real error is the one worth reporting.
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
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
        sendMessage(message: MockMessage, options?: unknown) {
            sent.push({
                customType: message.customType,
                content:
                    typeof message.content === "string"
                        ? message.content
                        : String(message.content),
                details: message.details,
                options,
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

/**
 * Poll until a condition holds (positive assertions), with a hard timeout
 * so timing-dependent monitor tests fail fast instead of hanging or
 * asserting on a sleep that raced the poll interval.
 */
async function waitFor(
    cond: () => boolean,
    timeoutMs: number = 2000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) {
            throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
        }
        await sleep(10);
    }
}

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
            await waitFor(() => sent.length === 1);

            assert.equal(sent[0].customType, "bg-trigger");
            assert.match(sent[0].content, /server ready/);
            assert.match(
                sent[0].content,
                /Matched: server ready/,
                "fired message should carry the matching line"
            );
            assert.equal(
                (sent[0].details as { matchText?: string }).matchText,
                "server ready"
            );
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
            await waitFor(() => sent.length === 1);
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

// ─── Lifecycle regressions ─────────────────────────────────────────

void describe("trigger monitor lifecycle", () => {
    void it("restarts the monitor when new triggers are subscribed after a one-shot fire", async () => {
        // Regression: the stored cancelTriggerMonitor was never cleared when
        // the monitor self-stopped, so a later subscription on the same
        // running job never started a fresh monitor and its triggers were
        // silently never evaluated.
        const logPath = join(tmpDir, "resub.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({ id: "job-resub", logPath });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [{ type: "outputMatch", pattern: "phase one" }];
        const c1 = ensureTriggerMonitor(job, pi, state, 20);
        assert.ok(c1, "first subscription starts a monitor");

        writeFileSync(logPath, "start\nphase one\n");
        await waitFor(() => sent.length === 1);
        assert.equal(job.triggers, undefined, "one-shot consumed the trigger");
        assert.equal(
            job.cancelTriggerMonitor,
            undefined,
            "self-stop must clear the stored monitor"
        );

        // Re-subscribe on the same still-running job.
        job.triggers = [{ type: "outputMatch", pattern: "phase two" }];
        const c2 = ensureTriggerMonitor(job, pi, state, 20);
        assert.ok(
            c2,
            "a fresh monitor must start after the first consumed its triggers"
        );

        writeFileSync(logPath, "start\nphase one\nphase two\n");
        await waitFor(() => sent.length === 2);
        assert.match(sent[1].content, /phase two/);
        assert.equal(job.triggers, undefined);
        c2?.();
    });

    void it("fires each subscribed trigger once and stops when all are consumed", async () => {
        const logPath = join(tmpDir, "multi.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({ id: "job-multi", logPath });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [
            { type: "outputMatch", pattern: "alpha" },
            { type: "outputMatch", pattern: "beta" },
        ];
        const cancel = ensureTriggerMonitor(job, pi, state, 20);
        assert.ok(cancel);

        writeFileSync(logPath, "start\nalpha\n");
        await waitFor(() => sent.length === 1);
        writeFileSync(logPath, "start\nalpha\nbeta\n");
        await waitFor(() => sent.length === 2);

        assert.match(sent[0].content, /alpha/);
        assert.match(sent[1].content, /beta/);
        assert.equal(
            job.triggers,
            undefined,
            "both one-shot triggers consumed"
        );
        cancel();
    });

    void it("surfaces an invalid pattern without dropping valid triggers", async () => {
        const logPath = join(tmpDir, "mixed.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({ id: "job-mixed", logPath });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [
            { type: "outputMatch", pattern: "(" },
            { type: "outputMatch", pattern: "good" },
        ];
        ensureTriggerMonitor(job, pi, state, 20);

        await waitFor(() => sent.length === 1);
        assert.match(sent[0].content, /invalid regex/);
        assert.equal(
            job.triggers?.length,
            1,
            "valid trigger must remain subscribed"
        );

        writeFileSync(logPath, "start\ngood\n");
        await waitFor(() => sent.length === 2);
        assert.match(sent[1].content, /good/);
        assert.equal(job.triggers, undefined);
    });

    void it("measures wallTime from the job start, not the monitor start", async () => {
        // Regression: the accumulator seeded jobStartMs at monitor start,
        // so a wallTime trigger subscribed after the job had been running
        // would fire late. The job's own startTime is the correct base.
        const logPath = join(tmpDir, "wall.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({
            id: "job-wall",
            logPath,
            startTime: Date.now() - 10_000,
        });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [{ type: "wallTime", value: 5 }];
        ensureTriggerMonitor(job, pi, state, 20);

        // Job started 10s ago, threshold 5s: the first poll must fire.
        await waitFor(() => sent.length === 1);
        assert.match(sent[0].content, /wallTime=5/);
    });

    void it("delivers bg-trigger as a follow-up turn with structured details", async () => {
        const logPath = join(tmpDir, "details.log");
        writeFileSync(logPath, "server ready\n");
        const job = makeJob({ id: "job-details", logPath });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [{ type: "outputMatch", pattern: "server ready" }];
        ensureTriggerMonitor(job, pi, state, 20);
        await waitFor(() => sent.length === 1);

        assert.deepEqual(sent[0].options, {
            deliverAs: "followUp",
            triggerTurn: true,
        });
        const details = sent[0].details as Record<string, unknown>;
        assert.equal(details.jobId, job.id);
        assert.equal(details.triggerType, "outputMatch");
        assert.equal(details.threshold, "server ready");
        assert.equal(details.current, 1);
        assert.equal(details.error, undefined);
    });

    void it("does not start a second monitor while one is active", async () => {
        const logPath = join(tmpDir, "single.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({ id: "job-single", logPath });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        const c1 = ensureTriggerMonitor(job, pi, state, 20);
        const c2 = ensureTriggerMonitor(job, pi, state, 20);
        assert.equal(c1, c2, "both calls must return the same active monitor");

        job.triggers = [{ type: "outputMatch", pattern: "boom" }];
        writeFileSync(logPath, "start\nboom\n");
        await waitFor(() => sent.length === 1);
        c1?.();
    });

    void it("cancel clears the stored monitor so a later subscription can restart it", async () => {
        const logPath = join(tmpDir, "cancel-restart.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({ id: "job-cancel-restart", logPath });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        const c1 = ensureTriggerMonitor(job, pi, state, 20);
        assert.ok(c1);
        c1();
        assert.equal(
            job.cancelTriggerMonitor,
            undefined,
            "cancel must clear the stored stop fn"
        );

        const c2 = ensureTriggerMonitor(job, pi, state, 20);
        assert.ok(c2, "restart must succeed after cancel");
        job.triggers = [{ type: "outputMatch", pattern: "later" }];
        writeFileSync(logPath, "start\nlater\n");
        await waitFor(() => sent.length === 1);
        c2?.();
    });

    void it("does not start a monitor for a job that is no longer running", async () => {
        const logPath = join(tmpDir, "dead.log");
        writeFileSync(logPath, "start\n");
        const job = makeJob({ id: "job-dead", logPath, status: "completed" });
        const state = makeState(job);
        const sent: SentMessage[] = [];
        const pi = makePi(sent);

        job.triggers = [{ type: "outputMatch", pattern: "boom" }];
        const cancel = ensureTriggerMonitor(job, pi, state, 20);
        assert.equal(cancel, undefined, "no monitor for a completed job");
        await sleep(60);
        assert.equal(sent.length, 0);
    });
});
