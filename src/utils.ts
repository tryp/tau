/**
 * Shared utility functions for the Tau extension.
 */

import { execFile } from "node:child_process";
import {
    closeSync,
    openSync,
    readdirSync,
    readSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TauState } from "./state.ts";
import type { BackgroundJob, JobStatus } from "./types.ts";

// ─── Configuration constants ────────────────────────────────────────

/**
 * Default delay before a foreground bash command auto-backgrounds
 * (15s, matching Claude Code). Every foreground job auto-backgrounds (or,
 * for non-backgroundable commands like sleep, is killed) after this delay
 * unless the call passes backgroundAfter. Override session-wide with
 * PI_TAU_BACKGROUND_AFTER_MS (milliseconds).
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export function resolveBackgroundAfterMs(
    env: NodeJS.ProcessEnv = process.env
): number {
    const raw = env.PI_TAU_BACKGROUND_AFTER_MS;
    if (raw !== undefined) {
        const normalized = raw.trim();
        if (/^\d+$/.test(normalized)) {
            const parsed = Number(normalized);
            if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
        }
    }
    return DEFAULT_TIMEOUT_MS;
}
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1024;
export const MAX_OUTPUT_PREVIEW_CHARS = 12_000;
/** Maximum log file size before the stall watchdog kills the job. */
export const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 MiB
/**
 * Margin keeping the interactive stall watchdog behind the background/kill
 * timer: with an explicit long backgroundAfter, the watchdog fires a minute
 * after the timer instead of killing a command the user asked to keep.
 */
export const INTERACTIVE_STALL_WAKE_MARGIN_MS = 60_000;
/**
 * Non-interactive sessions (subagent workers, `pi -p`) never auto-background a
 * foreground command — the auto-background timer deliberately no-ops there —
 * so a command that goes silent would block the agent loop forever (observed:
 * a 14h session hang caused by a deadlocked test binary). After this much
 * output silence, the command is killed and a possibly-stuck notice is
 * returned as the tool result so the agent can decide what to do next.
 * Override with PI_TAU_STALL_WAKE_MS (milliseconds).
 */
export const NONINTERACTIVE_STALL_WAKE_MS = 240_000;

export function resolveNonInteractiveStallWakeMs(
    env: NodeJS.ProcessEnv = process.env
): number {
    const raw = env.PI_TAU_STALL_WAKE_MS;
    if (raw !== undefined) {
        const normalized = raw.trim();
        if (/^\d+$/.test(normalized)) {
            const parsed = Number(normalized);
            if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
        }
    }
    return NONINTERACTIVE_STALL_WAKE_MS;
}
export const NOTIFICATION_BODY_MAX = 200;

// ─── Plan mode tools ────────────────────────────────────────────────

export const PLAN_MODE_TOOLS = [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
];
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// ─── Process management ─────────────────────────────────────────────

/**
 * Normalize a per-call `backgroundAfter` (seconds) to milliseconds.
 * Returns undefined for missing, NaN, or negative values so callers fall
 * back to the configured default. Zero is honored (background at once);
 * Infinity keeps its historical meaning via setTimeout clamping.
 */
export function resolveExplicitBackgroundAfterMs(
    value: unknown
): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0)
        return undefined;
    return value * 1_000;
}

/** Kill an entire process group. Requires the child to have been spawned
 *  with `detached: true` so it became a process group leader. */
export function killProcessGroup(
    pid: number,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    try {
        process.kill(-pid, signal);
    } catch {
        // Process group kill failed — try just the parent.
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Minimal liveness view for the SIGKILL fallback (structural so tests can
 *  use fakes; real ChildProcess satisfies it). */
export interface SigkillFallbackProc {
    pid?: number;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
}

/**
 * Escalate a SIGTERM-ignoring process to SIGKILL after `delayMs`.
 * Liveness-guarded against pid reuse: stands down when the process object
 * already reports an exit (exitCode or signalCode set), when the pid is
 * missing/non-positive, or when a signal-0 probe finds the pid gone.
 * An unconditional delayed group-kill could otherwise SIGKILL an unrelated
 * recycled pid or process group.
 */
export function scheduleSigkillFallback(
    proc: SigkillFallbackProc | undefined,
    delayMs = 5_000
): void {
    const pid = proc?.pid;
    if (!pid || pid <= 0) return;
    setTimeout(() => {
        if (proc?.exitCode !== null && proc?.exitCode !== undefined) return;
        if (proc?.signalCode !== null && proc?.signalCode !== undefined) return;
        try {
            process.kill(pid, 0);
        } catch {
            return; // ESRCH — already dead.
        }
        try {
            killProcessGroup(pid, "SIGKILL");
        } catch {
            /* already dead */
        }
    }, delayMs).unref();
}

// ─── Job helpers ────────────────────────────────────────────────────

export function generateJobId(
    counter: number,
    pid: number = process.pid
): string {
    return `job-${pid}-${counter}`;
}

export function logPathForJob(jobId: string): string {
    const baseDir = join(homedir(), "tmp");
    return join(baseDir, `pi-bg-${jobId}.log`);
}

export function createJobDonePromise(job: BackgroundJob): void {
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

export function markJobTerminal(
    job: BackgroundJob,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    delete job.queued;
    job.exitCode = exitCode;
    // Record when the job reached its terminal state so structured results
    // can expose lifecycle timing (endTime/durationMs) for the job.
    job.endTime = Date.now();
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
}

/** Cancel an agent_bg fork that has not started yet. */
export function cancelPendingBackgroundAgent(
    state: TauState,
    jobId: string
): BackgroundJob | undefined {
    const pending = state.pendingBackgroundAgents.get(jobId);
    if (!pending) return undefined;

    state.pendingBackgroundAgents.delete(jobId);
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
    try {
        unlinkSync(pending.promptFile);
    } catch {
        /* already gone */
    }

    const job = state.backgroundJobs.get(jobId);
    if (job && job.status === "running") {
        markJobTerminal(job, "killed");
        job.outputConsumed = true;
    }
    return job;
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

export function formatJobLine(job: BackgroundJob): string {
    const duration = formatDuration(Date.now() - job.startTime);
    const status = job.queued
        ? `◒ queued (${duration})`
        : job.status === "running"
          ? job.isBackgrounded
              ? `◐ running (${duration})`
              : `▶ running (${duration})`
          : job.status === "completed"
            ? "✅ completed"
            : job.status === "failed"
              ? "❌ failed"
              : "🛑 killed";
    return `${job.id}: ${job.command.slice(0, 80)} - ${status}`;
}

// ─── Output reading ─────────────────────────────────────────────────

export async function readOutputTail(
    path: string,
    maxChars: number
): Promise<string> {
    try {
        const content = await readFile(path, "utf-8");
        if (content.length <= maxChars) return content;
        return `...[truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
    } catch {
        return "(no output yet)";
    }
}

export function readOutputTailSync(path: string, maxChars: number): string {
    try {
        const { size } = statSync(path);
        if (size === 0) return "(no output yet)";
        const fd = openSync(path, "r");
        try {
            const readStart = Math.max(0, size - maxChars);
            const toRead = Math.min(size, maxChars);
            const buf = Buffer.alloc(toRead);
            readSync(fd, buf, 0, toRead, readStart);
            const content = buf.toString("utf-8", 0, toRead);
            if (size <= maxChars) return content;
            return `...[truncated, showing last ${maxChars} chars]\n${content}`;
        } finally {
            closeSync(fd);
        }
    } catch {
        return "(no output yet)";
    }
}

// ─── Stall detection ────────────────────────────────────────────────

/** Interactive-prompt patterns at the end of output that suggest a command is
 *  blocked waiting for keyboard input. */
const PROMPT_PATTERNS = [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\(yes\/no\)/i,
    /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
    /Press (any key|Enter)/i,
    /Continue\?/i,
    /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
    const lastLine = tail.trimEnd().split("\n").pop() ?? "";
    return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

// ─── Log file cleanup ──────────────────────────────────────────────

/** Remove stale /tmp/pi-bg-* log files older than 24 hours. */
export function cleanupStaleLogs(): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const baseDir = join(homedir(), "tmp");
    try {
        const entries = readdirSync(baseDir);
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.startsWith("pi-bg-")) continue;
            const filePath = join(baseDir, entry);
            try {
                const { mtimeMs } = statSync(filePath);
                if (now - mtimeMs > MAX_AGE_MS) {
                    unlinkSync(filePath);
                }
            } catch {
                /* file already gone */
            }
        }
    } catch {
        /* tmp dir not accessible */
    }
}

// ─── Notification helpers ───────────────────────────────────────────

export function truncateNotificationBody(text: string): string {
    const firstLine = text.split("\n")[0] ?? "";
    if (firstLine.length <= NOTIFICATION_BODY_MAX) return firstLine;
    return firstLine.slice(0, NOTIFICATION_BODY_MAX - 1) + "…";
}

/** Extract the last assistant text from the message history. */
export function lastAssistantText(
    messages: {
        role: string;
        content?: string | { type: string; text?: string }[];
    }[]
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === "text" && block.text) {
                    return block.text;
                }
            }
        }
    }
    return undefined;
}

// ─── Command policies ────────────────────────────────────────────────

/** Commands that should not be automatically backgrounded on timeout. */
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ["sleep"];

/** Check whether a command is allowed to be auto-backgrounded. */
export function isAutoBackgroundAllowed(command: string): boolean {
    const first = command.trim().split(/\s+/)[0] ?? "";
    // Match the sleep binary regardless of path prefix (/bin/sleep 60 must
    // take the kill path just like bare `sleep 60`).
    const base = first.split("/").pop() ?? "";
    return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(base);
}

const SLEEP_SUFFIX_SECONDS: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
};

/**
 * Total sleep seconds for GNU sleep operands (suffixes s/m/h/d, multiple
 * operands summed, `--` separator skipped). Returns undefined when no
 * duration operand is present or an operand is unparseable (e.g. a variable
 * like $DUR) — such commands are left to the timeout kill path instead of
 * the upfront block.
 */
export function parseSleepSeconds(args: string[]): number | undefined {
    let total = 0;
    let seen = false;
    for (const arg of args) {
        if (arg === "--") continue;
        const m = /^(\d+(?:\.\d+)?)([smhd])?$/.exec(arg);
        if (!m) return undefined;
        total += parseFloat(m[1]) * (m[2] ? SLEEP_SUFFIX_SECONDS[m[2]] : 1);
        seen = true;
    }
    return seen ? total : undefined;
}

/**
 * Detect standalone or leading `sleep N` patterns that should run in
 * foreground or use bash_bg instead. Returns the matched command or null.
 * Blocks sleep >= 2 seconds; allows sub-2s pacing.
 */
export function detectBlockedSleep(command: string): string | null {
    // Split on shell chaining operators AND newlines: a leading `sleep 15\n...`
    // multiline command must be blocked the same as `sleep 15; ...`. Without
    // the newline split, a `sleep 15` first line bypasses the block and then
    // hits the no-auto-background kill path on timeout (observed: 24h stall
    // when the tmux kill left the foreground race pending).
    const first =
        command
            .trim()
            .split(/&&|;|\||\r?\n/)[0]
            ?.trim() ?? "";
    const argv = first.split(/\s+/).filter(Boolean);
    if (argv.length === 0) return null;
    // Match the sleep binary regardless of path prefix (/bin/sleep 5s).
    if ((argv[0].split("/").pop() ?? "") !== "sleep") return null;
    // GNU sleep forms: suffixes (5s/1m/2h), multiple operands (sleep 1 2),
    // `--` separator. Unparseable operands (e.g. $DUR) fall through to the
    // timeout kill path instead of the upfront block.
    const secs = parseSleepSeconds(argv.slice(1));
    if (secs === undefined || secs < 2) return null;
    return first;
}

/**
 * Whether pi is running non-interactively. Mirrors pi's own mode decision
 * (`parsed.print || !stdinIsTTY`): explicit `-p`/`--print`, or stdin not a TTY
 * (piped / spawned by another process). When true there is no interactive agent
 * loop to answer the bash tool's auto-background `job_decide` prompt, so the
 * tool must run commands to completion instead of backgrounding on timeout.
 */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

// ─── DnD check ──────────────────────────────────────────────────────

/** Check macOS system Do Not Disturb / Focus mode using notifyutil. */
export async function isSystemDndActive(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    return new Promise((resolve) => {
        execFile(
            "notifyutil",
            ["-g", "com.apple.notificationcenterui.dnd"],
            { timeout: 2000 },
            (err, stdout) => {
                if (err) {
                    resolve(false);
                    return;
                }
                const match = stdout.match(/\d+$/);
                resolve(match ? match[0] === "1" : false);
            }
        );
    });
}
