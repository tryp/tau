import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearAllCompletionBatches,
    flushCompletionBatch,
    notifyCompletion,
    registerBackgroundJobs,
} from "../features/background.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";
import { createJobDonePromise, markJobTerminal } from "../utils.ts";

type TestTool = {
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{
        content: { type: string; text: string }[];
        details?: unknown;
    }>;
};

function makeJob(
    overrides: Partial<BackgroundJob> & { id: string }
): BackgroundJob {
    return {
        command: "test",
        pid: 1,
        startTime: Date.now(),
        status: "running",
        logPath: "/tmp/pi-tau-job-completion-regression.log",
        toolCallId: "tc-regression",
        isBackgrounded: true,
        ...overrides,
    };
}

function registerTestTools(
    state: TauState,
    options: { holdFollowUps?: boolean; staleSend?: boolean } = {}
): {
    jobs: TestTool;
    jobDecide: TestTool;
    pi: { sendMessage(message: unknown): void };
    sentMessages: unknown[];
    sentMessageOptions: unknown[];
    queuedMessages: { message: unknown; options: { queueKey?: string } }[];
    processQueuedMessages: () => void;
    appendedEntries: { customType: string; data: Record<string, unknown> }[];
    cancelledQueueKeys: string[];
    invoke: (event: string) => Promise<void>;
} {
    let jobs: TestTool | undefined;
    let jobDecide: TestTool | undefined;
    const handlers = new Map<string, () => unknown>();
    const sentMessages: unknown[] = [];
    const sentMessageOptions: unknown[] = [];
    const queuedMessages: {
        message: unknown;
        options: { queueKey?: string };
    }[] = [];
    const appendedEntries: {
        customType: string;
        data: Record<string, unknown>;
    }[] = [];
    const cancelledQueueKeys: string[] = [];
    const pi = {
        on(event: string, handler: () => unknown) {
            handlers.set(event, handler);
        },
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "jobs") jobs = tool as TestTool;
            if (tool.name === "job_decide") jobDecide = tool as TestTool;
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerToolPromptGuidelines() {},
        createBashTool: () => ({ execute: async () => ({ content: [] }) }),
        sendMessage(
            message: unknown,
            messageOptions: { deliverAs?: string; queueKey?: string }
        ) {
            if (options.staleSend) {
                throw new Error(
                    "This extension ctx is stale after session replacement or reload"
                );
            }
            sentMessageOptions.push(messageOptions);
            if (
                options.holdFollowUps &&
                messageOptions.deliverAs === "followUp"
            ) {
                queuedMessages.push({ message, options: messageOptions });
            } else {
                sentMessages.push(message);
            }
        },
        appendEntry(customType: string, data: Record<string, unknown>) {
            appendedEntries.push({ customType, data });
        },
        cancelQueuedMessage(queueKey: string) {
            cancelledQueueKeys.push(queueKey);
            const index = queuedMessages.findIndex(
                (item) => item.options.queueKey === queueKey
            );
            if (index === -1) return false;
            queuedMessages.splice(index, 1);
            return true;
        },
    } as never;

    registerBackgroundJobs(pi, state);
    assert.ok(jobs, "jobs tool must be registered");
    assert.ok(jobDecide, "job_decide tool must be registered");
    return {
        jobs,
        jobDecide,
        pi,
        sentMessages,
        sentMessageOptions,
        queuedMessages,
        processQueuedMessages: () => {
            sentMessages.push(
                ...queuedMessages.splice(0).map((item) => item.message)
            );
        },
        appendedEntries,
        cancelledQueueKeys,
        invoke: async (event: string) => {
            await handlers.get(event)?.();
        },
    };
}

function notificationContext() {
    return {
        ui: {
            notify() {},
        },
    } as never;
}

void describe("job completion regression coverage", () => {
    afterEach(() => {
        clearAllCompletionBatches();
    });

    void it("does not retain or count a stale-host completion as queued", () => {
        const state = new TauState();
        const { pi, appendedEntries, cancelledQueueKeys } = registerTestTools(
            state,
            { staleSend: true }
        );
        const job = makeJob({
            id: "job-stale-send-context",
            status: "failed",
            exitCode: 1,
        });
        state.backgroundJobs.set(job.id, job);
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();

        assert.deepEqual(appendedEntries, []);
        state.cancelCompletionBatchForJob?.(job.id);
        assert.deepEqual(
            cancelledQueueKeys.filter((key) =>
                key.startsWith("tau:bg:completion:")
            ),
            []
        );

        const nextState = new TauState();
        const healthy = registerTestTools(nextState);
        const nextJob = makeJob({
            id: "job-after-stale-send",
            status: "failed",
            exitCode: 1,
        });
        nextState.backgroundJobs.set(nextJob.id, nextJob);
        notifyCompletion(
            nextJob,
            nextState,
            healthy.pi as never,
            notificationContext()
        );
        flushCompletionBatch();
        assert.deepEqual(
            healthy.appendedEntries
                .filter(
                    (entry) =>
                        entry.customType === "background-completion-telemetry"
                )
                .map((entry) => ({
                    event: entry.data.event,
                    count: entry.data.count,
                })),
            [
                { event: "stale-context-skipped", count: 1 },
                { event: "queued", count: undefined },
            ]
        );
    });

    void it("prunes completion metadata by session without losing other sessions' keys", () => {
        const firstState = new TauState();
        const first = registerTestTools(firstState, { holdFollowUps: true });
        const oldJob = makeJob({
            id: "job-pruned-old",
            status: "failed",
            exitCode: 1,
        });
        firstState.backgroundJobs.set(oldJob.id, oldJob);
        notifyCompletion(
            oldJob,
            firstState,
            first.pi as never,
            notificationContext()
        );
        flushCompletionBatch();

        firstState.recentTerminalJobs = Array.from(
            { length: 100 },
            (_, index) =>
                makeJob({
                    id: `job-recent-${index}`,
                    status: "failed",
                    exitCode: 1,
                })
        );
        const pruneTrigger = firstState.recentTerminalJobs[0];
        assert.ok(pruneTrigger);
        firstState.backgroundJobs.set(pruneTrigger.id, pruneTrigger);
        notifyCompletion(
            pruneTrigger,
            firstState,
            first.pi as never,
            notificationContext()
        );
        flushCompletionBatch();
        firstState.cancelCompletionBatchForJob?.(oldJob.id);
        assert.deepEqual(
            first.cancelledQueueKeys.filter((key) =>
                key.startsWith("tau:bg:completion:")
            ),
            []
        );

        const secondState = new TauState();
        const second = registerTestTools(secondState, { holdFollowUps: true });
        const secondJob = makeJob({
            id: "job-other-session-live",
            status: "failed",
            exitCode: 1,
        });
        secondState.backgroundJobs.set(secondJob.id, secondJob);
        notifyCompletion(
            secondJob,
            secondState,
            second.pi as never,
            notificationContext()
        );
        flushCompletionBatch();

        // Another prune in the first session must leave the second session's
        // cancellation metadata intact.
        const nextTrigger = makeJob({
            id: "job-prune-again",
            status: "failed",
            exitCode: 1,
        });
        firstState.backgroundJobs.set(nextTrigger.id, nextTrigger);
        notifyCompletion(
            nextTrigger,
            firstState,
            first.pi as never,
            notificationContext()
        );
        flushCompletionBatch();
        secondState.cancelCompletionBatchForJob?.(secondJob.id);
        assert.equal(
            second.cancelledQueueKeys.filter((key) =>
                key.startsWith("tau:bg:completion:")
            ).length,
            1
        );
        assert.equal(second.queuedMessages.length, 0);
    });

    void it("suppresses a queued completion after attach consumes output", async () => {
        const state = new TauState();
        const { jobs, pi, sentMessages } = registerTestTools(state);
        const job = makeJob({
            id: "job-attach-race",
            wantsCompletionNotification: true,
        });
        createJobDonePromise(job);
        state.backgroundJobs.set(job.id, job);

        // This is the panel-1 race: attach is waiting when the process closes;
        // completion delivery is queued before attach consumes the final output.
        const attach = jobs.execute(
            "tc-attach-race",
            { action: "attach", jobId: job.id, wait: true, timeout: 1 },
            undefined,
            undefined,
            undefined
        );
        markJobTerminal(job, "completed", 0);
        notifyCompletion(job, state, pi as never, notificationContext());

        const result = await attach;
        flushCompletionBatch();

        assert.match(result.content[0].text, /Attach finished for/);
        assert.equal(job.outputConsumed, true);
        assert.equal(
            sentMessages.length,
            0,
            "attach-consumed output must suppress the deferred completion"
        );
    });

    void it("restores a cancelled completion for autonomous wake evaluation", () => {
        const state = new TauState();
        const { pi, sentMessages } = registerTestTools(state);
        const job = makeJob({
            id: "job-cancelled-completion",
            status: "completed",
            wantsCompletionNotification: true,
        });
        const wakeEvaluations: number[] = [];
        state.wakeupEvaluate = () => wakeEvaluations.push(1);

        notifyCompletion(job, state, pi as never, notificationContext());
        assert.equal(job.completionNotified, true);
        state.cancelCompletionBatchForJob?.(job.id);
        flushCompletionBatch();

        assert.equal(job.completionNotified, false);
        assert.ok(wakeEvaluations.length >= 1);
        assert.equal(sentMessages.length, 0);
    });

    void it("can re-notify a completion after its queued delivery is cancelled", () => {
        const state = new TauState();
        const { pi, sentMessages } = registerTestTools(state);
        const job = makeJob({
            id: "job-renotify-completion",
            status: "failed",
            wantsCompletionNotification: true,
        });

        notifyCompletion(job, state, pi as never, notificationContext());
        state.cancelCompletionBatchForJob?.(job.id);
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();

        assert.equal(sentMessages.length, 1);
    });

    void it("does not let a stale index callback delete a re-notified completion", async () => {
        const state = new TauState();
        const { pi, sentMessages } = registerTestTools(state);
        let resolveIndex!: () => void;
        const indexPromise = new Promise<undefined>((resolve) => {
            resolveIndex = () => resolve(undefined);
        });
        const job = makeJob({
            id: "job-stale-index-callback",
            status: "failed",
            wantsCompletionNotification: true,
            outputIndexPromise: indexPromise,
        });

        notifyCompletion(job, state, pi as never, notificationContext());
        state.cancelCompletionBatchForJob?.(job.id);
        notifyCompletion(job, state, pi as never, notificationContext());
        resolveIndex();
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(job.completionNotified, true);
        state.cancelCompletionBatchForJob?.(job.id);
        flushCompletionBatch();
        assert.equal(job.completionNotified, false);
        assert.equal(sentMessages.length, 0);
    });

    void it("restores an unacknowledged success when its failed batch item is cancelled", async () => {
        const state = new TauState();
        const { pi, sentMessages, invoke } = registerTestTools(state);
        const failed = makeJob({
            id: "job-mixed-failed",
            status: "failed",
            wantsCompletionNotification: true,
        });
        const completed = makeJob({
            id: "job-mixed-completed",
            status: "completed",
        });
        const wakeEvaluations: number[] = [];
        state.wakeupEvaluate = () => wakeEvaluations.push(1);

        await invoke("agent_start");
        notifyCompletion(failed, state, pi as never, notificationContext());
        notifyCompletion(completed, state, pi as never, notificationContext());
        flushCompletionBatch();
        state.cancelCompletionBatchForJob?.(failed.id);

        assert.equal(completed.completionNotified, false);
        assert.ok(wakeEvaluations.length > 0);
        assert.equal(sentMessages.length, 0);
        await invoke("session_shutdown");
    });

    void it("holds completion delivery until the session is settled", async () => {
        const state = new TauState();
        const { pi, sentMessages, sentMessageOptions, invoke } =
            registerTestTools(state);
        const job = makeJob({
            id: "job-settlement-boundary",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,
        });

        await invoke("agent_start");
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();
        assert.equal(sentMessages.length, 0);

        await invoke("agent_end");
        assert.equal(sentMessages.length, 0);

        await invoke("agent_settled");
        // The flush is deferred by one timer turn; wait for that turn rather
        // than relying on an arbitrary wall-clock delay.
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(sentMessages.length, 1);
        const message = sentMessages[0] as { customType: string };
        assert.equal(message.customType, "job-completion");
        assert.deepEqual(sentMessageOptions[0], {
            deliverAs: "followUp",
            triggerTurn: true,
            queueKey: (sentMessageOptions[0] as { queueKey: string }).queueKey,
        });
        assert.match(
            (sentMessageOptions[0] as { queueKey: string }).queueKey,
            /^tau:bg:completion:[0-9a-f-]{36}:\d+$/
        );
    });

    void it("does not flush a settled batch into a newer agent run", async () => {
        const state = new TauState();
        const { pi, sentMessages, invoke } = registerTestTools(state);
        const job = makeJob({
            id: "job-stale-settled-flush",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,
        });

        await invoke("agent_start");
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();
        await invoke("agent_settled");
        // A new run invalidates the old deferred flush. The completion stays
        // pending and must be delivered only after the newer run settles.
        await invoke("agent_start");
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(sentMessages.length, 0);

        await invoke("agent_settled");
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(sentMessages.length, 1);
    });

    void it("drops deferred completion delivery during shutdown", async () => {
        const state = new TauState();
        const { pi, sentMessages, invoke } = registerTestTools(state);
        const job = makeJob({
            id: "job-shutdown-settled-flush",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,
        });

        await invoke("agent_start");
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();
        await invoke("agent_settled");
        await invoke("session_shutdown");
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(sentMessages.length, 0);
    });

    void it("cancels a queued success after jobs output and records queue telemetry", async () => {
        const state = new TauState();
        const { jobs, pi, queuedMessages, sentMessages, appendedEntries } =
            registerTestTools(state, {
                holdFollowUps: true,
            });
        const dir = mkdtempSync(join(tmpdir(), "tau-completion-queue-"));
        const job = makeJob({
            id: "job-queued-known-success",
            status: "completed",
            exitCode: 0,
            wantsCompletionNotification: true,
            logPath: join(dir, "job.log"),
        });
        writeFileSync(job.logPath, "known success output\n");
        state.backgroundJobs.set(job.id, job);
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();
        assert.equal(queuedMessages.length, 1, "completion must remain queued");

        try {
            await jobs.execute(
                "tc-output-known",
                { action: "output", jobId: job.id },
                null,
                null,
                null
            );
            assert.equal(job.outputConsumed, true);
            assert.equal(
                queuedMessages.length,
                0,
                "acknowledgment cancels queued completion"
            );
            assert.equal(
                sentMessages.length,
                0,
                "known result must not be processed later"
            );
            assert.deepEqual(
                appendedEntries
                    .filter(
                        (entry) =>
                            entry.customType ===
                            "background-completion-telemetry"
                    )
                    .map((entry) => entry.data.event),
                ["queued", "cancelled"]
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("cancels a queued completion when job_decide check acknowledges output", async () => {
        const state = new TauState();
        const { jobDecide, pi, queuedMessages, sentMessages } =
            registerTestTools(state, {
                holdFollowUps: true,
            });
        const dir = mkdtempSync(join(tmpdir(), "tau-completion-check-"));
        const job = makeJob({
            id: "job-decide-check-known",
            status: "failed",
            exitCode: 4,
            logPath: join(dir, "job.log"),
        });
        writeFileSync(job.logPath, "checked failure output\n");
        state.backgroundJobs.set(job.id, job);
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();
        try {
            await jobDecide.execute(
                "tc-check-known",
                { jobId: job.id, decision: "check" },
                null,
                null,
                null
            );
            assert.equal(job.outputConsumed, true);
            assert.equal(queuedMessages.length, 0);
            assert.equal(sentMessages.length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("cancels a queued completion when terminal attach consumes output", async () => {
        const state = new TauState();
        const { jobs, pi, queuedMessages } = registerTestTools(state, {
            holdFollowUps: true,
        });
        const dir = mkdtempSync(join(tmpdir(), "tau-completion-attach-"));
        const job = makeJob({
            id: "job-attach-known",
            status: "failed",
            exitCode: 5,
            logPath: join(dir, "job.log"),
        });
        writeFileSync(job.logPath, "attached failure output\n");
        state.backgroundJobs.set(job.id, job);
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();
        try {
            await jobs.execute(
                "tc-attach-known",
                { action: "attach", jobId: job.id },
                null,
                null,
                null
            );
            assert.equal(job.outputConsumed, true);
            assert.equal(queuedMessages.length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("rebuilds a cancelled batch with only unseen sibling completions", async () => {
        const state = new TauState();
        const {
            jobs,
            pi,
            queuedMessages,
            sentMessages,
            processQueuedMessages,
        } = registerTestTools(state, { holdFollowUps: true });
        const dir = mkdtempSync(join(tmpdir(), "tau-completion-batch-"));
        const known = makeJob({
            id: "job-batch-known",
            status: "failed",
            exitCode: 2,
            logPath: join(dir, "known.log"),
        });
        const unseen = makeJob({
            id: "job-batch-unseen",
            status: "failed",
            exitCode: 3,
            logPath: join(dir, "unseen.log"),
        });
        writeFileSync(known.logPath, "known output\n");
        writeFileSync(unseen.logPath, "unseen output\n");
        state.backgroundJobs.set(known.id, known);
        state.backgroundJobs.set(unseen.id, unseen);
        notifyCompletion(known, state, pi as never, notificationContext());
        notifyCompletion(unseen, state, pi as never, notificationContext());
        flushCompletionBatch();
        assert.equal(queuedMessages.length, 1);
        const originalQueueKey = queuedMessages[0]?.options.queueKey;

        try {
            await jobs.execute(
                "tc-output-known",
                { action: "output", jobId: known.id },
                null,
                null,
                null
            );
            assert.equal(
                queuedMessages.length,
                1,
                "unseen sibling is re-queued"
            );
            assert.notEqual(
                queuedMessages[0]?.options.queueKey,
                originalQueueKey
            );
            processQueuedMessages();
            const message = sentMessages[0] as { content: string };
            assert.ok(message.content.includes(unseen.id));
            assert.ok(!message.content.includes(known.id));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("keeps independent queue keys through agent_start and cancels only the acknowledged job", async () => {
        const state = new TauState();
        const { jobs, pi, queuedMessages, invoke } = registerTestTools(state, {
            holdFollowUps: true,
        });
        const dir = mkdtempSync(join(tmpdir(), "tau-completion-independent-"));
        const first = makeJob({
            id: "job-queue-first",
            status: "failed",
            exitCode: 1,
            logPath: join(dir, "first.log"),
        });
        const second = makeJob({
            id: "job-queue-second",
            status: "failed",
            exitCode: 2,
            logPath: join(dir, "second.log"),
        });
        writeFileSync(first.logPath, "first failure\n");
        writeFileSync(second.logPath, "second failure\n");
        state.backgroundJobs.set(first.id, first);
        state.backgroundJobs.set(second.id, second);
        notifyCompletion(first, state, pi as never, notificationContext());
        flushCompletionBatch();
        notifyCompletion(second, state, pi as never, notificationContext());
        flushCompletionBatch();
        assert.equal(queuedMessages.length, 2);
        const secondQueueKey = queuedMessages[1]?.options.queueKey;

        try {
            await invoke("agent_start");
            await jobs.execute(
                "tc-output-first",
                { action: "output", jobId: first.id },
                null,
                null,
                null
            );
            assert.equal(queuedMessages.length, 1);
            assert.equal(queuedMessages[0]?.options.queueKey, secondQueueKey);
            assert.equal(
                queuedMessages[0]?.message &&
                    (
                        queuedMessages[0].message as { content: string }
                    ).content.includes(second.id),
                true
            );
            await invoke("agent_settled");
            await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("does not re-emit batch siblings after cancellation loses the delivery race", async () => {
        const state = new TauState();
        const {
            pi,
            queuedMessages,
            processQueuedMessages,
            sentMessages,
            appendedEntries,
            invoke,
        } = registerTestTools(state, { holdFollowUps: true });
        const acknowledged = makeJob({
            id: "job-delivered-before-ack",
            status: "failed",
            exitCode: 1,
        });
        const sibling = makeJob({
            id: "job-delivered-sibling",
            status: "failed",
            exitCode: 2,
        });
        notifyCompletion(
            acknowledged,
            state,
            pi as never,
            notificationContext()
        );
        notifyCompletion(sibling, state, pi as never, notificationContext());
        flushCompletionBatch();
        processQueuedMessages();
        await invoke("agent_start");
        state.cancelCompletionBatchForJob?.(acknowledged.id);
        assert.equal(queuedMessages.length, 0);
        assert.equal(
            sentMessages.length,
            1,
            "delivered batch is never re-emitted"
        );
        assert.ok(
            (sentMessages[0] as { content: string }).content.includes(
                sibling.id
            )
        );
        assert.deepEqual(
            appendedEntries
                .filter(
                    (entry) =>
                        entry.customType === "background-completion-telemetry"
                )
                .map((entry) => entry.data.event),
            ["queued", "cancel-miss"]
        );
        await invoke("agent_settled");
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    void it("does not deliver duplicate notifications for one terminal job", async () => {
        const state = new TauState();
        const { pi, sentMessages } = registerTestTools(state);
        const job = makeJob({
            id: "job-duplicate-completion",
            status: "failed",
            exitCode: 1,
            wantsCompletionNotification: true,
        });

        notifyCompletion(job, state, pi as never, notificationContext());
        notifyCompletion(job, state, pi as never, notificationContext());
        flushCompletionBatch();

        assert.equal(sentMessages.length, 1);
        const message = sentMessages[0] as { content: string };
        assert.equal(
            message.content.split(job.id).length - 1,
            1,
            "a terminal job must appear once in completion output"
        );
    });
});
