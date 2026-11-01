import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BG_WAIT_HEARTBEAT_INTERVAL_MS,
    RUNNING_JOBS_WIDGET_REFRESH_MS,
    createBgWaitHeartbeat,
    createRunningJobsWidgetRefresh,
    updateWidget,
} from "../features/background.ts";
import { TauState } from "../state.ts";

void describe("background job live progress", () => {
    void it("repaints the jobs widget while a job runs and stops after terminal state", () => {
        const state = new TauState();
        state.backgroundJobs.set("job-live", {
            id: "job-live",
            command: "long-running command",
            startTime: 0,
            status: "running",
            isBackgrounded: true,
        } as never);

        let widgetWrites = 0;
        let now = 0;
        const ctx = {
            ui: {
                setWidget: () => widgetWrites++,
                setStatus: () => {},
                theme: { fg: (_accent: string, text: string) => text },
            },
        } as never;

        updateWidget(state, ctx);
        const refresh = createRunningJobsWidgetRefresh(state, ctx, () => now);
        for (let tick = 1; tick <= 10; tick++) {
            now = tick * 1_000;
            refresh();
        }
        assert.equal(
            widgetWrites,
            3,
            `initial render plus two ${RUNNING_JOBS_WIDGET_REFRESH_MS}ms refreshes`
        );

        (state.backgroundJobs.get("job-live") as { status: string }).status =
            "completed";
        updateWidget(state, ctx);
        const writesAfterTerminal = widgetWrites;
        for (let tick = 11; tick <= 20; tick++) {
            now = tick * 1_000;
            refresh();
        }
        assert.equal(
            widgetWrites,
            writesAfterTerminal,
            "refresh callback must become inert after no jobs remain running"
        );
    });

    void it("emits job wait heartbeats at a throttled rate with elapsed time and log bytes", () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-tau-wait-heartbeat-"));
        try {
            const logPath = join(dir, "job.out");
            writeFileSync(logPath, "123");
            let now = 0;
            const updates: Array<{ text: string }> = [];
            const heartbeat = createBgWaitHeartbeat(
                "tmux-test-1",
                0,
                logPath,
                (update) => {
                    updates.push({
                        text:
                            update.content[0]?.type === "text"
                                ? update.content[0].text
                                : "",
                    });
                },
                () => now
            );

            for (let tick = 1; tick <= 10; tick++) {
                now = tick * 1_000;
                heartbeat();
            }

            assert.equal(
                updates.length,
                2,
                `ten 1s polls should emit about one update per ${BG_WAIT_HEARTBEAT_INTERVAL_MS}ms`
            );
            assert.match(updates[0].text, /tmux-test-1/);
            assert.match(updates[0].text, /elapsedMs=5000/);
            assert.match(updates[0].text, /logBytes=3/);
            assert.match(updates[1].text, /elapsedMs=10000/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
