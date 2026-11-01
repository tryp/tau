import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
    BACKGROUND_JOB_LIVENESS_ENTRY_TYPE,
    BACKGROUND_JOB_LIVENESS_INTERVAL_MS,
    BACKGROUND_JOB_LIVENESS_MAX_HEARTBEATS,
    startBackgroundJobLiveness,
} from "../features/background-job-liveness.ts";

type RecordEntry = { customType: string; data: Record<string, unknown> };

void describe("background job session liveness", () => {
    beforeEach(() => mock.timers.enable({ apis: ["setInterval", "Date"] }));
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    void it("persists at 30-second cadence, not before, with log growth evidence", () => {
        let logBytes = 5;
        const records: RecordEntry[] = [];
        const tracker = startBackgroundJobLiveness(
            {
                id: "tmux-123-1",
                startTime: Date.now(),
                logPath: "/tmp/job.log",
            },
            (customType, data) => records.push({ customType, data }),
            { readLogBytes: () => logBytes }
        );

        mock.timers.tick(BACKGROUND_JOB_LIVENESS_INTERVAL_MS - 1);
        assert.equal(records.length, 0, "no early heartbeat");

        logBytes = 8;
        mock.timers.tick(1);
        assert.equal(records.length, 1);
        assert.equal(
            records[0]?.customType,
            BACKGROUND_JOB_LIVENESS_ENTRY_TYPE
        );
        assert.deepEqual(records[0]?.data, {
            schemaVersion: 1,
            event: "heartbeat",
            jobId: "tmux-123-1",
            status: "pending",
            sequence: 1,
            elapsedSeconds: 30,
            logBytes: 8,
            logBytesDelta: 3,
            lastGrowthAgeSeconds: 0,
        });

        mock.timers.tick(BACKGROUND_JOB_LIVENESS_INTERVAL_MS);
        assert.equal(records.length, 2, "one more heartbeat at 60 seconds");
        assert.equal(records[1]?.data.sequence, 2);
        assert.equal(records[1]?.data.elapsedSeconds, 60);
        assert.equal(records[1]?.data.logBytesDelta, 0);
        assert.equal(records[1]?.data.lastGrowthAgeSeconds, 30);
        tracker.stop();
    });

    void it("writes one terminal record with final duration and log size", () => {
        let logBytes = 17;
        const records: RecordEntry[] = [];
        const tracker = startBackgroundJobLiveness(
            {
                id: "tmux-123-2",
                startTime: Date.now(),
                logPath: "/tmp/job.log",
            },
            (customType, data) => records.push({ customType, data }),
            { readLogBytes: () => logBytes }
        );

        mock.timers.tick(12_000);
        logBytes = 29;
        tracker.finish("completed", 0);
        tracker.finish("completed", 0);

        assert.equal(records.length, 1, "terminal entry is idempotent");
        assert.deepEqual(records[0]?.data, {
            schemaVersion: 1,
            event: "terminal",
            jobId: "tmux-123-2",
            status: "completed",
            exitCode: 0,
            elapsedSeconds: 12,
            finalLogBytes: 29,
            heartbeatCount: 0,
            heartbeatCapTrips: 0,
            persistenceFailures: 0,
        });
    });

    void it("caps heartbeat records at 100 and persists a cap-trip counter", () => {
        const records: RecordEntry[] = [];
        const tracker = startBackgroundJobLiveness(
            {
                id: "tmux-123-3",
                startTime: Date.now(),
                logPath: "/tmp/job.log",
            },
            (customType, data) => records.push({ customType, data }),
            { readLogBytes: () => 0 }
        );

        mock.timers.tick(
            BACKGROUND_JOB_LIVENESS_INTERVAL_MS *
                (BACKGROUND_JOB_LIVENESS_MAX_HEARTBEATS + 1)
        );
        const heartbeatRecords = records.filter(
            ({ data }) => data.event === "heartbeat"
        );
        const capRecords = records.filter(
            ({ data }) => data.event === "heartbeat_cap_reached"
        );
        assert.equal(heartbeatRecords.length, 100);
        assert.equal(capRecords.length, 1);
        assert.equal(capRecords[0]?.data.heartbeatCount, 100);
        assert.equal(capRecords[0]?.data.heartbeatCapTrips, 1);

        tracker.finish("killed");
        assert.equal(
            records.filter(({ data }) => data.event === "terminal").length,
            1,
            "terminal record remains available after heartbeat cap"
        );
    });
});
