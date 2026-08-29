/**
 * Reproduces stale background notifications when pi queues extension
 * follow-ups while the agent is busy.
 *
 * The real session observed bg-timeout/bg-stall messages 5.8–73 minutes
 * after their jobs had completed or been killed. pi-tau emits these messages
 * with deliverAs: "followUp"; pi-mono queues them until the agent settles.
 * This test models that queue boundary and records the current bug.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStallWatchdog } from "../features/background.ts";
import { TauState } from "../state.ts";
import { STALL_CHECK_INTERVAL_MS, STALL_THRESHOLD_MS } from "../utils.ts";
import type { BackgroundJob } from "../types.ts";

interface Message {
    customType?: string;
    content?: string;
    details?: Record<string, unknown>;
}

interface QueuedMessage {
    message: Message;
    options?: { deliverAs?: string; triggerTurn?: boolean };
}

function makeQueuedPi(): {
    pi: never;
    queued: QueuedMessage[];
    delivered: QueuedMessage[];
    settle(): void;
} {
    let busy = true;
    const queued: QueuedMessage[] = [];
    const delivered: QueuedMessage[] = [];
    return {
        pi: {
            sendMessage(message: Message, options?: QueuedMessage["options"]) {
                const item = { message, options };
                if (busy && options?.deliverAs === "followUp")
                    queued.push(item);
                else delivered.push(item);
            },
        } as never,
        queued,
        delivered,
        settle() {
            busy = false;
            delivered.push(...queued.splice(0));
        },
    };
}

const STALL_TICKS =
    Math.ceil(
        (STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS) / STALL_CHECK_INTERVAL_MS
    ) + 1;

void describe("queued background notification race", () => {
    let dir: string;
    let logPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-tau-queued-warning-"));
        logPath = join(dir, "job.out");
        writeFileSync(logPath, "");
        mock.timers.enable({ apis: ["setInterval", "Date"] });
    });

    afterEach(() => {
        mock.timers.reset();
        rmSync(dir, { recursive: true, force: true });
    });

    void it("REPRODUCER: delivers a queued stall warning after the job is terminal", () => {
        const state = new TauState();
        const job: BackgroundJob = {
            id: "job-queued-stall",
            command: "silent command",
            pid: 1,
            startTime: Date.now(),
            status: "running",
            logPath,
            toolCallId: "tc-queued-stall",
            isBackgrounded: true,
        };
        state.backgroundJobs.set(job.id, job);
        const queue = makeQueuedPi();

        const cancel = startStallWatchdog(
            job.id,
            job.command,
            logPath,
            queue.pi,
            state
        );
        for (let i = 0; i < STALL_TICKS; i++) {
            mock.timers.tick(STALL_CHECK_INTERVAL_MS);
        }
        cancel();

        assert.equal(queue.queued.length, 1);
        assert.equal(queue.delivered.length, 0);

        // The completion path wins before the agent settles. pi-tau's
        // sendMessage call is already inside pi-mono's follow-up queue and
        // cannot currently be retracted.
        job.status = "completed";
        queue.settle();

        assert.equal(queue.delivered.length, 1);
        assert.equal(queue.delivered[0]?.message.customType, "bg-stall");
        assert.match(
            queue.delivered[0]?.message.content ?? "",
            /job-queued-stall/
        );
    });

    void it.todo(
        "suppresses queued bg-timeout/bg-stall messages when their job becomes terminal before delivery"
    );
});
