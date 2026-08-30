import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
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

function registerTestTools(state: TauState): {
    jobs: TestTool;
    pi: { sendMessage(message: unknown): void };
    sentMessages: unknown[];
    sentMessageOptions: unknown[];
    invoke: (event: string) => Promise<void>;
} {
    let jobs: TestTool | undefined;
    const handlers = new Map<string, () => unknown>();
    const sentMessages: unknown[] = [];
    const sentMessageOptions: unknown[] = [];
    const pi = {
        on(event: string, handler: () => unknown) {
            handlers.set(event, handler);
        },
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "jobs") jobs = tool as TestTool;
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerToolPromptGuidelines() {},
        createBashTool: () => ({ execute: async () => ({ content: [] }) }),
        sendMessage(message: unknown, options: unknown) {
            sentMessages.push(message);
            sentMessageOptions.push(options);
        },
    } as never;

    registerBackgroundJobs(pi, state);
    assert.ok(jobs, "jobs tool must be registered");
    return {
        jobs,
        pi,
        sentMessages,
        sentMessageOptions,
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
            queueKey: "tau:bg:job-settlement-boundary:completion",
        });
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
