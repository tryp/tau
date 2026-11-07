import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let entriesDroppedWhenCtxStale = 0;
let workerTimeouts = 0;
let pendingWrites = Promise.resolve();

export function recordMaintenanceEvent(
    event: string,
    details: Record<string, unknown> = {},
    appendEntry?: (type: string, data: unknown) => void
): void {
    if (appendEntry) {
        try {
            appendEntry("tau-maintenance", { event, ...details });
        } catch {
            entriesDroppedWhenCtxStale++;
        }
    }
    const line = JSON.stringify({
        prefix: "tau-maintenance",
        event,
        ...details,
        entries_dropped_when_ctx_stale: entriesDroppedWhenCtxStale,
        worker_timeouts: workerTimeouts,
    });
    pendingWrites = pendingWrites.then(() =>
        appendFile(join(tmpdir(), "pi-tau-maintenance.log"), `${line}\n`).catch(
            () => {}
        )
    );
}

export async function flushMaintenanceEvents(): Promise<void> {
    await pendingWrites;
}

export function noteMaintenanceWorkerTimeout(): number {
    workerTimeouts++;
    return workerTimeouts;
}
