/**
 * Deadline-wake and honest-completion regressions for bash_bg.
 *
 * Owner policy (2026-10-19 repair): bash_bg.timeout is a decision deadline.
 * When it fires the agent is woken once to inspect progress and decide
 * (extend, jobs kill, ignore). The job is NEVER terminated by the deadline,
 * on any backend — tmux and direct spawn get identical arming (notification
 * parity; the tmux route previously dropped both timeout and remindDelay).
 *
 * Honesty contract: a termination request (manual kill, stall watchdog) is
 * recorded separately from the observed exit. A request is never reported as
 * an observed kill, a SIGTERM-ignoring survivor is never recorded as killed
 * while alive, and a job completing after its deadline fired reports
 * completed with deadlineFiredAt retained — a deadline wake is not a
 * completion result.
 *
 * Timing: unit cases use mock timers for deadline and completion-notification
 * delivery. The real private tmux wake/parity test lives in
 * tmux-deadline-wake.test.ts, like tmux-background-completion.test.ts.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import {
    flushCompletionBatch,
    registerBackgroundJobs,
} from "../features/background.ts";
import { tmuxTerminalStatus } from "../features/bash-tmux.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob, JobResultDetails } from "../types.ts";

type ToolResult = {
    content: { type: string; text: string }[];
    details?: JobResultDetails;
};

type Tool = {
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<ToolResult>;
};

interface Harness {
    bashBg: Tool;
    jobs: Tool;
    state: TauState;
    sent: {
        message: { customType?: string; content?: string }[];
        options: unknown[];
    };
    pi: never;
}

function makeHarness(tmuxAvailable: boolean): Harness {
    const state = new TauState();
    state.tmuxAvailable = tmuxAvailable;
    let bashBg: Tool | undefined;
    let jobs: Tool | undefined;
    const sent: {
        message: { customType?: string; content?: string }[];
        options: unknown[];
    } = {
        message: [],
        options: [],
    };
    const pi = {
        on() {},
        registerTool(tool: { name: string; execute: unknown }) {
            if (tool.name === "bash_bg") bashBg = tool as Tool;
            if (tool.name === "jobs") jobs = tool as Tool;
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerToolPromptGuidelines() {},
        createBashTool: () => ({ execute: async () => ({ content: [] }) }),
        sendMessage(
            message: { customType?: string; content?: string },
            options: unknown
        ) {
            sent.message.push(message);
            sent.options.push(options);
        },
    } as never;

    registerBackgroundJobs(pi, state);
    assert.ok(bashBg, "bash_bg tool must be registered");
    assert.ok(jobs, "jobs tool must be registered");
    return { bashBg, jobs, state, sent, pi };
}

function ctxFor(cwd?: string): unknown {
    return {
        cwd: cwd ?? process.cwd(),
        ui: { notify() {}, setWidget() {}, setStatus() {} },
    };
}

function killGroup(job: BackgroundJob): void {
    try {
        execSync(
            `kill -9 -${job.pid} 2>/dev/null || kill -9 ${job.pid} 2>/dev/null`
        );
    } catch {
        /* already dead */
    }
}

void describe("bash_bg deadline wake (decision deadline, never a kill)", () => {
    let h: Harness;
    let killSpy: ReturnType<typeof mock.method> | undefined;

    function sigtermCount(): number {
        return (
            killSpy?.mock.calls.filter((c) => c.arguments[1] === "SIGTERM")
                .length ?? 0
        );
    }

    function deadlineMessages(): { customType?: string; content?: string }[] {
        return h.sent.message.filter((m) => m.customType === "bg-deadline");
    }

    beforeEach(() => {
        h = makeHarness(false);
        killSpy = mock.method(process, "kill", () => true);
    });

    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
        killSpy = undefined;
        for (const job of h.state.backgroundJobs.values()) {
            if (job.pid > 0 && job.status === "running") killGroup(job);
        }
    });

    void it("wakes exactly once at the deadline and sends no signal (direct route)", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        const started = await h.bashBg.execute(
            "tc-1",
            { command: "sleep 30", timeout: 5 },
            undefined,
            undefined,
            ctxFor()
        );
        assert.match(
            started.content[0].text,
            /Deadline \(wake, not kill\): 5s/
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        assert.equal(job.status, "running");
        assert.ok(job.deadlineRequestedAt !== undefined);

        mock.timers.tick(5_000);
        assert.equal(deadlineMessages().length, 1, "wake fires once");
        const wake = deadlineMessages()[0];
        assert.match(wake.content!, new RegExp(jobId));
        assert.match(wake.content!, /NOT terminated/);
        assert.match(wake.content!, /jobs kill/);
        // The deadline path must not signal: supervision wakes, it does not kill.
        assert.equal(sigtermCount(), 0);
        assert.equal(
            job.status,
            "running",
            "job keeps running past the deadline"
        );

        mock.timers.tick(60_000);
        assert.equal(deadlineMessages().length, 1, "wake never repeats");
        assert.equal(sigtermCount(), 0);

        // Cleanup via the explicit kill path (the only termination route).
        killGroup(job);
    });

    void it("completion before the deadline cancels the wake", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        const started = await h.bashBg.execute(
            "tc-2",
            { command: "true", timeout: 3600 },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        await job.donePromise;
        assert.equal(job.status, "completed");
        assert.equal(job.deadlineFiredAt, undefined);
        mock.timers.tick(3_600_000);
        assert.equal(
            deadlineMessages().length,
            0,
            "no wake after observed completion"
        );
    });

    void it("invalid timeout or remindDelay is refused before any job exists", async () => {
        for (const timeout of [0, -1, NaN, Infinity]) {
            await assert.rejects(
                h.bashBg.execute(
                    "tc-3",
                    { command: "true", timeout },
                    undefined,
                    undefined,
                    ctxFor()
                )
            );
        }
        await assert.rejects(
            h.bashBg.execute(
                "tc-3",
                { command: "true", remindDelay: "nope" },
                undefined,
                undefined,
                ctxFor()
            )
        );
        await assert.rejects(
            h.bashBg.execute(
                "tc-3",
                { command: "true", remindDelay: "0s" },
                undefined,
                undefined,
                ctxFor()
            )
        );
        await assert.rejects(
            h.bashBg.execute(
                "tc-3",
                { command: "true", timeout: 5, remindDelay: "later" },
                undefined,
                undefined,
                ctxFor()
            )
        );
        assert.equal(
            h.state.backgroundJobs.size,
            0,
            "no job may exist for a refused request"
        );
    });

    void it("termination request followed by a clean exit reports completed, not killed", async () => {
        const started = await h.bashBg.execute(
            "tc-4",
            { command: "trap 'exit 0' TERM; while :; do sleep 1; done" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        // Let this case deliver the explicit signal; other tests keep the
        // process.kill spy to assert that the deadline itself never signals.
        killSpy?.mock.restore();
        await h.jobs.execute(
            "tc-4k",
            { action: "kill", jobId },
            undefined,
            undefined,
            ctxFor()
        );
        await job.donePromise;
        // The workload handled TERM itself and exited 0: the honest outcome is
        // completed with the request visible, never a fabricated killed.
        assert.equal(job.status, "completed");
        assert.equal(job.exitCode, 0);
        assert.equal(job.terminationRequestedBy, "manual");
        assert.ok(job.terminationRequestedAt !== undefined);
    });

    void it("a SIGTERM-ignoring survivor stays running until a signal death is observed", async () => {
        const started = await h.bashBg.execute(
            "tc-5",
            { command: "trap '' TERM; sleep 30" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        await h.jobs.execute(
            "tc-5k",
            { action: "kill", jobId },
            undefined,
            undefined,
            ctxFor()
        );
        // The old code marked the job killed here while the workload was
        // still alive. The honest record keeps it running.
        assert.equal(job.status, "running");
        assert.equal(job.terminationRequestedBy, "manual");
        killGroup(job);
        await job.donePromise;
        assert.equal(
            job.status,
            "killed",
            "observed signal death records killed"
        );
    });

    void it("a job completing after its deadline fired reports completed with deadlineFiredAt", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        const completionMarker = `/tmp/pi-tau-deadline-completion-${process.pid}-${Date.now()}`;
        rmSync(completionMarker, { force: true });
        const started = await h.bashBg.execute(
            "tc-6",
            {
                command: `while [ ! -e '${completionMarker}' ]; do sleep 0.01; done`,
                timeout: 1,
            },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        mock.timers.tick(1_000);
        assert.equal(deadlineMessages().length, 1);
        assert.equal(job.status, "running", "deadline only wakes the agent");
        writeFileSync(completionMarker, "done");
        await job.donePromise;
        rmSync(completionMarker, { force: true });
        assert.equal(
            job.status,
            "completed",
            "deadline wake is not a completion result"
        );
        assert.ok(job.deadlineFiredAt !== undefined);
        assert.ok(job.deadlineFiredAt >= (job.deadlineRequestedAt as number));
        // Output indexing gates notification enqueue. Await that owned work,
        // then flush the batch directly rather than polling the debounce timer.
        await job.outputIndexPromise;
        flushCompletionBatch();
        const completion = h.sent.message.find(
            (m) => m.customType === "job-completion"
        )!;
        assert.match(completion.content!, new RegExp(`${jobId}.*completed`));
        assert.match(completion.content!, /deadline fired \(wake only\)/);
        assert.doesNotMatch(
            completion.content!,
            new RegExp(`${jobId}.*killed`)
        );
    });

    void it("attach returns completed output inline before the cutoff and consumes it", async () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const started = await h.bashBg.execute(
            "tc-inline",
            { command: "printf 'quick result'; sleep 30" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        let progressResolve!: () => void;
        const firstProgress = new Promise<void>((resolve) => {
            progressResolve = resolve;
        });
        const attachPromise = h.jobs.execute(
            "tc-inline-attach",
            { action: "attach", jobId },
            undefined,
            progressResolve,
            ctxFor()
        );
        await firstProgress;
        job.proc!.emit("close", 0);
        const result = await attachPromise;
        assert.match(result.content[0].text, /Attach finished/);
        assert.match(result.content[0].text, /quick result/);
        assert.equal(job.status, "completed");
        assert.equal(job.outputConsumed, true);
        killGroup(job);
    });

    void it("inline cutoff returns a resumable handle and later completion notifies once", async () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const started = await h.bashBg.execute(
            "tc-inline-cutoff",
            { command: "trap '' TERM; sleep 30" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        let progressResolve!: () => void;
        const firstProgress = new Promise<void>((resolve) => {
            progressResolve = resolve;
        });
        const attachPromise = h.jobs.execute(
            "tc-inline-cutoff-attach",
            { action: "attach", jobId },
            undefined,
            progressResolve,
            ctxFor()
        );
        await firstProgress;
        mock.timers.tick(30_000);
        const result = await attachPromise;
        assert.match(result.content[0].text, /still running/);
        assert.match(result.content[0].text, /partial output/);
        assert.match(result.content[0].text, new RegExp(`Job ID: ${jobId}`));
        assert.equal(result.details?.jobId, jobId);
        assert.equal(result.details?.status, "running");
        assert.equal(job.outputConsumed, undefined);

        // Exercise the normal proc-close completion path after attach returned.
        job.proc!.emit("close", 0);
        await job.outputIndexPromise;
        flushCompletionBatch();
        assert.equal(
            h.sent.message.filter((m) => m.customType === "job-completion").length,
            1
        );
        killGroup(job);
    });

    void it("reattaching to completed output consumes it and suppresses stale completion", async () => {
        const started = await h.bashBg.execute(
            "tc-reattach-consume",
            { command: "trap '' TERM; sleep 30" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        job.proc!.emit("close", 0);
        const result = await h.jobs.execute(
            "tc-reattach-consume-attach",
            { action: "attach", jobId, wait: false },
            undefined,
            undefined,
            ctxFor()
        );
        assert.match(result.content[0].text, /Attach finished/);
        assert.equal(job.outputConsumed, true);
        await job.outputIndexPromise;
        flushCompletionBatch();
        assert.equal(
            h.sent.message.filter((m) => m.customType === "job-completion").length,
            0
        );
        killGroup(job);
    });

    void it("attach timeout is wait-only: returns without killing or altering the job", async () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const started = await h.bashBg.execute(
            "tc-7",
            { command: "trap '' TERM; sleep 30" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        const before = job.startTime;
        let progressResolve!: () => void;
        const firstProgress = new Promise<void>((resolve) => {
            progressResolve = resolve;
        });
        const attachPromise = h.jobs.execute(
            "tc-7a",
            { action: "attach", jobId, timeout: 1, wait: true },
            undefined,
            progressResolve,
            ctxFor()
        );
        // Let attach reach its polling wait, then advance its fake clock.
        await firstProgress;
        mock.timers.tick(1_000);
        const attachResult = await attachPromise;
        assert.match(attachResult.content[0].text, /running/);
        assert.equal(
            job.status,
            "running",
            "attach must not terminate the job"
        );
        assert.equal(
            job.startTime,
            before,
            "attach must not reset the job clock"
        );
        assert.equal(sigtermCount(), 0, "attach must not signal");
        killGroup(job);
    });

    void it("direct route arms the linked reminder before the started result", async () => {
        const started = await h.bashBg.execute(
            "tc-8",
            {
                command: "true",
                remindDelay: "30s",
                remindMessage: "check the build",
            },
            undefined,
            undefined,
            ctxFor()
        );
        assert.match(started.content[0].text, /Reminder: cb-\d+ \(in 30s\)/);
    });
});

void describe("honest terminal-status mapping", () => {
    void it("tmux: vanished window after a termination request records killed", () => {
        const job = {
            terminationRequestedAt: 1,
            terminationRequestedBy: "manual",
        } as BackgroundJob;
        assert.equal(tmuxTerminalStatus(job, undefined), "killed");
        assert.equal(tmuxTerminalStatus(job, 143), "killed");
        assert.equal(tmuxTerminalStatus(job, 137), "killed");
    });

    void it("tmux: a clean sentinel exit after a request is completed, not killed", () => {
        const job = {
            terminationRequestedAt: 1,
            terminationRequestedBy: "manual",
        } as BackgroundJob;
        assert.equal(tmuxTerminalStatus(job, 0), "completed");
        assert.equal(tmuxTerminalStatus(job, 3), "failed");
    });

    void it("tmux: without a request the prior mapping is preserved", () => {
        const job = {} as BackgroundJob;
        assert.equal(
            tmuxTerminalStatus(job, undefined),
            "failed",
            "vanished with no request stays failed"
        );
        assert.equal(tmuxTerminalStatus(job, 0), "completed");
        assert.equal(tmuxTerminalStatus(job, 1), "failed");
    });
});
