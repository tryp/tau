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
 * Timing: the direct-route cases use mock timers for the deadline and real
 * payloads whose exit is event-driven (no sleeps in the test code itself;
 * the bounded waitFor polls only for async delivery that the production
 * debounce controls). The tmux case uses a real private tmux session, like
 * tmux-background-completion.test.ts, and requires tmux to be installed.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { registerBackgroundJobs } from "../features/background.ts";
import { getTmuxContext } from "../features/bash-tmux.ts";
import { tmuxTerminalStatus } from "../features/bash-tmux.ts";
import { listWindows, sessionNameForGitRoot } from "../tmux.ts";
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

const TEST_RUN_DIR = `/tmp/pi-tau-deadline-wake-test-${process.pid}`;

function killTestSession(): void {
    try {
        execSync(
            `tmux kill-session -t ${sessionNameForGitRoot(TEST_RUN_DIR)} 2>/dev/null`
        );
    } catch {
        /* already gone */
    }
}

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

/** Bounded real-time poll for async delivery the production debounce owns. */
async function waitFor(
    pred: () => boolean,
    label: string,
    budgetMs = 5000
): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > budgetMs) {
            assert.fail(`timed out waiting for: ${label}`);
        }
        await new Promise((r) => setTimeout(r, 25));
    }
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
            { command: "trap 'exit 0' TERM; sleep 10" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
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
        const started = await h.bashBg.execute(
            "tc-6",
            { command: "sleep 1", timeout: 1 },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        mock.timers.tick(1_000);
        assert.equal(deadlineMessages().length, 1);
        mock.timers.reset();
        await job.donePromise;
        assert.equal(
            job.status,
            "completed",
            "deadline wake is not a completion result"
        );
        assert.ok(job.deadlineFiredAt !== undefined);
        assert.ok(job.deadlineFiredAt >= (job.deadlineRequestedAt as number));
        await waitFor(
            () => h.sent.message.some((m) => m.customType === "job-completion"),
            "completion notification"
        );
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

    void it("attach timeout is wait-only: returns without killing or altering the job", async () => {
        const started = await h.bashBg.execute(
            "tc-7",
            { command: "sleep 5" },
            undefined,
            undefined,
            ctxFor()
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        const before = job.startTime;
        const attachResult = await h.jobs.execute(
            "tc-7a",
            { action: "attach", jobId, timeout: 1, wait: true },
            undefined,
            () => {},
            ctxFor()
        );
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

void describe("bash_bg tmux route notification parity", () => {
    let h: Harness;

    beforeEach(() => {
        killTestSession();
        mkdirSync(TEST_RUN_DIR, { recursive: true });
        execSync("git init -q", { cwd: TEST_RUN_DIR });
        h = makeHarness(true);
    });

    afterEach(() => {
        for (const job of h.state.backgroundJobs.values()) {
            const tmuxCtx = getTmuxContext(job);
            if (tmuxCtx) {
                try {
                    execSync(
                        `tmux kill-window -t ${tmuxCtx.windowId} 2>/dev/null`
                    );
                } catch {
                    /* already gone */
                }
            }
        }
        killTestSession();
        try {
            rmSync(TEST_RUN_DIR, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    });

    void it("arms deadline wake and reminder; the wake does not touch the tmux window", async () => {
        const started = await h.bashBg.execute(
            "tc-t1",
            {
                command: "sleep 5",
                timeout: 1,
                remindDelay: "30s",
                cwd: TEST_RUN_DIR,
            },
            undefined,
            undefined,
            ctxFor(TEST_RUN_DIR)
        );
        const text = started.content[0].text;
        assert.match(
            text,
            /Deadline \(wake, not kill\): 1s/,
            "deadline armed on the tmux route"
        );
        assert.match(
            text,
            /Reminder: cb-\d+ \(in 30s\)/,
            "reminder armed on the tmux route"
        );
        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        const tmuxCtx = getTmuxContext(job);
        assert.ok(tmuxCtx, "job is tmux-backed");

        await waitFor(
            () => h.sent.message.some((m) => m.customType === "bg-deadline"),
            "tmux-route deadline wake"
        );
        const wake = h.sent.message.find(
            (m) => m.customType === "bg-deadline"
        )!;
        assert.match(wake.content!, new RegExp(jobId));
        assert.match(wake.content!, /NOT terminated/);

        const windows = listWindows(sessionNameForGitRoot(TEST_RUN_DIR));
        assert.ok(
            windows.some((w) => w.id === tmuxCtx.windowId),
            "deadline wake must not kill the tmux window"
        );

        await h.jobs.execute(
            "tc-t1k",
            { action: "kill", jobId },
            undefined,
            undefined,
            ctxFor()
        );
        await job.donePromise;
        assert.equal(
            job.status,
            "killed",
            "manual kill + observed window death records killed"
        );
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
