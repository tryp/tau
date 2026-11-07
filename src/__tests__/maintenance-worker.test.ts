import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { recordMaintenanceEvent } from "../maintenance/events.ts";
import { runMaintenanceTask } from "../maintenance/client.ts";

interface WorkerResult {
    ok: boolean;
    task: string;
    stats: { filesVisited?: number; cancelled?: boolean };
    durationMs?: number;
}

function runWorker(directory: string, cancel = false): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            new URL("../maintenance/runner.ts", import.meta.url)
        );
        worker.once("message", (message: WorkerResult) => resolve(message));
        worker.once("error", reject);
        worker.once("exit", (code: number) => {
            if (code !== 0) reject(new Error(`worker exited ${code}`));
        });
        if (cancel) worker.postMessage({ cancel: true });
        worker.postMessage({
            task: "stage0-retention",
            options: { directories: [directory], budgetBytes: 1024 },
        });
    });
}

void it("runs stage0 maintenance in a worker, returns stats, and honors cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-maintenance-worker-"));
    try {
        writeFileSync(join(directory, "pi-pipe-stage0-test.log"), "capture");
        const completed = await runWorker(directory);
        assert.equal(completed.ok, true);
        assert.equal(completed.task, "stage0-retention");
        assert.equal(completed.stats.filesVisited, 1);
        assert.equal(typeof completed.durationMs, "number");

        const cancelled = await runWorker(directory, true);
        assert.equal(cancelled.ok, true);
        assert.deepEqual(cancelled.stats, { cancelled: true });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

void it("times out a silent worker and records a stale-context event durably", async () => {
    const fake = new EventEmitter() as EventEmitter & {
        unref: () => void;
        postMessage: (message: unknown) => void;
        terminate: () => Promise<number>;
    };
    let terminated = false;
    fake.unref = () => {};
    fake.postMessage = () => {};
    fake.terminate = async () => {
        terminated = true;
        return 1;
    };
    await assert.rejects(
        runMaintenanceTask(
            "stage0-retention",
            undefined,
            undefined,
            undefined,
            10,
            () => fake as unknown as Worker
        ),
        /exceeded 10ms deadline/
    );
    assert.equal(terminated, true);

    const event = `stale-ctx-${Date.now()}-${Math.random()}`;
    const logPath = join(tmpdir(), "pi-tau-maintenance.log");
    recordMaintenanceEvent(event, { detail: "test" }, () => {
        throw new Error("stale context");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const log = readFileSync(logPath, "utf8");
    const recorded = log.split("\n").find((line) => line.includes(event));
    assert.ok(recorded);
    assert.match(recorded, /entries_dropped_when_ctx_stale":\d+/);
});
