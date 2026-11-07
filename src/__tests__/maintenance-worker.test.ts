import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
    flushMaintenanceEvents,
    recordMaintenanceEvent,
} from "../maintenance/events.ts";
import { runMaintenanceTask } from "../maintenance/client.ts";

interface WorkerResult {
    ok: boolean;
    task: string;
    stats: {
        filesVisited?: number;
        deletedPaths?: string[];
        cancelled?: boolean;
    };
    type?: "progress";
    durationMs?: number;
}

function runWorker(directory: string, cancel = false): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            new URL("../maintenance/runner.ts", import.meta.url)
        );
        worker.on("message", (message: WorkerResult) => {
            if (message.type !== "progress") resolve(message);
        });
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

void it("does not spawn a worker when maintenance is disabled", async () => {
    const previous = process.env.PI_TAU_MAINTENANCE_DISABLE;
    process.env.PI_TAU_MAINTENANCE_DISABLE = "1";
    let spawned = false;
    try {
        const result = await runMaintenanceTask(
            "stage0-retention",
            undefined,
            undefined,
            undefined,
            100,
            () => {
                spawned = true;
                throw new Error("worker should not spawn");
            }
        );
        assert.equal(spawned, false);
        assert.equal((result as { cancelled?: boolean }).cancelled, true);
    } finally {
        if (previous === undefined)
            delete process.env.PI_TAU_MAINTENANCE_DISABLE;
        else process.env.PI_TAU_MAINTENANCE_DISABLE = previous;
    }
});

void it("settles an erroring worker once without later timing out", async () => {
    const fake = new EventEmitter() as EventEmitter & {
        unref: () => void;
        postMessage: (message: unknown) => void;
        terminate: () => Promise<number>;
    };
    fake.unref = () => {};
    fake.postMessage = () => fake.emit("error", new Error("worker failed"));
    fake.terminate = async () => 1;
    await assert.rejects(
        runMaintenanceTask(
            "stage0-retention",
            undefined,
            undefined,
            undefined,
            100,
            () => fake as unknown as Worker
        ),
        /worker failed/
    );
    fake.emit("exit", 0);
});

void it("stops a real stage0 worker after mid-flight cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-maintenance-cancel-"));
    const count = 1_500;
    try {
        for (let index = 0; index < count; index++) {
            writeFileSync(join(directory, `pi-pipe-stage0-${index}.log`), "x");
        }
        const worker = new Worker(
            new URL("../maintenance/runner.ts", import.meta.url)
        );
        const result = new Promise<WorkerResult>((resolve, reject) => {
            worker.on("message", (message: WorkerResult) => {
                if (message.type === "progress") {
                    worker.postMessage({ cancel: true });
                    return;
                }
                resolve(message);
            });
            worker.once("error", reject);
        });
        worker.postMessage({
            task: "stage0-retention",
            options: { directories: [directory], budgetBytes: 1 },
        });
        const completed = await result;
        assert.equal(completed.ok, true);
        assert.equal(completed.stats.cancelled, true);
        const filesVisited = completed.stats.filesVisited ?? 0;
        assert.ok(filesVisited > 0, "worker must visit files before cancellation");
        assert.ok(filesVisited < count, "cancellation must stop the inventory early");
        await worker.terminate();
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
            100,
            () => fake as unknown as Worker
        ),
        /exceeded 100ms deadline/
    );
    assert.equal(terminated, true);

    const event = `stale-ctx-${Date.now()}-${Math.random()}`;
    const logPath = join(tmpdir(), "pi-tau-maintenance.log");
    recordMaintenanceEvent(event, { detail: "test" }, () => {
        throw new Error("stale context");
    });
    await flushMaintenanceEvents();
    const log = readFileSync(logPath, "utf8");
    const recorded = log.split("\n").find((line) => line.includes(event));
    assert.ok(recorded);
    assert.match(recorded, /entries_dropped_when_ctx_stale":\d+/);
    assert.match(recorded, /worker_timeouts":[1-9]\d*/);
});
