import { parentPort } from "node:worker_threads";
import { cleanupStaleTmuxRunDirsAsync } from "../features/bash-tmux.ts";
import { reapOrphanedTmuxProcesses } from "../features/tmux-orphan-reaper.ts";
import {
    sweepStage0Captures,
    type Stage0SweepOptions,
} from "../features/pipe-nerf/stage0-retention.ts";

interface Request {
    task: "stage0-retention" | "tmux-sweep";
    options?: Stage0SweepOptions;
}

if (!parentPort) throw new Error("maintenance runner must execute in a worker");

let cancelled = false;
let started = false;
const handleMessage = async (message: Request | { cancel?: boolean }) => {
    if ("cancel" in message && message.cancel) {
        cancelled = true;
        return;
    }
    if (started || !("task" in message)) return;
    started = true;
    const request = message;
    const startedAt = performance.now();
    try {
        if (cancelled) {
            parentPort!.postMessage({
                ok: true,
                task: request.task,
                stats: { cancelled: true },
            });
            parentPort!.close();
            return;
        }
        const stats =
            request.task === "stage0-retention"
                ? await sweepStage0Captures({
                      ...request.options!,
                      shouldContinue: () => !cancelled,
                  })
                : {
                      reaper: await reapOrphanedTmuxProcesses({
                          rootDir: "/tmp",
                          shouldContinue: () => !cancelled,
                      }),
                      cleanup: await cleanupStaleTmuxRunDirsAsync({
                          shouldContinue: () => !cancelled,
                      }),
                  };
        parentPort!.postMessage({
            ok: true,
            task: request.task,
            stats: cancelled
                ? { ...stats, cancelled: true, budgetExhausted: true }
                : stats,
            durationMs: performance.now() - startedAt,
        });
        parentPort!.close();
    } catch (error) {
        parentPort!.postMessage({
            ok: false,
            task: request.task,
            error: error instanceof Error ? error.message : String(error),
        });
        parentPort!.close();
    }
};
parentPort.on("message", (message: Request | { cancel?: boolean }) => {
    void handleMessage(message);
});
