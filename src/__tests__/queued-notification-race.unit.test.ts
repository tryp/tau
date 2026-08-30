/**
 * Reproduces stale background notifications when pi queues extension
 * follow-ups while the agent is busy.
 *
 * The real session observed bg-timeout/bg-stall messages 5.8–73 minutes
 * after their jobs had completed or been killed. pi-tau emits these messages
 * with deliverAs: "followUp"; pi-mono queues them until the agent settles.
 * These tests model that queue boundary and enforce deterministic cancellation.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    cancelQueuedBackgroundNotification,
    startStallWatchdog,
} from "../features/background.ts";
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
    options?: {
        deliverAs?: string;
        triggerTurn?: boolean;
        queueKey?: string;
    };
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
            cancelQueuedMessage(queueKey: string) {
                const remaining = queued.filter(
                    (item) => item.options?.queueKey !== queueKey
                );
                queued.splice(0, queued.length, ...remaining);
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

    void it("cancels a queued stall warning when terminal knowledge supersedes it", () => {
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

        // The completion path wins before the agent settles. The terminal
        // result supersedes the queued warning at a deterministic boundary.
        job.status = "completed";
        cancelQueuedBackgroundNotification(queue.pi, job.id, "stall");
        assert.equal(queue.queued.length, 0);
        queue.settle();

        assert.equal(queue.delivered.length, 0);
    });

    void it("cannot retract a warning after the delivery boundary", () => {
        const queue = makeQueuedPi();
        (
            queue.pi as {
                sendMessage(
                    message: Message,
                    options?: QueuedMessage["options"]
                ): void;
            }
        ).sendMessage(
            {
                customType: "bg-stall",
                content: "already delivered",
            },
            {
                deliverAs: "followUp",
                queueKey: "tau:bg:job-delivered:stall",
            }
        );
        queue.settle();

        cancelQueuedBackgroundNotification(queue.pi, "job-delivered", "stall");
        assert.equal(queue.delivered.length, 1);
        assert.equal(queue.delivered[0]?.message.content, "already delivered");
    });
});
