import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flushCompletionBatch } from "../features/background.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";

function persistedJob(
    id: string,
    status: BackgroundJob["status"],
    exitCodeFile: string,
    outputFile: string
): BackgroundJob & { tmux: Record<string, string> } {
    return {
        id,
        command: "echo restored",
        pid: process.pid,
        startTime: Date.now() - 1_000,
        status,
        logPath: outputFile,
        toolCallId: "restored",
        isBackgrounded: true,
        wantsCompletionNotification: true,
        tmux: {
            session: "restore-test",
            windowId: "@999",
            exitCodeFile,
            outputFile,
            gitRoot: tmpdir(),
        },
    };
}

function testRuntime() {
    const sent: unknown[] = [];
    const pi = {
        sendMessage(message: unknown) {
            sent.push(message);
        },
        appendEntry() {},
        cancelQueuedMessage() {
            return false;
        },
    };
    const ctx = {
        cwd: tmpdir(),
        sessionManager: {
            getSessionFile: () => "restore-test.jsonl",
            getSessionId: () => "restore-test",
        },
        ui: { notify() {}, setWidget() {}, setStatus() {} },
    };
    return { pi, ctx, sent };
}

async function restoreFromSession(
    entries: unknown[],
    state: TauState,
    pi: unknown,
    ctx: unknown
): Promise<void> {
    const background =
        (await import("../features/background.ts")) as unknown as {
            restoreBackgroundJobs?: (...args: unknown[]) => void;
        };
    assert.equal(
        typeof background.restoreBackgroundJobs,
        "function",
        "session_start must restore persisted background tasks"
    );
    background.restoreBackgroundJobs?.(entries, state, pi, ctx);
}

function snapshot(job: BackgroundJob, jobCounter = 1) {
    return {
        type: "custom",
        customType: "background-tasks-state",
        data: { jobs: [[job.id, job]], jobCounter },
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (!predicate() && Date.now() < deadline) {
        flushCompletionBatch();
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
        predicate(),
        "restored job did not reach the expected terminal state"
    );
}

void describe("restored background jobs", () => {
    void it("delivers completion when the tmux sentinel appears before deferred restore", async () => {
        const dir = mkdtempSync(
            join(tmpdir(), "pi-tau-restore-deferred-sentinel-")
        );
        try {
            const sentinel = join(dir, "job.exit");
            const output = join(dir, "job.out");
            writeFileSync(output, "finished output\n");
            writeFileSync(sentinel, "0\n");
            const job = persistedJob(
                "restore-deferred-sentinel",
                "running",
                sentinel,
                output
            );
            const state = new TauState();
            const { pi, ctx, sent } = testRuntime();

            // Session shutdown snapshots a still-running task. The command
            // completes and writes its sentinel before the deferred restore runs.
            await restoreFromSession([snapshot(job)], state, pi, ctx);
            assert.equal(job.status, "completed");
            await waitFor(() =>
                sent.some(
                    (message) =>
                        (message as { customType?: string }).customType ===
                        "job-completion"
                )
            );
            flushCompletionBatch();
            assert.ok(
                sent.some(
                    (message) =>
                        (message as { customType?: string }).customType ===
                        "job-completion"
                ),
                "deferred restore must deliver the completion notice"
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
            flushCompletionBatch();
        }
    });

    void it("resumes polling and notifies when a running tmux job later writes its sentinel", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-tau-restore-running-"));
        try {
            const sentinel = join(dir, "job.exit");
            const output = join(dir, "job.out");
            writeFileSync(output, "first output\n");
            const job = persistedJob(
                "restore-running-job",
                "running",
                sentinel,
                output
            );
            const state = new TauState();
            const { pi, ctx, sent } = testRuntime();

            await restoreFromSession([snapshot(job)], state, pi, ctx);
            assert.equal(state.backgroundJobs.get(job.id)?.status, "running");
            setTimeout(() => writeFileSync(sentinel, "0\n"), 50);
            await waitFor(() => job.status === "completed");
            await waitFor(() =>
                sent.some(
                    (message) =>
                        (message as { customType?: string }).customType ===
                        "job-completion"
                )
            );
            flushCompletionBatch();

            assert.ok(
                sent.some(
                    (message) =>
                        (message as { customType?: string }).customType ===
                        "job-completion"
                ),
                "restored completion must be delivered as a job-completion message"
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
            flushCompletionBatch();
        }
    });

    void it("finalizes a restored job when its tmux window vanished without a sentinel", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-tau-restore-vanished-"));
        const oldPath = process.env.PATH;
        const oldCadence = process.env.PI_TAU_TMUX_LIVENESS_POLL_EVERY;
        try {
            const tmux = join(dir, "tmux");
            writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
            chmodSync(tmux, 0o755);
            process.env.PATH = `${dir}${oldPath ? `:${oldPath}` : ""}`;
            process.env.PI_TAU_TMUX_LIVENESS_POLL_EVERY = "1";
            const job = persistedJob(
                "restore-vanished-job",
                "running",
                join(dir, "missing.exit"),
                join(dir, "job.out")
            );
            const state = new TauState();
            const { pi, ctx, sent } = testRuntime();

            await restoreFromSession([snapshot(job)], state, pi, ctx);
            await waitFor(() => job.status === "failed");
            await waitFor(() =>
                sent.some(
                    (message) =>
                        (message as { customType?: string }).customType ===
                        "job-completion"
                )
            );
            flushCompletionBatch();
            assert.ok(
                sent.some(
                    (message) =>
                        (message as { customType?: string }).customType ===
                        "job-completion"
                )
            );
        } finally {
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            if (oldCadence === undefined)
                delete process.env.PI_TAU_TMUX_LIVENESS_POLL_EVERY;
            else process.env.PI_TAU_TMUX_LIVENESS_POLL_EVERY = oldCadence;
            rmSync(dir, { recursive: true, force: true });
            flushCompletionBatch();
        }
    });

    void it("restores the newest background-task snapshot, not the oldest", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-tau-restore-newest-"));
        try {
            const old = persistedJob(
                "snapshot-job",
                "running",
                join(dir, "old.exit"),
                join(dir, "old.out")
            );
            const newest = persistedJob(
                "snapshot-job",
                "completed",
                join(dir, "new.exit"),
                join(dir, "new.out")
            );
            newest.exitCode = 0;
            const state = new TauState();
            const { pi, ctx } = testRuntime();

            await restoreFromSession(
                [snapshot(old), snapshot(newest, 2)],
                state,
                pi,
                ctx
            );

            assert.equal(
                state.backgroundJobs.get(newest.id)?.status,
                "completed"
            );
            assert.equal(state.jobCounter, 2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            flushCompletionBatch();
        }
    });
});
