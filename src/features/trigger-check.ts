/**
 * Pure trigger evaluation logic for background job triggers.
 *
 * Extracted from background.ts's startTriggerMonitor so it can be
 * unit-tested without importing the full pi extension API.
 *
 * Mutates an accumulator object to preserve cross-poll state
 * (line counts, I/O block timing).
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { JobTrigger } from "../types.ts";

// ─── Accumulator ────────────────────────────────────────────────────

export interface TriggerAccum {
    prevSize: number;
    prevLines: number;
    ioBlockStartMs: number | undefined;
    jobStartMs: number;
}

export function makeTriggerAccum(): TriggerAccum {
    return {
        prevSize: 0,
        prevLines: 0,
        ioBlockStartMs: undefined,
        jobStartMs: Date.now(),
    };
}

// ─── Evaluation ─────────────────────────────────────────────────────

export interface TriggerResult {
    met: boolean;
    current: number;
}

/**
 * Evaluate a single trigger condition against the current process state.
 *
 * @param trigger  The trigger to evaluate
 * @param pid      Process PID to read /proc/<pid>/...
 * @param logPath  Path to the job's log file (for outputLines)
 * @param acc      Mutable accumulator for cross-poll state
 * @returns        `{ met, current }` — met is true if the condition is satisfied
 */
export function evaluateTrigger(
    trigger: JobTrigger,
    pid: number,
    logPath: string,
    acc: TriggerAccum
): TriggerResult {
    let met = false;
    let current = 0;

    switch (trigger.type) {
        case "outputLines": {
            // Uses sync I/O intentionally — this runs in a timer callback
            // outside the agent loop, so blocking the event loop briefly is
            // acceptable. The 64 KiB tail is the worst case; most logs are
            // much smaller.
            const size = statSync(logPath).size;
            if (size === 0) { acc.prevSize = 0; acc.prevLines = 0; break; }

            // If the log was rotated (size decreased), reset counters to
            // avoid overcounting lines from the old log file.
            if (size < acc.prevSize) { acc.prevSize = 0; acc.prevLines = 0; }
            acc.prevSize = size;

            const readLen = Math.min(size, 65536);
            const buf = Buffer.alloc(readLen);
            const fd = openSync(logPath, "r");
            let bytes = 0;
            try {
                bytes = readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
            } finally {
                closeSync(fd);
            }
            const tailStr = buf.toString("utf-8", 0, bytes);
            const newlines = (tailStr.match(/\n/g) || []).length;
            acc.prevLines += Math.max(0, newlines);
            current = acc.prevLines;
            if (current >= trigger.value) met = true;
            break;
        }

        case "rssKb": {
            const status = readFileSync(`/proc/${pid}/status`, "utf-8");
            const m = status.match(/^VmRSS:\s+(\d+)/m);
            if (m) {
                current = parseInt(m[1], 10);
                if (current >= trigger.value) met = true;
            }
            break;
        }

        case "ioReadBytes": {
            const ioData = readFileSync(`/proc/${pid}/io`, "utf-8");
            const m = ioData.match(/^read_bytes:\s+(\d+)/m);
            if (m) {
                current = parseInt(m[1], 10);
                if (current >= trigger.value) met = true;
            }
            break;
        }

        case "ioWriteBytes": {
            const ioData = readFileSync(`/proc/${pid}/io`, "utf-8");
            const m = ioData.match(/^write_bytes:\s+(\d+)/m);
            if (m) {
                current = parseInt(m[1], 10);
                if (current >= trigger.value) met = true;
            }
            break;
        }

        case "cpuTime": {
            const statData = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const closeParen = statData.lastIndexOf(")");
            if (closeParen === -1) break;
            const parts = statData.slice(closeParen + 2).split(" ");
            if (parts.length < 17) break;
            // utime (11), stime (12), cutime (13), cstime (14) in ticks
            const ticks =
                parseInt(parts[11] ?? "0", 10) +
                parseInt(parts[12] ?? "0", 10) +
                parseInt(parts[13] ?? "0", 10) +
                parseInt(parts[14] ?? "0", 10);
            // USER_HZ = 100 on Linux
            current = Math.floor(ticks / 100);
            if (current >= trigger.value) met = true;
            break;
        }

        case "ioBlock": {
            const statData = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const closeParen = statData.lastIndexOf(")");
            if (closeParen === -1) break;
            const parts = statData.slice(closeParen + 2).split(" ");
            if (parts.length === 0) break;
            const state = parts[0];
            if (state === "D" || state === "Dl") {
                const now = Date.now();
                if (acc.ioBlockStartMs === undefined) acc.ioBlockStartMs = now;
                const elapsedMs = now - acc.ioBlockStartMs;
                current = Math.floor(elapsedMs / 1000);
                if (current >= trigger.value) met = true;
            } else {
                acc.ioBlockStartMs = undefined;
            }
            break;
        }

        case "wallTime": {
            current = Math.floor((Date.now() - acc.jobStartMs) / 1000);
            if (current >= trigger.value) met = true;
            break;
        }
    }

    return { met, current };
}
