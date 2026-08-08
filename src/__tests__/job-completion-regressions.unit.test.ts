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
} {
    let jobs: TestTool | undefined;
    const sentMessages: unknown[] = [];
    const pi = {
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "jobs") jobs = tool as TestTool;
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerToolPromptGuidelines() {},
        createBashTool: () => ({ execute: async () => ({ content: [] }) }),
        sendMessage(message: unknown) {
            sentMessages.push(message);
        },
    } as never;

    registerBackgroundJobs(pi, state);
    assert.ok(jobs, "jobs tool must be registered");
    return { jobs, pi, sentMessages };
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
