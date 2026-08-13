/**
 * Unit tests for structured JobResultDetails lifecycle metadata.
 *
 * Covers the two backend shapes: direct child processes (spawn — real PID)
 * and tmux-backed jobs (sentinel pid -1, which must NOT be exposed as a PID),
 * plus lifecycle timing (startTime / endTime / durationMs) and the
 * overrides-precedence contract of the shared builder.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jobDetails } from "../features/background.ts";
import { markJobTerminal, createJobDonePromise } from "../utils.ts";
import type { BackgroundJob } from "../types.ts";

/** Minimal BackgroundJob fixture; pid -1 models a tmux-backed job. */
function makeJob(
    overrides: Partial<BackgroundJob> & { id: string }
): BackgroundJob {
    return {
        command: "test",
        pid: -1,
        startTime: 1_000,
        status: "completed",
        logPath: "/tmp/test.log",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

void describe("jobDetails lifecycle metadata", () => {
    void it("exposes pid and timing for a terminal direct-process job", () => {
        const job = makeJob({
            id: "job-1-1",
            pid: 4242,
            startTime: 5_000,
            endTime: 9_000,
        });
        const details = jobDetails(job);
        assert.equal(details.pid, 4242);
        assert.equal(details.startTime, 5_000);
        assert.equal(details.endTime, 9_000);
        assert.equal(details.durationMs, 4_000);
        assert.equal(details.status, "completed");
        assert.equal(details.jobId, "job-1-1");
    });

    void it("omits pid for tmux-backed jobs instead of faking one", () => {
        const job = makeJob({
            id: "tmux-123-2",
            pid: -1, // tmux sentinel — no single PID
            startTime: 5_000,
            endTime: 6_500,
        });
        const details = jobDetails(job);
        assert.equal("pid" in details, false);
        assert.equal(details.startTime, 5_000);
        assert.equal(details.endTime, 6_500);
        assert.equal(details.durationMs, 1_500);
    });

    void it("reports elapsed-so-far duration for a running job", () => {
        const job = makeJob({
            id: "job-2-1",
            pid: 999,
            startTime: 10_000,
            status: "running",
            endTime: undefined,
        });
        const before = Date.now();
        const details = jobDetails(job);
        assert.equal(details.pid, 999);
        assert.equal(details.startTime, 10_000);
        assert.equal("endTime" in details, false);
        // durationMs = now - startTime while running. Allow the clock to
        // advance between the snapshot and the assertion.
        assert.ok(details.durationMs! >= before - 10_000);
        assert.ok(details.durationMs! <= Date.now() - 10_000);
        assert.equal(details.status, "running");
    });

    void it("lets callers override computed fields", () => {
        const job = makeJob({
            id: "job-3-1",
            pid: 7,
            startTime: 1_000,
            endTime: 2_000,
        });
        const details = jobDetails(job, { status: "killed", exitCode: 130 });
        assert.equal(details.status, "killed");
        assert.equal(details.exitCode, 130);
        // Non-overridden fields still come from the job.
        assert.equal(details.pid, 7);
        assert.equal(details.durationMs, 1_000);
    });
});

void describe("markJobTerminal records endTime", () => {
    void it("stamps endTime when transitioning to a terminal state", () => {
        const job = makeJob({
            id: "job-4-1",
            status: "running",
            endTime: undefined,
        });
        createJobDonePromise(job);
        const before = Date.now();
        markJobTerminal(job, "completed", 0);
        assert.equal(job.status, "completed");
        assert.ok(job.endTime !== undefined);
        assert.ok(job.endTime >= before);
    });

    void it("does not overwrite endTime on a second terminal transition", () => {
        const job = makeJob({
            id: "job-5-1",
            status: "completed",
            endTime: 42,
        });
        markJobTerminal(job, "failed", 1);
        // Early-return guard: already terminal, so endTime is preserved.
        assert.equal(job.endTime, 42);
        assert.equal(job.status, "completed");
    });
});
