import { Worker } from "node:worker_threads";
import {
    noteMaintenanceWorkerTimeout,
    recordMaintenanceEvent,
} from "./events.ts";

export type MaintenanceTask = "stage0-retention" | "tmux-sweep";

export const STAGE0_TOTAL_BUDGET_MS = 2_000;
export const TMUX_SWEEP_TOTAL_BUDGET_MS = 1_000;

export function maintenanceWorkerDeadlineMs(task: MaintenanceTask): number {
    const totalBudgetMs =
        task === "stage0-retention"
            ? STAGE0_TOTAL_BUDGET_MS
            : TMUX_SWEEP_TOTAL_BUDGET_MS;
    return 2 * totalBudgetMs;
}

export function runMaintenanceTask<T>(
    task: MaintenanceTask,
    onWorker?: (worker: Worker) => void,
    options?: unknown,
    onEvent?: (event: string, details: Record<string, unknown>) => void,
    deadlineMs = maintenanceWorkerDeadlineMs(task),
    createWorker: () => Worker = () =>
        new Worker(new URL("./runner.ts", import.meta.url))
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const worker = createWorker();
        worker.unref();
        onWorker?.(worker);
        let settled = false;
        const deadline = setTimeout(() => {
            if (settled) return;
            const workerTimeouts = noteMaintenanceWorkerTimeout();
            const details = {
                task,
                worker_timeouts: workerTimeouts,
                deadline_ms: deadlineMs,
            };
            if (onEvent) onEvent("worker-timeout", details);
            else void recordMaintenanceEvent("worker-timeout", details);
            void worker.terminate();
            finish(
                new Error(`${task} worker exceeded ${deadlineMs}ms deadline`)
            );
        }, deadlineMs);
        const finish = (error?: Error, value?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (error) reject(error);
            else resolve(value!);
        };
        worker.once(
            "message",
            (message: { ok: boolean; stats?: T; error?: string }) => {
                if (message?.ok) finish(undefined, message.stats);
                else
                    finish(
                        new Error(message?.error ?? `${task} worker failed`)
                    );
            }
        );
        worker.once("error", (error: Error) => finish(error));
        worker.once("exit", (code: number) => {
            if (code !== 0) finish(new Error(`${task} worker exited ${code}`));
        });
        worker.postMessage({ task, options });
    });
}
