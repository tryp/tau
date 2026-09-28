import { closeSync, openSync, readSync, statSync } from "node:fs";

export type LogSeverity = "err" | "warn";

export interface LogCounts {
    err: number;
    warn: number;
    total: number;
}

export interface JobLogEvidence {
    /** Cumulative counts for the bytes scanned so far. */
    counts: LogCounts;
    /** Counts added since the prior call for this job. */
    delta: LogCounts;
    firstError?: string;
    fileSize: number;
    lastWriteAt: number;
    grew: boolean;
    rotated: boolean;
    truncated: boolean;
}

export const MAX_LOG_SCAN_BYTES = 512 * 1024;
const MAX_PENDING_LINE_CHARS = 16 * 1024;
const MAX_TRACKED_JOBS = 100;

const STRONG_ERROR_PATTERNS: readonly RegExp[] = [
    /^\s*Traceback\s*\((?:most recent call last|innermost last)\):/i,
    /^\s*(?:\[(?:ERROR|ERR|FATAL)\]|(?:ERROR|ERR|FATAL)\s*:)/i,
    /^\s*(?:TypeError|ReferenceError|AssertionError|RangeError|SyntaxError|URIError|EvalError|RuntimeError|ImportError|ModuleNotFoundError|KeyError|ValueError|IndexError|NameError|AttributeError|OSError|IOError|ConnectionError|TimeoutError|Exception|UncaughtException)\s*:/,
    /\bpanic\s*:/i,
    /\b(?:segmentation fault|segfault)\b/i,
    /\b(?:uncaught|unhandled)\s+(?:exception|error)\b/i,
];

const WARNING_PATTERNS: readonly RegExp[] = [
    /^\s*(?:\[(?:WARN|WARNING)\]|WARN(?:ING)?\b)/i,
    /\bdeprecat(?:ed|ion|ions)\b/i,
];

const WEAK_ERROR_PATTERN = /\b(?:failed|failure|failures|error|errors)\b/i;
const BENIGN_ERROR_PATTERNS: readonly RegExp[] = [
    /\b0\s+errors?\b/i,
    /\berror\s+handler\b.*\btests?\s+passed\b/i,
];
const PATH_PATTERN = /(?:[A-Za-z]:)?(?:\/|\\)[^\s"'<>)]*/g;
const EXTENSION_ERROR_PATH_PATTERN = /\berrors?\.[A-Za-z0-9]+\b/gi;

/** Strong errors drive investigation; weak matches are warnings to limit false alarms. */
export function classifyLine(line: string): LogSeverity | null {
    if (STRONG_ERROR_PATTERNS.some((pattern) => pattern.test(line)))
        return "err";
    if (WARNING_PATTERNS.some((pattern) => pattern.test(line))) return "warn";
    if (BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(line)))
        return null;
    const messageText = line
        .replace(PATH_PATTERN, " ")
        .replace(EXTENSION_ERROR_PATH_PATTERN, " ");
    return WEAK_ERROR_PATTERN.test(messageText) ? "warn" : null;
}

/** Count every line (including unclassified info/debug lines); trailing newline adds no line. */
export function countLines(text: string): LogCounts {
    if (text.length === 0) return { err: 0, warn: 0, total: 0 };
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.at(-1) === "") lines.pop();
    const counts: LogCounts = { err: 0, warn: 0, total: lines.length };
    for (const line of lines) {
        const severity = classifyLine(line);
        if (severity === "err") counts.err += 1;
        else if (severity === "warn") counts.warn += 1;
    }
    return counts;
}

/** Return the first strong-error line as one line, capped to maxLen. */
export function firstErrorLine(text: string, maxLen = 160): string | undefined {
    if (text.length === 0 || maxLen <= 0) return undefined;
    const line = text
        .split(/\r\n|\n|\r/)
        .find((candidate) => classifyLine(candidate) === "err");
    if (line === undefined) return undefined;
    return line.replace(/[\r\n]/g, " ").slice(0, maxLen);
}

interface Snapshot {
    offset: number;
    counts: LogCounts;
    pending: string;
    lastSeenSize: number;
}

function emptyCounts(): LogCounts {
    return { err: 0, warn: 0, total: 0 };
}

function addCounts(target: LogCounts, added: LogCounts): void {
    target.err += added.err;
    target.warn += added.warn;
    target.total += added.total;
}

/**
 * Tracks bounded byte-range scans per job. Only complete lines are counted while
 * a job is live; the trailing partial line is carried into its next scan.
 */
export class JobLogEvidenceTracker {
    private readonly snapshots = new Map<string, Snapshot>();

    scan(
        jobId: string,
        path: string,
        finalize = false
    ): JobLogEvidence | undefined {
        try {
            const fileStat = statSync(path);
            const fileSize = fileStat.size;
            let snapshot = this.snapshots.get(jobId);
            let rotated = false;
            if (!snapshot) {
                snapshot = {
                    offset: 0,
                    counts: emptyCounts(),
                    pending: "",
                    lastSeenSize: 0,
                };
            } else if (
                fileSize < snapshot.lastSeenSize ||
                fileSize < snapshot.offset
            ) {
                snapshot = {
                    offset: 0,
                    counts: emptyCounts(),
                    pending: "",
                    lastSeenSize: 0,
                };
                rotated = true;
            }

            const priorSize = snapshot.lastSeenSize;
            const available = Math.max(0, fileSize - snapshot.offset);
            const bytesToRead = Math.min(available, MAX_LOG_SCAN_BYTES);
            let appended = "";
            if (bytesToRead > 0) {
                const fd = openSync(path, "r");
                try {
                    const buffer = Buffer.alloc(bytesToRead);
                    const bytesRead = readSync(
                        fd,
                        buffer,
                        0,
                        bytesToRead,
                        snapshot.offset
                    );
                    appended = buffer.toString("utf8", 0, bytesRead);
                    snapshot.offset += bytesRead;
                } finally {
                    closeSync(fd);
                }
            }

            const combined = snapshot.pending + appended;
            const isAtEof = snapshot.offset >= fileSize;
            const split = combined.split(/\r\n|\n|\r/);
            const hasTrailingDelimiter = /(?:\r\n|\n|\r)$/.test(combined);
            let completeLines = split;
            let pending = "";
            if (hasTrailingDelimiter) {
                completeLines.pop();
            } else {
                pending = split.pop() ?? "";
                completeLines = split;
                // A final unterminated line is stable at explicit finalization.
                if (finalize && isAtEof && pending.length > 0) {
                    completeLines.push(pending);
                    pending = "";
                }
            }
            if (pending.length > MAX_PENDING_LINE_CHARS) {
                // Bound memory for pathological single-line logs; classifying its
                // prefix is more useful than retaining unbounded content.
                completeLines.push(pending.slice(0, MAX_PENDING_LINE_CHARS));
                pending = "";
            }
            snapshot.pending = pending;
            const scannedText =
                completeLines.length > 0 ? `${completeLines.join("\n")}\n` : "";
            const delta = countLines(scannedText);
            const firstError = firstErrorLine(scannedText);
            addCounts(snapshot.counts, delta);
            snapshot.lastSeenSize = fileSize;
            const grew = fileSize > priorSize;
            this.snapshots.delete(jobId);
            this.snapshots.set(jobId, snapshot);
            while (this.snapshots.size > MAX_TRACKED_JOBS) {
                const oldest = this.snapshots.keys().next().value;
                if (oldest === undefined) break;
                this.snapshots.delete(oldest);
            }
            return {
                counts: { ...snapshot.counts },
                delta,
                ...(firstError ? { firstError } : {}),
                fileSize,
                lastWriteAt: fileStat.mtimeMs,
                grew,
                rotated,
                truncated: available > bytesToRead,
            };
        } catch {
            // Log files are best-effort evidence; missing/unreadable output must
            // never break a background job notification or tool response.
            return undefined;
        }
    }

    forget(jobId: string): void {
        this.snapshots.delete(jobId);
    }

    clear(): void {
        this.snapshots.clear();
    }
}

export const jobLogEvidenceTracker = new JobLogEvidenceTracker();

export function formatLogCounts(counts: LogCounts): string {
    return `${counts.total} lines (${counts.err} err, ${counts.warn} warn)`;
}

/** Normalize untrusted log text to a single capped line. */
export function oneLine(value: string, maxLength = 160): string {
    return value
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}
