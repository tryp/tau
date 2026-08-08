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

/**
 * Cap on the per-poll delta read for outputMatch (bytes). A fast writer
 * can produce a large delta between polls; reading the whole delta would
 * make memory usage proportional to output rate. When the delta exceeds
 * the cap, only its tail is read and scanned.
 */
const MAX_OUTPUT_MATCH_DELTA = 4 * 1024 * 1024;

/**
 * Bytes of previously scanned content retained across polls so patterns
 * spanning a write boundary still match. Retained as raw bytes: the tail
 * is concatenated with the new chunk and decoded as one contiguous
 * buffer, so a multi-byte UTF-8 character split by the boundary decodes
 * correctly instead of becoming U+FFFD on both sides.
 */
const BOUNDARY_WINDOW = 4096;

/**
 * Regex metacharacters that force a pattern through the RegExp engine.
 * Patterns without any of these are matched literally (case-folded
 * `includes`), which is O(n) and cannot trigger catastrophic
 * backtracking — a pathological agent pattern must not be able to stall
 * the agent's own event loop.
 */
const REGEX_METACHARS = /[.\\^$*+?()[\]{}|]/;

function isLiteralPattern(pattern: string): boolean {
    return !REGEX_METACHARS.test(pattern);
}

// ─── Accumulator ────────────────────────────────────────────────────

export interface TriggerAccum {
    prevSize: number;
    prevLines: number;
    ioBlockStartMs: number | undefined;
    jobStartMs: number;
    /** Bytes already scanned by an outputMatch trigger (incremental scan). */
    matchPrevSize: number;
    /** Tail of the previously scanned region, retained for boundary matches. */
    matchTail: Buffer;
}

export function makeTriggerAccum(jobStartMs = Date.now()): TriggerAccum {
    return {
        prevSize: 0,
        prevLines: 0,
        ioBlockStartMs: undefined,
        jobStartMs,
        matchPrevSize: 0,
        matchTail: Buffer.alloc(0),
    };
}

// ─── Evaluation ─────────────────────────────────────────────────────

export interface TriggerResult {
    met: boolean;
    current: number;
    /** Set when the trigger could not be evaluated (e.g. invalid pattern). */
    error?: string;
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
            // acceptable. The 64 KiB read is the worst case; most logs are
            // much smaller.
            const size = statSync(logPath).size;
            if (size === 0) {
                acc.prevSize = 0;
                acc.prevLines = 0;
                break;
            }

            // If the log was rotated (size decreased), reset counters to
            // avoid overcounting lines from the old log file.
            if (size < acc.prevSize) {
                acc.prevSize = 0;
                acc.prevLines = 0;
            }

            // Count only the newlines appended since the last poll, not the
            // whole (overlapping) read window — adding the window total each
            // poll made prevLines grow super-linearly, firing outputLines
            // triggers far below their real threshold.
            //
            // The per-poll read is capped at 64 KiB: prevSize advances by
            // bytes actually read, so a growth burst larger than the window
            // is counted exactly across subsequent polls.
            if (size === acc.prevSize) {
                // Nothing new since the last poll — report the running total.
                current = acc.prevLines;
                if (current >= trigger.value) met = true;
                break;
            }
            const readLen = Math.min(size - acc.prevSize, 65536);
            const buf = Buffer.alloc(readLen);
            const fd = openSync(logPath, "r");
            let bytes: number;
            try {
                bytes = readSync(fd, buf, 0, readLen, acc.prevSize);
            } finally {
                closeSync(fd);
            }
            const tailStr = buf.toString("utf-8", 0, bytes);
            const newlines = (tailStr.match(/\n/g) || []).length;
            acc.prevLines += Math.max(0, newlines);
            acc.prevSize += bytes;
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

        case "outputMatch": {
            // Incremental scan: read only the bytes appended since the last
            // poll, retaining the previous chunk's tail so patterns that span
            // chunk boundaries still match. I/O stays proportional to output
            // rate instead of total log size, so a long-running job with a
            // huge log doesn't make the monitor re-read the whole file.
            let size: number;
            try {
                size = statSync(logPath).size;
            } catch {
                // Log not readable yet (or removed) — keep the trigger pending.
                break;
            }
            if (size === 0) {
                acc.matchPrevSize = 0;
                acc.matchTail = Buffer.alloc(0);
                break;
            }
            // Log rotated or truncated (size decreased): restart the scan.
            if (size < acc.matchPrevSize) {
                acc.matchPrevSize = 0;
                acc.matchTail = Buffer.alloc(0);
            }
            if (size === acc.matchPrevSize) {
                // Nothing new since the last poll.
                break;
            }

            // Bound the per-poll read: when the delta exceeds the cap, read
            // only its tail. The scan stays incremental; matches entirely in
            // the skipped middle of one enormous burst may be missed.
            let readOffset = acc.matchPrevSize;
            if (size - acc.matchPrevSize > MAX_OUTPUT_MATCH_DELTA) {
                readOffset = size - MAX_OUTPUT_MATCH_DELTA;
            }
            const buf = Buffer.alloc(size - readOffset);
            const fd = openSync(logPath, "r");
            let bytes: number;
            try {
                bytes = readSync(fd, buf, 0, buf.length, readOffset);
            } finally {
                closeSync(fd);
            }
            const chunkBytes = buf.subarray(0, bytes);
            acc.matchPrevSize = size;

            // Join the retained tail with the new chunk as one contiguous
            // byte range and decode together: a UTF-8 character whose bytes
            // straddle the write boundary then decodes correctly. Retain a
            // bounded byte tail of the joined region for the next poll.
            const searchBytes = Buffer.concat([acc.matchTail, chunkBytes]);
            const searchText = searchBytes.toString("utf-8");
            acc.matchTail = searchBytes.subarray(
                Math.max(0, searchBytes.length - BOUNDARY_WINDOW)
            );

            try {
                if (isLiteralPattern(trigger.pattern)) {
                    // Literal fast-path: O(n) case-folded search. Literal
                    // patterns are the common case ("ERROR", "server
                    // ready") and cannot trigger catastrophic backtracking.
                    const haystack = trigger.caseSensitive
                        ? searchText
                        : searchText.toLowerCase();
                    const needle = trigger.caseSensitive
                        ? trigger.pattern
                        : trigger.pattern.toLowerCase();
                    current = haystack.split(needle).length - 1;
                } else {
                    // JavaScript regex, matching the common tool-surface
                    // language (jobs output grep). Case-insensitive by
                    // default (caseSensitive defaults to false); the
                    // multiline flag keeps ^/$ line-anchored like the
                    // per-line grep tools.
                    const flags = trigger.caseSensitive ? "gm" : "gim";
                    current =
                        searchText.match(new RegExp(trigger.pattern, flags))
                            ?.length ?? 0;
                }
                if (current > 0) met = true;
            } catch {
                // Invalid pattern — surface an error so the agent learns the
                // regex is bad instead of silently never firing.
                return {
                    met: false,
                    current: 0,
                    error: `invalid regex /${trigger.pattern}/`,
                };
            }
            break;
        }
    }

    return { met, current };
}
