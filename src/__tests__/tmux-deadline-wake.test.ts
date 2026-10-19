/**
 * Real-tmux integration coverage for bash_bg deadline notification parity.
 * The deterministic deadline and no-signal unit cases live in
 * bg-deadline-wake.unit.test.ts; this suite proves the tmux backend keeps its
 * window alive when the decision deadline wakes the agent.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { registerBackgroundJobs } from "../features/background.ts";
import { getTmuxContext } from "../features/bash-tmux.ts";
import { listWindows, sessionNameForGitRoot } from "../tmux.ts";
import { TauState } from "../state.ts";
import type { JobResultDetails } from "../types.ts";

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

function makeHarness() {
    const state = new TauState();
    state.tmuxAvailable = true;
    let bashBg: Tool | undefined;
    let jobs: Tool | undefined;
    const sent: { message: { customType?: string; content?: string }[] } = {
        message: [],
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
        sendMessage(message: { customType?: string; content?: string }) {
            sent.message.push(message);
        },
    } as never;
    registerBackgroundJobs(pi, state);
    assert.ok(bashBg, "bash_bg tool must be registered");
    assert.ok(jobs, "jobs tool must be registered");
    return { bashBg, jobs, state, sent };
}

function ctxFor(cwd: string) {
    return { cwd, ui: { notify() {}, setWidget() {}, setStatus() {} } };
}

async function waitForDeadlineWake(
    sent: { message: { customType?: string }[] },
    budgetMs = 5_000
): Promise<void> {
    const start = Date.now();
    while (
        !sent.message.some((message) => message.customType === "bg-deadline")
    ) {
        if (Date.now() - start > budgetMs) {
            assert.fail("timed out waiting for tmux-route deadline wake");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

void describe("tmux bash_bg decision deadline integration", () => {
    let h: ReturnType<typeof makeHarness>;

    beforeEach(() => {
        killTestSession();
        mkdirSync(TEST_RUN_DIR, { recursive: true });
        execSync("git init -q", { cwd: TEST_RUN_DIR });
        h = makeHarness();
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
        rmSync(TEST_RUN_DIR, { recursive: true, force: true });
    });

    void it("arms the deadline and reminder; wake fires once without killing the window", async () => {
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
        assert.match(text, /Deadline \(wake, not kill\): 1s/);
        assert.match(text, /Reminder: cb-\d+ \(in 30s\)/);

        const jobId = (started.details as JobResultDetails).jobId!;
        const job = h.state.backgroundJobs.get(jobId)!;
        const tmuxCtx = getTmuxContext(job);
        assert.ok(tmuxCtx, "job is tmux-backed");

        await waitForDeadlineWake(h.sent);
        const wakes = h.sent.message.filter(
            (message) => message.customType === "bg-deadline"
        );
        assert.equal(wakes.length, 1, "deadline wake fires exactly once");
        assert.match(wakes[0].content!, new RegExp(jobId));
        assert.match(wakes[0].content!, /NOT terminated/);

        const windows = listWindows(sessionNameForGitRoot(TEST_RUN_DIR));
        assert.ok(
            windows.some((window) => window.id === tmuxCtx.windowId),
            "deadline wake must not kill the tmux window"
        );

        await h.jobs.execute(
            "tc-t1k",
            { action: "kill", jobId },
            undefined,
            undefined,
            ctxFor(TEST_RUN_DIR)
        );
        await job.donePromise;
        assert.equal(
            job.status,
            "killed",
            "explicit kill + observed window death"
        );
    });
});
