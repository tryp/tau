import { statSync } from "node:fs";
import type { JobStatus } from "../types.ts";

export const BACKGROUND_JOB_LIVENESS_INTERVAL_MS = 30_000;
export const BACKGROUND_JOB_LIVENESS_MAX_HEARTBEATS = 100;
export const BACKGROUND_JOB_LIVENESS_ENTRY_TYPE = "background-job-liveness";

type AppendEntry = (customType: string, data: Record<string, unknown>) => void;

export interface BackgroundJobLivenessSource {
    id: string;
    startTime: number;
    logPath: string;
}

export interface BackgroundJobLivenessOptions {
    now?: () => number;
    readLogBytes?: (path: string) => number | null;
    intervalMs?: number;
    maxHeartbeats?: number;
}

export interface BackgroundJobLivenessTracker {
    finish(status: Exclude<JobStatus, "running">, exitCode?: number): void;
    stop(): void;
}

function readLogBytes(path: string): number | null {
    try {
        return statSync(path).size;
    } catch {
        return null;
    }
}

/**
 * Persist bounded, machine-readable background-job liveness records as pi
 * custom session entries. Custom entries are JSONL-persisted but excluded from
 * LLM context by SessionManager.buildSessionContext().
 */
export function startBackgroundJobLiveness(
    job: BackgroundJobLivenessSource,
    appendEntry: AppendEntry,
    options: BackgroundJobLivenessOptions = {}
): BackgroundJobLivenessTracker {
    const now = options.now ?? Date.now;
    const getLogBytes = options.readLogBytes ?? readLogBytes;
    const intervalMs =
        options.intervalMs ?? BACKGROUND_JOB_LIVENESS_INTERVAL_MS;
    const maxHeartbeats =
        options.maxHeartbeats ?? BACKGROUND_JOB_LIVENESS_MAX_HEARTBEATS;
    let heartbeatCount = 0;
    let heartbeatCapTrips = 0;
    let persistenceFailures = 0;
    let previousLogBytes = getLogBytes(job.logPath) ?? 0;
    let lastGrowthAt = now();
    let finished = false;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const append = (data: Record<string, unknown>): boolean => {
        try {
            appendEntry(BACKGROUND_JOB_LIVENESS_ENTRY_TYPE, data);
            return true;
        } catch {
            persistenceFailures++;
            return false;
        }
    };

    const recordHeartbeat = (): void => {
        if (finished || stopped) return;
        if (heartbeatCount >= maxHeartbeats) {
            heartbeatCapTrips++;
            append({
                schemaVersion: 1,
                event: "heartbeat_cap_reached",
                jobId: job.id,
                status: "pending",
                heartbeatCount,
                heartbeatCapTrips,
                elapsedSeconds: Math.max(
                    0,
                    Math.floor((now() - job.startTime) / 1_000)
                ),
            });
            if (timer) clearInterval(timer);
            timer = undefined;
            return;
        }

        const timestamp = now();
        const currentLogBytes = getLogBytes(job.logPath);
        const logBytes = currentLogBytes ?? previousLogBytes;
        const logBytesDelta =
            currentLogBytes === null ? null : logBytes - previousLogBytes;
        if (logBytesDelta !== null && logBytesDelta > 0)
            lastGrowthAt = timestamp;
        const record = {
            schemaVersion: 1,
            event: "heartbeat",
            jobId: job.id,
            status: "pending",
            sequence: heartbeatCount + 1,
            elapsedSeconds: Math.max(
                0,
                Math.floor((timestamp - job.startTime) / 1_000)
            ),
            logBytes,
            logBytesDelta,
            lastGrowthAgeSeconds: Math.max(
                0,
                Math.floor((timestamp - lastGrowthAt) / 1_000)
            ),
        };
        if (append(record)) heartbeatCount++;
        if (currentLogBytes !== null) previousLogBytes = currentLogBytes;
    };

    timer = setInterval(recordHeartbeat, intervalMs);
    timer.unref?.();

    return {
        finish(status, exitCode) {
            if (finished) return;
            finished = true;
            if (timer) clearInterval(timer);
            timer = undefined;
            const timestamp = now();
            append({
                schemaVersion: 1,
                event: "terminal",
                jobId: job.id,
                status,
                ...(exitCode !== undefined ? { exitCode } : {}),
                elapsedSeconds: Math.max(
                    0,
                    Math.floor((timestamp - job.startTime) / 1_000)
                ),
                finalLogBytes: getLogBytes(job.logPath),
                heartbeatCount,
                heartbeatCapTrips,
                persistenceFailures,
            });
        },
        stop() {
            if (stopped || finished) return;
            stopped = true;
            if (timer) clearInterval(timer);
            timer = undefined;
        },
    };
}
