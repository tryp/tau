/**
 * Background jobs feature — bash override, bash_bg, jobs, job_decide tools.
 *
 * Handles background process management, auto-timeout, stall detection,
 * and the pill-bar status widget.
 */

import {
    spawn,
    type ChildProcess,
    type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";

// ─── Context sidecar integration ────────────────────────────────────

import { stageZeroDirectory } from "./pipe-nerf/stage0-path.ts";
import {
    legacyStage0Directory,
    markStage0CaptureIndexed,
    sweepStage0Captures,
} from "./pipe-nerf/stage0-retention.ts";
import {
    findJobSourceDetailsInSidecar,
    findJobSourceIdInSidecar,
    getSidecarIndexStats,
    indexJobOutputInSidecar,
    indexJobOutputWithOutcome,
    purgeSidecar,
    resetSidecarIndexStats,
    readJobOutputDetailsFromSidecar,
    prepareInlineOutput,
    readJobOutputFromSidecar,
    searchSidecarSources,
    trackJobOutputIndex,
} from "./sidecar.ts";

export {
    findJobSourceDetailsInSidecar,
    findJobSourceIdInSidecar,
    getSidecarIndexStats,
    indexJobOutputInSidecar,
    indexJobOutputWithOutcome,
    purgeSidecar,
    resetSidecarIndexStats,
    readJobOutputDetailsFromSidecar,
    prepareInlineOutput,
    readJobOutputFromSidecar,
    searchSidecarSources,
    trackJobOutputIndex,
};

import { staleSafe } from "./ctx-guard.ts";
import {
    countLines,
    formatLogCounts,
    jobLogEvidenceTracker,
    oneLine,
    type LogCounts,
} from "./log-classify.ts";

import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import {
    cancelCallbacksForJob,
    hasLinkedCallbacksForJob,
    parseDurationToMs,
    scheduleJobReminder,
} from "./callbacks.ts";
import type {
    BackgroundJob,
    JobOutputIndex,
    JobResultDetails,
    JobStatus,
    RunningProcess,
    TerminationRequester,
    UiContext,
    PipeStageZeroCapture,
} from "../types.ts";
import {
    MAX_LOG_BYTES,
    MAX_OUTPUT_PREVIEW_CHARS,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
    STALL_THRESHOLD_MS,
    cancelPendingBackgroundAgent,
    createJobDonePromise,
    detectBlockedSleep,
    formatDuration,
    generateJobId,
    isAutoBackgroundAllowed,
    killProcessGroup,
    logPathForJob,
    MIN_STALL_CHECK_INTERVAL_MS,
    looksLikePrompt,
    markJobTerminal as markJobTerminalBase,
    readOutputTail,
    readOutputTailSync,
    resolveBackgroundAfterMs,
    resolveExplicitBackgroundAfterMs,
    resolveInteractiveStallWakeMarginMs,
    resolveNonInteractiveStallWakeMs,
    scheduleSigkillFallback,
    formatJobLine,
} from "../utils.ts";
import {
    TmuxSpawnError,
    attachTmuxContext,
    getTmuxContext,
    killTmuxJob,
    pollTmuxCompletion,
    spawnBackgroundTmux,
    spawnForegroundTmux,
} from "./bash-tmux.ts";
import { captureOutput } from "../tmux.ts";
import {
    BACKGROUND_JOB_LIVENESS_ENTRY_TYPE,
    startBackgroundJobLiveness,
    type BackgroundJobLivenessTracker,
} from "./background-job-liveness.ts";

const backgroundJobLivenessTrackers = new Map<
    BackgroundJob,
    BackgroundJobLivenessTracker
>();

function startJobLiveness(job: BackgroundJob, pi: ExtensionAPI): void {
    if (backgroundJobLivenessTrackers.has(job)) return;
    const tracker = startBackgroundJobLiveness(job, (customType, data) =>
        pi.appendEntry(customType, data)
    );
    backgroundJobLivenessTrackers.set(job, tracker);
}

function finishJobLiveness(
    job: BackgroundJob,
    status: Exclude<JobStatus, "running">,
    exitCode?: number
): void {
    const tracker = backgroundJobLivenessTrackers.get(job);
    if (!tracker) return;
    tracker.finish(status, exitCode);
    backgroundJobLivenessTrackers.delete(job);
}

function stopAllJobLiveness(): void {
    for (const tracker of backgroundJobLivenessTrackers.values())
        tracker.stop();
    backgroundJobLivenessTrackers.clear();
}

function markJobTerminal(
    job: BackgroundJob,
    status: Exclude<JobStatus, "running">,
    exitCode?: number
): void {
    markJobTerminalBase(job, status, exitCode);
    finishJobLiveness(job, status, exitCode);
}

class PossiblyStuckError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PossiblyStuckError";
    }
}

export function resolveExecutionCwd(
    perCallCwd: unknown,
    baseCwd: string
): string {
    if (typeof perCallCwd !== "string" || perCallCwd.length === 0) {
        return baseCwd;
    }
    if (perCallCwd === "~") return homedir();
    if (perCallCwd.startsWith("~/")) {
        return resolvePath(homedir(), perCallCwd.slice(2));
    }
    return resolvePath(baseCwd, perCallCwd);
}

export function validateWorkingDirectory(cwd: string): void {
    try {
        if (!statSync(cwd).isDirectory()) {
            throw new Error("not a directory");
        }
    } catch (error) {
        throw new Error(
            `Working directory does not exist or is not a directory: ${cwd}`,
            { cause: error }
        );
    }
}

export function installSpawnErrorHandler(proc: ChildProcess): void {
    // A failed spawn emits `error` asynchronously. Callers may inspect pid or
    // throw before their normal lifecycle handlers are installed, so attach a
    // listener immediately to prevent an uncaught EventEmitter error.
    proc.once("error", () => {});
}

function spawnBashProcess(
    command: string,
    cwd: string,
    options: SpawnOptions
): ChildProcess {
    validateWorkingDirectory(cwd);
    const proc = spawn("bash", ["-c", command], {
        ...options,
        cwd,
        env: options.env ?? { ...process.env },
    });
    installSpawnErrorHandler(proc);
    return proc;
}

// ─── Kill helpers ───────────────────────────────────────────────────

/**
 * Mark a job as killed and suppress the completion notification.
 * Use in every kill path (tool, shortcut, watchdog) to prevent
 * proc.on("close") from sending a spurious job-completion message
 * that re-enters the agent loop.
 */
export function silenceJobAfterKill(
    job: BackgroundJob,
    by: TerminationRequester
): void {
    // Record the termination REQUEST only. Terminal status is set from the
    // observed exit (close event / tmux completion poll); marking killed here
    // would record signal intent as outcome and hide SIGTERM-ignoring
    // survivors behind a false terminal record.
    requestJobTermination(job, by);
    job.outputConsumed = true;
}

// ─── No-output watchdog (non-interactive foreground) ────────────────

/**
 * Watch a foreground command's log for output silence. Fires `onStall` once
 * when no file growth has been observed for `stallMs`. Non-interactive
 * sessions never auto-background, so without this a silent or deadlocked
 * command would block the agent loop forever. The interval self-clears when
 * it fires; callers must cancel the returned function on every other exit.
 */
export function startNoOutputWatchdog(
    logPath: string,
    stallMs: number,
    onStall: () => void,
    checkIntervalMs = STALL_CHECK_INTERVAL_MS
): () => void {
    // Poll at least as often as the budget being measured: a budget shorter
    // than the interval could not be honored (PI_TAU_STALL_WAKE_MS=1000 with
    // the 5s default was only detected after two polls, ~10s). The floor keeps
    // a pathologically small budget from becoming a busy loop.
    const intervalMs = Math.max(
        MIN_STALL_CHECK_INTERVAL_MS,
        Math.min(checkIntervalMs, stallMs)
    );
    // Baseline with the size already in the log: bytes that were there when
    // the watchdog was armed are not growth. Starting at -1 made the first
    // poll look like growth and delayed every detection by one full interval.
    let lastSize = -1;
    try {
        lastSize = statSync(logPath).size;
    } catch {
        // Log not created yet — counts as no output.
    }
    let lastGrowth = Date.now();
    const timer = setInterval(() => {
        let size: number | undefined;
        try {
            size = statSync(logPath).size;
        } catch {
            // Log not created yet — counts as no output.
        }
        if (size !== undefined && size !== lastSize) {
            lastSize = size;
            lastGrowth = Date.now();
            return;
        }
        if (Date.now() - lastGrowth >= stallMs) {
            clearInterval(timer);
            onStall();
        }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

// ─── Deterministic queued notification lifecycle ─────────────────────

export type BackgroundNotificationKind = "timeout" | "stall" | "completion";

export function backgroundNotificationKey(
    jobId: string,
    kind: BackgroundNotificationKind
): string {
    return `tau:bg:${jobId}:${kind}`;
}

/**
 * Cancel a queued notification without relying on a time-based expiry.
 * Older pi hosts may not expose cancellation; in that case the notification
 * remains available rather than being silently discarded.
 */
export function cancelQueuedBackgroundNotification(
    pi: ExtensionAPI,
    jobId: string,
    kind: BackgroundNotificationKind
): void {
    const cancel = (
        pi as ExtensionAPI & {
            cancelQueuedMessage?: (queueKey: string) => void;
        }
    ).cancelQueuedMessage;
    // The queue may have been invalidated by a session replacement or reload
    // while the job was running; the assertion must not escape a timer
    // callback as an uncaughtException (it terminates pi). Stale => nothing
    // to cancel anyway.
    staleSafe(() => cancel?.(backgroundNotificationKey(jobId, kind)));
}

export function cancelQueuedBackgroundNotifications(
    pi: ExtensionAPI,
    jobId: string
): void {
    cancelQueuedBackgroundNotification(pi, jobId, "timeout");
    cancelQueuedBackgroundNotification(pi, jobId, "stall");
}

type QueuedMessageOptions = {
    deliverAs: "steer" | "followUp" | "nextTurn";
    triggerTurn?: boolean;
    queueKey?: string;
};

function sendQueuedMessage(
    pi: ExtensionAPI,
    message: Parameters<ExtensionAPI["sendMessage"]>[0],
    options: QueuedMessageOptions
): boolean {
    // Same stale-ctx guard as cancelQueuedBackgroundNotification: delivery
    // happens from debounce timers and completion promise chains that can
    // outlive the extension context that captured pi. Callers that retain
    // cancellation metadata must know whether the host accepted the message.
    return (
        staleSafe(() =>
            (
                pi as ExtensionAPI & {
                    sendMessage: (
                        message: Parameters<ExtensionAPI["sendMessage"]>[0],
                        options: QueuedMessageOptions
                    ) => void;
                }
            ).sendMessage(message, options)
        ) !== "stale"
    );
}

// ─── Requested policies: deadline wake + linked reminder ───────────

/**
 * Validate requested bash_bg policies before anything is spawned.
 *
 * Admission happens before job creation so an invalid request can never
 * leave a running payload whose supervision was refused.
 *
 * @throws Error with an agent-actionable message when a value is invalid.
 */
export function validateRequestedPolicies(params: {
    timeout?: unknown;
    remindDelay?: unknown;
}): void {
    if (params.timeout !== undefined) {
        const t = params.timeout;
        if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
            // unknown-typed input: stringify safely, never via [object Object]
            const shown =
                typeof t === "number"
                    ? String(t)
                    : typeof t === "string"
                      ? JSON.stringify(t)
                      : typeof t;
            throw new Error(
                `Invalid timeout: ${shown}. Must be a finite positive number of seconds.`
            );
        }
    }
    if (params.remindDelay !== undefined) {
        if (typeof params.remindDelay !== "string") {
            const shown =
                typeof params.remindDelay === "string"
                    ? JSON.stringify(params.remindDelay)
                    : typeof params.remindDelay;
            throw new Error(
                `Invalid remindDelay: ${shown}. Use a positive duration like "30s", "5m", "2h".`
            );
        }
        const delayMs = parseDurationToMs(params.remindDelay);
        if (delayMs === null || delayMs <= 0) {
            throw new Error(
                `Invalid remindDelay: ${params.remindDelay}. Use a positive duration like "30s", "5m", "2h".`
            );
        }
    }
}

/**
 * Arm the bash_bg deadline wake. The deadline is a decision point, not a
 * kill: when it fires the agent is woken once to inspect progress and decide
 * (extend, jobs kill, ignore). The job is never terminated by the deadline,
 * on any backend — arming this helper on both the tmux and direct-spawn
 * routes is the notification-parity repair.
 *
 * Returns a cancel function; the wake also self-cancels if the job reached a
 * terminal state before the timer fires.
 */
export function armDeadlineWake(
    job: BackgroundJob,
    pi: ExtensionAPI,
    timeoutSeconds: number
): () => void {
    job.deadlineRequestedAt = Date.now();
    const timer = setTimeout(() => {
        // Completion raced the deadline: the wake must not fire after a
        // terminal state was observed.
        if (job.status !== "running") return;
        job.deadlineFiredAt = Date.now();
        const age = formatDuration(Date.now() - job.startTime);
        const progress = jobDecisionEvidence(job);
        sendQueuedMessage(
            pi,
            {
                customType: "bg-deadline",
                content:
                    `⏰ Background job ${job.id} exceeded its ${timeoutSeconds}s deadline (age ${age}) and is still running.\n` +
                    (progress ? `${progress}\n` : "") +
                    `Command: ${job.command}\n` +
                    `Output: ${job.logPath}\n\n` +
                    `The job was NOT terminated. Decide: inspect with jobs attach or jobs output, ` +
                    `terminate with jobs kill, or ignore to let it finish.`,
                display: true,
                details: {
                    jobId: job.id,
                    logPath: job.logPath,
                    command: job.command,
                },
            },
            {
                deliverAs: "followUp",
                triggerTurn: true,
                // Reuses the existing "timeout" kind so completion paths that
                // already cancel queued timeout notifications for a job
                // (notifyCompletion, handleTmuxCompletion, attach) also cancel
                // an undelivered deadline wake.
                queueKey: backgroundNotificationKey(job.id, "timeout"),
            }
        );
    }, timeoutSeconds * 1_000);
    timer.unref();
    return () => clearTimeout(timer);
}

/**
 * Arm a linked reminder on any backend. Assumes validateRequestedPolicies
 * already accepted the delay; a null here is an arming failure, which the
 * caller must surface in the tool result instead of silently dropping the
 * requested reminder.
 */
export function armJobReminder(
    job: BackgroundJob,
    remindDelay: string,
    remindMessage?: string
): { reminderId?: string; armed: boolean } {
    const msg = remindMessage ?? `check on: ${job.command.slice(0, 80)}`;
    const rid = scheduleJobReminder(job.id, remindDelay, msg);
    if (rid) {
        return { reminderId: rid, armed: true };
    }
    return { armed: false };
}

/**
 * Record that termination was requested for a job. Request and observation
 * are separate facts: the job's terminal status still comes only from an
 * observed exit (close event / tmux completion poll), which is what keeps a
 * SIGTERM-ignoring workload from being recorded as killed while alive.
 */
export function requestJobTermination(
    job: BackgroundJob,
    by: TerminationRequester
): void {
    if (job.terminationRequestedAt === undefined) {
        job.terminationRequestedAt = Date.now();
        job.terminationRequestedBy = by;
    }
}

/**
 * Shared formatting for the armed-policy lines in the bash_bg started
 * result, so both backends advertise exactly what was armed.
 */
export function formatArmedPolicies(
    params: { timeout?: number; remindDelay?: string },
    reminder?: { reminderId?: string; armed: boolean }
): string {
    let extra = "";
    if (typeof params.timeout === "number" && params.timeout > 0) {
        extra += `\nDeadline (wake, not kill): ${params.timeout}s`;
    }
    if (params.remindDelay !== undefined) {
        if (reminder?.armed && reminder.reminderId) {
            extra += `\nReminder: ${reminder.reminderId} (in ${params.remindDelay})`;
        } else {
            extra += `\nWarning: reminder could not be armed (requested: ${params.remindDelay})`;
        }
    }
    return extra;
}

// ─── Stall watchdog ─────────────────────────────────────────────────

export interface StallWatchdogOptions {
    /**
     * Suppress the "no output" notice until the job has produced output at
     * least once *after* the watchdog was armed.
     *
     * A job detached because it had already gone silent was surfaced to the
     * agent by the detach notice itself. Re-announcing the same silence one
     * threshold later only produces a second, contradictory "keep it or kill
     * it" prompt — and in non-interactive sessions it points at the
     * job_decide gate this code deliberately leaves disarmed. Oversize
     * termination and interactive-prompt detection are unaffected.
     */
    silenceNoticeOnlyAfterGrowth?: boolean;
}

export const BG_WAIT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Create a throttled tool-progress update for a silent foreground bash wait. */
export function createBgWaitHeartbeat(
    jobId: string,
    startTime: number,
    logPath: string,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    now: () => number = Date.now
): () => void {
    let lastEmittedAt = startTime;
    return () => {
        const currentTime = now();
        if (currentTime - lastEmittedAt < BG_WAIT_HEARTBEAT_INTERVAL_MS) return;
        lastEmittedAt = currentTime;
        let logBytes = 0;
        try {
            logBytes = statSync(logPath).size;
        } catch {
            // The tmux log may not exist yet; report zero bytes in that case.
        }
        onUpdate?.({
            content: [
                {
                    type: "text" as const,
                    text:
                        `[pi-tau] Bash job ${jobId} still running: ` +
                        `elapsedMs=${currentTime - startTime}, logBytes=${logBytes}`,
                },
            ],
            details: undefined,
        });
    };
}

export function startStallWatchdog(
    jobId: string,
    command: string,
    logPath: string,
    pi: ExtensionAPI,
    state: TauState,
    onOversize?: () => void,
    options?: StallWatchdogOptions
): () => void {
    // Seed the baseline with the current size so "growth" means output
    // produced after the watchdog was armed. Starting from 0 would make a log
    // that already had content look like it grew on the first tick, defeating
    // `silenceNoticeOnlyAfterGrowth`.
    let lastSize = 0;
    try {
        lastSize = statSync(logPath).size;
    } catch {
        /* log not created yet */
    }
    let lastGrowth = Date.now();
    let sawGrowth = false;
    let cancelled = false;

    const timer = setInterval(() => {
        if (cancelled) return;
        try {
            const trackedJob = state.backgroundJobs.get(jobId);
            if (trackedJob && trackedJob.status !== "running") {
                cancelled = true;
                clearInterval(timer);
                return;
            }

            const size = statSync(logPath).size;

            if (size > MAX_LOG_BYTES) {
                cancelled = true;
                clearInterval(timer);
                if (onOversize) onOversize();
                const suffix = outstandingJobsSuffix(state, jobId);
                sendQueuedMessage(
                    pi,
                    {
                        customType: "bg-stall",
                        content: `⚠️ Background job ${jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Termination requested (SIGTERM).${suffix}`,
                        display: true,
                        details: { jobId, logPath, command },
                    },
                    {
                        deliverAs: "followUp",
                        triggerTurn: true,
                        queueKey: backgroundNotificationKey(jobId, "stall"),
                    }
                );
                return;
            }

            if (size > lastSize) {
                lastSize = size;
                lastGrowth = Date.now();
                sawGrowth = true;
                return;
            }
            if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

            const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
            const promptLike = looksLikePrompt(tail);
            // A job detached *because* it had gone silent was already surfaced
            // by the detach notice; repeating that same fact one threshold later
            // only adds a contradictory keep/kill prompt. An interactive prompt
            // is different information and always fires. Stay armed (no cancel)
            // so output-then-silence is still announced.
            if (
                !promptLike &&
                options?.silenceNoticeOnlyAfterGrowth &&
                !sawGrowth
            ) {
                return;
            }

            cancelled = true;
            clearInterval(timer);

            const suffix = outstandingJobsSuffix(state, jobId);
            const progress = trackedJob ? jobDecisionEvidence(trackedJob) : "";
            if (promptLike) {
                const summary =
                    `Background job ${jobId} appears to be waiting for interactive input.\n` +
                    (progress ? `${progress}\n` : "") +
                    `Command: ${command}\n\n` +
                    `Last output:\n${tail.trimEnd()}\n\n` +
                    `The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
                    `with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;
                sendQueuedMessage(
                    pi,
                    {
                        customType: "bg-stall",
                        content: `⚠️ ${summary}${suffix}`,
                        display: true,
                        details: { jobId, logPath, command },
                    },
                    {
                        deliverAs: "followUp",
                        triggerTurn: true,
                        queueKey: backgroundNotificationKey(jobId, "stall"),
                    }
                );
                return;
            }

            // Sustained zero growth with no prompt-like output: the job is
            // silent — spinning (e.g. pathological regex), deadlocked, or
            // simply producing no output. Surface it so the agent can decide
            // keep/kill instead of waiting forever. Session analysis: a
            // zero-output job burned one core at 100% for 21.6h while the
            // agent and its parent session stayed blocked on it.
            const summary =
                `Background job ${jobId} has produced no output for ${formatDuration(STALL_THRESHOLD_MS)}.\n` +
                (progress ? `${progress}\n` : "") +
                `Command: ${command}\n\n` +
                `The job may be spinning, hung, or silently computing. Use job_decide ` +
                `to keep it running or kill it.`;
            sendQueuedMessage(
                pi,
                {
                    customType: "bg-stall",
                    content: `⚠️ ${summary}${suffix}`,
                    display: true,
                    details: { jobId, logPath, command },
                },
                {
                    deliverAs: "followUp",
                    triggerTurn: true,
                    queueKey: backgroundNotificationKey(jobId, "stall"),
                }
            );
        } catch {
            // File may not exist yet — skip this tick
        }
    }, STALL_CHECK_INTERVAL_MS);

    timer.unref();
    return () => {
        cancelled = true;
        clearInterval(timer);
    };
}

/** Check if there are any foreground tasks that can be backgrounded. */
export function hasForegroundTasks(state: TauState): boolean {
    return Array.from(state.backgroundJobs.values()).some(
        (job) => job.status === "running" && !job.isBackgrounded && job.proc
    );
}

// ─── Widget / status bar ────────────────────────────────────────────

export const RUNNING_JOBS_WIDGET_REFRESH_MS = 5_000;

/**
 * Create a throttled widget refresh callback for an existing job poller.
 * Reusing the poller avoids a new timer per job; the callback becomes inert
 * when no jobs remain running.
 */
export function createRunningJobsWidgetRefresh(
    state: TauState,
    ctx: UiContext,
    now: () => number = Date.now
): () => void {
    let lastRefreshAt = now();
    return () => {
        const currentTime = now();
        if (currentTime - lastRefreshAt < RUNNING_JOBS_WIDGET_REFRESH_MS) {
            return;
        }
        if (
            !Array.from(state.backgroundJobs.values()).some(
                (job) => job.status === "running"
            )
        ) {
            return;
        }
        lastRefreshAt = currentTime;
        updateWidget(state, ctx);
    };
}

export function updateWidget(state: TauState, ctx: UiContext): void {
    // Runs from completion/terminal paths (timers, process close events) that
    // can fire after the session was replaced; ctx.ui access then throws the
    // stale-ctx assertion. Skip the widget update in that case — there is no
    // UI to update for a replaced session.
    if (staleSafe(() => renderWidget(state, ctx)) === "stale") return;
}

function renderWidget(state: TauState, ctx: UiContext): void {
    const allJobs = Array.from(state.backgroundJobs.values());
    const runningJobs = allJobs.filter((job) => job.status === "running");

    if (runningJobs.length === 0 && !state.agentBackgrounded) {
        ctx.ui.setWidget("background-jobs", undefined);
        ctx.ui.setStatus("background-jobs", undefined);
        return;
    }

    if (state.jobsWidgetHidden) {
        ctx.ui.setWidget("background-jobs", undefined);
        ctx.ui.setStatus("background-jobs", undefined);
        return;
    }

    const pills: string[] = [];
    if (state.agentBackgrounded) {
        pills.push("◐ agent (backgrounded)");
    }
    for (const job of runningJobs) {
        const duration = formatDuration(Date.now() - job.startTime);
        const icon = job.isBackgrounded ? "◐" : "▶";
        pills.push(
            `${icon} ${job.id}: ${job.command.slice(0, 25)} (${duration})`
        );
    }
    ctx.ui.setWidget("background-jobs", pills);

    let statusText = `${runningJobs.length} running`;
    if (state.completedJobCount > 0)
        statusText += `, ${state.completedJobCount} done`;
    if (state.failedJobCount > 0)
        statusText += `, ${state.failedJobCount} failed`;

    ctx.ui.setStatus(
        "background-jobs",
        ctx.ui.theme.fg("accent", `◐ ${statusText}`)
    );
}

/**
 * Look up a job by ID. Tries exact match first, then falls back to
 * prepending "job-" to handle LLMs that strip the prefix. Also checks
 * recent terminal jobs for completed/failed/killed lookups.
 */
export function lookupJob(
    state: TauState,
    jobId: string
): BackgroundJob | undefined {
    return (
        state.backgroundJobs.get(jobId) ??
        state.backgroundJobs.get(`job-${jobId}`) ??
        state.recentTerminalJobs.find(
            (j) => j.id === jobId || j.id === `job-${jobId}`
        )
    );
}

/**
 * Tools that only inspect and cannot conflict with a pending decision.
 *
 * The exemption list used to be `job_decide`/`jobs`/`bash` — exactly the wrong
 * side of the line for a read-only inspection tool, since `bash` (and its
 * `sed -n 'A,Bp' FILE` idiom) stayed available while `read` did not. These
 * four are unconditionally exempt: they read the working tree, cannot mutate
 * state, and a steer aimed at them would be noise that replaces the read the
 * agent asked for.
 */
const READ_ONLY_INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Decide how the tool_call gate treats a tool call while a background job
 * decision is pending.
 *
 * Session analysis of a deployed instance (45 days, ~220k edit results) showed
 * blocking unrelated tool calls replaces their results with the gate reason —
 * 3,905 polluted tool results in one window — wasting the call and hiding the
 * real outcome from both the model and session analytics. Unrelated calls now
 * proceed, and the model is steered once per pending decision instead; only
 * the no-control-tools case still blocks, because there the model has no way
 * to resolve the decision at all.
 *
 * Read-only inspection tools are exempt from BOTH branches. Measured over 90
 * days of sippi sessions, the previous blocking gate (live through August)
 * refused 2,975 reads and 22,503 calls in total while exempting foreground
 * bash — and while the gate was closed, `sed -n 'A,Bp' FILE` was the only way
 * left to read a file. A read cannot conflict with a decision, so the gate was
 * manufacturing the shell idiom it then had to measure: 77.4% of file reads
 * were shell line-range reads that month, falling to 62.6% once the gate
 * stopped blocking.
 */
export function evaluatePendingDecisionGate(
    state: TauState,
    pi: ExtensionAPI,
    toolName: string
): ToolCallEventResult {
    clearStalePendingDecision(state);
    if (state.pendingDecisionJobId === undefined) return {};

    const job = state.backgroundJobs.get(state.pendingDecisionJobId);
    const status =
        job?.status === "running"
            ? "still running"
            : (job?.status ?? "unknown");
    if (READ_ONLY_INSPECTION_TOOLS.has(toolName)) {
        // A read cannot conflict with a decision, so it neither blocks nor
        // steers: the model looking at a file is not ignoring the job, and a
        // refused read is what pushed agents into `sed -n 'A,Bp'` via bash.
        // Exempt in BOTH branches, including the no-control-tools case where
        // nothing else can run.
        return {};
    }
    const controls = getActiveBackgroundControlTools(pi);
    if (controls.length === 0) {
        const progress =
            job?.status === "running" ? jobDecisionEvidence(job) : "";
        return {
            block: true,
            reason:
                `A background job (${state.pendingDecisionJobId}) is awaiting a decision (${status}). ` +
                (progress ? `${progress}. ` : "") +
                "but this session has no active job-control tool (jobs/job_decide). " +
                "Do not run shell kill, pkill, or tmux cleanup commands. " +
                "Ask the operator to enable jobs/job_decide or clear the job externally.",
        };
    }
    if (
        toolName === "job_decide" ||
        toolName === "jobs" ||
        toolName === "bash"
    ) {
        return {};
    }

    // Let the call proceed; steer once per pending decision so the model
    // handles it without losing work already in flight.
    if (state.decisionSteerJobId !== state.pendingDecisionJobId) {
        state.decisionSteerJobId = state.pendingDecisionJobId;
        const progress =
            job?.status === "running" ? jobDecisionEvidence(job) : "";
        pi.sendMessage(
            {
                customType: "tau-pending-decision",
                content:
                    `A background job (${state.pendingDecisionJobId}) is awaiting your decision (${status}). ` +
                    (progress ? `${progress}. ` : "") +
                    `Use ${controls.join(" or ")} before continuing with other work.`,
                display: true,
            },
            { deliverAs: "steer" }
        );
    }
    return {};
}

/**
 * Clear pendingDecisionJobId if it matches the given job's id.
 * Extracted so both bash_bg close/error handlers and job_decide
 * can share the same logic.
 */
export function clearPendingDecision(
    state: TauState,
    job: BackgroundJob
): void {
    if (state.pendingDecisionJobId === job.id) {
        state.pendingDecisionJobId = undefined;
        state.wakeupEvaluate?.();
    }
}

/**
 * Clear a pending decision that points at a terminal or missing job.
 *
 * The decision gate is persisted indirectly through the live state, while job
 * completion can arrive through tmux callbacks, session restoration, or an
 * older extension instance. Make the gate self-healing so a stale notification
 * cannot permanently block the session when no control tool is available.
 */
export function clearStalePendingDecision(state: TauState): void {
    const jobId = state.pendingDecisionJobId;
    if (jobId === undefined) return;

    const job = state.backgroundJobs.get(jobId);
    if (!job || job.status !== "running") {
        state.pendingDecisionJobId = undefined;
        state.wakeupEvaluate?.();
    }
}

/** Maximum number of recent terminal jobs kept for output lookups. */
const MAX_RECENT_TERMINAL = 100;

/** Remove a terminal job from the background jobs map and update counters. */
function removeJob(state: TauState, job: BackgroundJob): void {
    state.backgroundJobs.delete(job.id);
    if (state.pendingDecisionJobId === job.id) {
        state.pendingDecisionJobId = undefined;
    }
    if (job.status === "completed") state.completedJobCount++;
    if (job.status === "failed") state.failedJobCount++;
    state.recentTerminalJobs.push(job);
    if (state.recentTerminalJobs.length > MAX_RECENT_TERMINAL) {
        state.recentTerminalJobs.shift();
    }
    // A terminal transition can make a queued wake obsolete (for example,
    // after a job_decide keep/kill). The wake feature remains optional and
    // communicates through this state hook to avoid a module dependency.
    state.wakeupEvaluate?.();
}

/**
 * Finalize a tmux-backed job at completion.
 *
 * Routes through the same delivery machinery as the direct-spawn path
 * (notifyCompletion → debounced batch → success-suppression → busy-deferral
 * → prune of consumed jobs at delivery), so tmux-backed bash_bg jobs cannot
 * re-awaken the agent with redundant completion notices. Honors `shouldNotify`
 * (notify: false → no toast, no batch, no delivery) and always cleans up the
 * tmux window.
 */
export function handleTmuxCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext,
    shouldNotify: boolean,
    trigger: CompletionTrigger = "poller-observed"
): void {
    if (job.status !== "running") {
        finishJobLiveness(job, job.status, job.exitCode);
    }
    // A terminal tmux result supersedes any queued warning for this job.
    cancelQueuedBackgroundNotification(pi, job.id, "timeout");
    cancelQueuedBackgroundNotification(pi, job.id, "stall");
    if (shouldNotify) {
        // bash_bg's notify option is an explicit request for a completion
        // turn. Preserve it through the shared successful-completion
        // suppression check; otherwise successful tmux jobs are silently
        // dropped even though notify defaults to true.
        job.wantsCompletionNotification = true;
        notifyCompletion(job, state, pi, ctx, trigger);
    } else {
        job.suppressAutonomousWake = true;
        removeJob(state, job);
    }
    killTmuxJob(job);
}

/** Restore the newest persisted background-job snapshot and resume tmux polling. */
export function restoreBackgroundJobs(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    const entry = entries
        .filter(
            (candidate) =>
                candidate.type === "custom" &&
                candidate.customType === "background-tasks-state"
        )
        .at(-1);
    if (!entry || !entry.data || typeof entry.data !== "object") return;

    const recordedTerminalJobIds = new Set(
        entries.flatMap((candidate) => {
            if (
                candidate.type !== "custom" ||
                candidate.customType !== BACKGROUND_JOB_LIVENESS_ENTRY_TYPE ||
                !candidate.data ||
                typeof candidate.data !== "object"
            ) {
                return [];
            }
            const record = candidate.data as {
                event?: unknown;
                jobId?: unknown;
            };
            return record.event === "terminal" &&
                typeof record.jobId === "string"
                ? [record.jobId]
                : [];
        })
    );
    restoreCompletionDeliveryMarkers(entries);
    const data = entry.data as {
        jobs?: Array<
            [
                string,
                Omit<BackgroundJob, "proc" | "donePromise" | "resolveDone">,
            ]
        >;
        jobCounter?: number;
    };
    for (const [id, jobData] of data.jobs ?? []) {
        const restoredSessionId = resolveCompletionSessionId(
            ctx,
            jobData,
            state
        );
        jobData.completionSessionId ??= restoredSessionId;
        const stableGeneration = stableJobGeneration(jobData);
        const stableIdentity = jobData.completionSessionId
            ? stableCompletionIdentity(
                  jobData.completionSessionId,
                  jobData.id,
                  stableGeneration
              )
            : undefined;
        const attemptIdentity =
            stableIdentity &&
            typeof jobData.completionNotificationGeneration === "number"
                ? JSON.stringify([
                      jobData.completionSessionId,
                      jobData.id,
                      stableGeneration,
                      jobData.completionNotificationGeneration,
                  ])
                : stableIdentity;
        if (
            attemptIdentity &&
            deliveredCompletionIdentities.has(attemptIdentity)
        ) {
            jobData.completionDeliveredAt ??= Date.now();
        }
        if (jobData.status === "running") {
            const tmux = (jobData as BackgroundJob & { tmux?: unknown }).tmux;
            if (
                typeof tmux === "object" &&
                tmux !== null &&
                "exitCodeFile" in tmux
            ) {
                const tmuxContext =
                    tmux as import("./bash-tmux.js").TmuxJobContext;
                attachTmuxContext(jobData, tmuxContext);
                state.backgroundJobs.set(id, jobData);
                startJobLiveness(jobData, pi);
                let timer: ReturnType<typeof setInterval> | undefined;
                const poll = (trigger: CompletionTrigger): boolean => {
                    const result = pollTmuxCompletion(jobData);
                    if (!result.completed) return false;
                    if (timer) clearInterval(timer);
                    markJobTerminal(
                        jobData,
                        result.vanished
                            ? "failed"
                            : result.exitCode === 0 || result.exitCode === null
                              ? "completed"
                              : "failed",
                        result.vanished ? undefined : (result.exitCode ?? 0)
                    );
                    clearPendingDecision(state, jobData);
                    void trackJobOutputIndex(jobData, ctx, "bash_bg");
                    handleTmuxCompletion(
                        jobData,
                        state,
                        pi,
                        ctx,
                        true,
                        trigger
                    );
                    updateWidget(state, ctx);
                    return true;
                };
                // A sentinel may already exist when the session is restored.
                // Finalize synchronously; otherwise resume the same poller used
                // for jobs started in this process, including liveness checks.
                if (!poll("restore")) {
                    timer = setInterval(() => poll("poller-observed"), 500);
                    timer.unref?.();
                }
                continue;
            }
            // A direct-spawn job cannot be reattached to its child process.
            try {
                process.kill(jobData.pid, 0);
            } catch {
                jobData.status = "completed";
            }
        }
        state.backgroundJobs.set(id, jobData);
        if (jobData.status === "running") {
            startJobLiveness(jobData, pi);
        } else if (!recordedTerminalJobIds.has(id)) {
            // Backfill one terminal artifact for older snapshots (and direct
            // jobs found dead during restore) without duplicating newer records.
            startJobLiveness(jobData, pi);
            finishJobLiveness(jobData, jobData.status, jobData.exitCode);
        }
    }
    if (typeof data.jobCounter === "number") {
        state.jobCounter = Math.max(state.jobCounter, data.jobCounter);
    }
}

// ─── Job output formatting (grep/tail/head) ──────────────────────────

/**
 * Parameters for formatJobOutput.
 */
export interface FormatJobOutputParams {
    text: string;
    grepPattern?: string;
    headCount?: number;
    tailCount?: number;
}

/**
 * Result of formatJobOutput.
 */
export interface OutputMetadata {
    /** Number of retained/matched lines before head/tail slicing. */
    totalLines: number;
    /** Whether the input already contained a truncation marker. */
    truncated: boolean;
    /** Whether this response is only a view of the available output. */
    partial: boolean;
    /** Number of lines omitted by head/tail or grep filtering, when known. */
    omittedLines?: number;
    /** Original output size in UTF-8 bytes, when known. */
    byteCount: number;
    /** Whether there is no meaningful output. */
    empty: boolean;
    /** Whether reading or formatting the output failed. */
    error: boolean;
    severityCounts?: LogCounts;
    severityDelta?: LogCounts;
    severityScanTruncated?: boolean;
}

export interface FormatJobOutputResult extends OutputMetadata {
    /** The formatted text output (numbered lines, hints footer). */
    text: string;
    /** Backward-compatible alias for `truncated`. */
    isTruncated: boolean;
}

function outputLines(text: string): string[] {
    if (
        text.length === 0 ||
        text === "(no output)" ||
        text === "(no output yet)"
    )
        return [];
    const lines = text.split("\n");
    // A final newline terminates the last line; it does not create an
    // additional empty output line.
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

/** Derive machine-readable metadata from raw output without formatting it. */
export function getOutputMetadata(text: string, error = false): OutputMetadata {
    const emptyPlaceholder =
        text === "(no output)" || text === "(no output yet)";
    const lines = outputLines(emptyPlaceholder ? "" : text);
    return {
        totalLines: lines.length,
        truncated: text.startsWith("...[truncated"),
        partial: text.startsWith("...[truncated"),
        byteCount: Buffer.byteLength(text, "utf8"),
        empty:
            emptyPlaceholder ||
            text.length === 0 ||
            !lines.some((line) => line.trim().length > 0),
        error,
        severityCounts: countLines(emptyPlaceholder ? "" : text),
    };
}

/**
 * Filter lines by grep pattern, apply head/tail slicing, and format with
 * line numbers and hints footer. Used by jobs(action="output") and exposed
 * for unit testing.
 *
 * - If grepPattern is set, only matching lines are included.
 * - headCount/tailCount slice from the start/end of the filtered set.
 * - The result includes a hints footer when lines were hidden or truncated.
 */
export function formatJobOutput(
    params: FormatJobOutputParams
): FormatJobOutputResult {
    const { text, grepPattern, headCount, tailCount } = params;

    // Filter lines (by grep or all)
    const inputMetadata = getOutputMetadata(text);
    const lines = outputLines(text);
    let matched: { line: string; num: number }[];

    if (!grepPattern) {
        matched = lines.map((l, i) => ({ line: l, num: i + 1 }));
    } else {
        let re: RegExp;
        try {
            re = new RegExp(grepPattern, "i");
        } catch {
            return {
                text: `(grep error: invalid regex /${grepPattern}/i)`,
                totalLines: 0,
                truncated: inputMetadata.truncated,
                partial: inputMetadata.partial,
                byteCount: inputMetadata.byteCount,
                empty: false,
                error: true,
                isTruncated: false,
            };
        }
        matched = lines
            .map((l, i) => ({ line: l, num: i + 1 }))
            .filter(({ line }) => re.test(line));
    }

    const totalLines = matched.length;
    const filteredLines = lines.length - matched.length;

    if (matched.length === 0) {
        const text = grepPattern
            ? `(no lines matching /${grepPattern}/i)`
            : "(no lines)";
        return {
            text,
            totalLines,
            truncated: inputMetadata.truncated,
            partial: inputMetadata.partial || lines.length > 0,
            byteCount: inputMetadata.byteCount,
            ...(lines.length > 0 ? { omittedLines: lines.length } : {}),
            empty: true,
            error: false,
            isTruncated: false,
        };
    }

    if (headCount !== undefined) matched = matched.slice(0, headCount);
    if (tailCount !== undefined) matched = matched.slice(-tailCount);

    const metadata = inputMetadata;

    // Format with line numbers
    const body = matched
        .map(({ line, num }) => `${String(num).padStart(4, " ")}: ${line}`)
        .join("\n");

    // Build hints footer
    const hints: string[] = [];
    if (matched.length < totalLines) {
        const hidden = totalLines - matched.length;
        hints.push(`${hidden} more line${hidden !== 1 ? "s" : ""}`);
    }
    if (metadata.truncated) {
        hints.push("output was truncated");
    }

    let result = body;
    if (hints.length > 0) {
        const suggestion = !grepPattern ? " or grep='pattern' to search" : "";
        result += `\n... (${hints.join(", ")}, use head=N or tail=N to see more${suggestion})`;
    }

    const omittedLines = filteredLines + (totalLines - matched.length);
    return {
        text: result,
        totalLines,
        truncated: metadata.truncated,
        partial: metadata.partial || omittedLines > 0,
        ...(omittedLines > 0 ? { omittedLines } : {}),
        byteCount: metadata.byteCount,
        empty: metadata.empty,
        error: false,
        isTruncated: metadata.truncated,
    };
}

export function jobDetails(
    job: BackgroundJob,
    overrides: Partial<JobResultDetails> = {}
): JobResultDetails {
    return {
        jobId: job.id,
        status: job.status,
        ...(job.queued ? { queued: true } : {}),
        exitCode: job.exitCode,
        logPath: job.logPath,
        // Only expose a PID when the job is backed by a real direct process.
        // Tmux jobs carry the -1 sentinel internally; omitting the field here
        // avoids pretending a tmux window has a single PID.
        ...(job.pid > 0 ? { pid: job.pid } : {}),
        startTime: job.startTime,
        ...(job.endTime !== undefined ? { endTime: job.endTime } : {}),
        // Supervision facts, reported separately from the outcome: a requested
        // deadline/termination is never conflated with the observed result.
        ...(job.deadlineRequestedAt !== undefined
            ? { deadlineRequestedAt: job.deadlineRequestedAt }
            : {}),
        ...(job.deadlineFiredAt !== undefined
            ? { deadlineFiredAt: job.deadlineFiredAt }
            : {}),
        ...(job.terminationRequestedAt !== undefined
            ? { terminationRequestedAt: job.terminationRequestedAt }
            : {}),
        ...(job.terminationRequestedBy !== undefined
            ? { terminationRequestedBy: job.terminationRequestedBy }
            : {}),
        // Full duration once terminal; elapsed-so-far while still running.
        durationMs: (job.endTime ?? Date.now()) - job.startTime,
        sourceId: job.sourceId,
        chunkIds: job.chunkIds,
        sidecarIndexStatus: job.sidecarIndexStatus,
        sidecarIndexReason: job.sidecarIndexReason,
        sidecarIndexErrorCategory: job.sidecarIndexErrorCategory,
        ...overrides,
    };
}

async function sourceDetailsForJob(
    job: BackgroundJob
): Promise<JobOutputIndex | undefined> {
    if (job.outputIndexPromise) {
        const indexed = await job.outputIndexPromise;
        if (indexed) return indexed;
    }
    if (job.sourceId) {
        return { sourceId: job.sourceId, chunkIds: job.chunkIds ?? [] };
    }
    return findJobSourceDetailsInSidecar(job.id) ?? undefined;
}

function outputDetails(
    job: BackgroundJob,
    metadata: OutputMetadata,
    source?: JobOutputIndex,
    overrides: Partial<JobResultDetails> = {}
): JobResultDetails {
    return jobDetails(job, {
        ...metadata,
        sourceId: source?.sourceId,
        chunkIds: source?.chunkIds,
        ...overrides,
    });
}

function outputReadFailed(job: BackgroundJob, output: string): boolean {
    return output === "(no output yet)" && !existsSync(job.logPath);
}

function lastLogLine(logPath: string): string | undefined {
    try {
        const tail = readOutputTailSync(logPath, 4_096);
        if (tail === "(no output yet)" || tail === "(no output)")
            return undefined;
        const lines = tail.split(/\r\n|\n|\r/).filter(Boolean);
        const last = lines.at(-1);
        if (!last || last.startsWith("...[truncated")) return undefined;
        return oneLine(last, 160);
    } catch {
        return undefined;
    }
}

export function formatBackgroundEvidence(
    job: BackgroundJob,
    finalize = false
): string {
    try {
        const evidence = jobLogEvidenceTracker.scan(
            job.id,
            job.logPath,
            finalize
        );
        if (!evidence) return "";
        const tail = lastLogLine(job.logPath);
        const parts = [formatLogCounts(evidence.counts)];
        if (evidence.truncated) parts.push("scan capped");
        if (evidence.rotated) parts.push("log rotated");
        if (tail) parts.push(`last: ${tail}`);
        return ` — ${oneLine(parts.join(", "), 260)}`;
    } catch {
        return "";
    }
}

/**
 * Completion notice appended to backgrounding tool results, followed by the
 * event-subscription reminder. The wake sentence matches the delivery rules
 * in flushCompletionBatch:
 * - "guaranteed": the job carries an explicit completion request (bash_bg
 *   with notify !== false, job_decide keep) — success and failure deliver.
 * - "failure-only": auto-backgrounded foreground job — failures always
 *   deliver; a successful completion is suppressed until the agent links a
 *   reminder (remind with jobId).
 * - "none": bash_bg with notify === false — nothing delivers.
 * Linking a reminder both requests completion delivery and arms triggers,
 * so the subscription hint doubles as the fix for the suppressed case.
 */
function backgroundCompletionNotice(
    mode: "guaranteed" | "failure-only" | "none"
): string {
    const subscribe =
        ` To subscribe to events while it runs, use remind with jobId and ` +
        `triggers — e.g. triggers: [{type:"outputLines", value: 200}] (log ` +
        `reaches 200+ lines) or triggers: [{type:"outputMatch", pattern: "ERROR"}] ` +
        `(pattern appears in the log).`;
    switch (mode) {
        case "guaranteed":
            return "You will be notified when it completes." + subscribe;
        case "failure-only":
            return (
                "You will be notified if it fails. To be notified on success " +
                "too, link a reminder (remind with jobId)." +
                subscribe
            );
        case "none":
            return (
                "You will not be notified when it completes. To be notified, " +
                "link a reminder (remind with jobId)." +
                subscribe
            );
    }
}

function logEvidenceMetadata(
    job: BackgroundJob,
    finalize = false,
    trackerKey = job.id
):
    | Pick<
          OutputMetadata,
          "severityCounts" | "severityDelta" | "severityScanTruncated"
      >
    | undefined {
    try {
        const evidence = jobLogEvidenceTracker.scan(
            trackerKey,
            job.logPath,
            finalize
        );
        if (!evidence) return undefined;
        return {
            severityCounts: evidence.counts,
            severityDelta: evidence.delta,
            severityScanTruncated: evidence.truncated,
        };
    } catch {
        return undefined;
    }
}

function jobDecisionEvidence(job: BackgroundJob): string {
    try {
        const evidence = jobLogEvidenceTracker.scan(job.id, job.logPath);
        if (!evidence) return "";
        const sample = evidence.firstError
            ? `; first err: ${oneLine(evidence.firstError, 96)}`
            : "";
        const growth = evidence.fileSize > 0 ? "yes" : "no";
        const scanNote = evidence.truncated ? "; log scan capped" : "";
        return oneLine(
            `Progress: ${formatDuration(Date.now() - job.startTime)} elapsed; ${evidence.counts.total} lines (totals ${evidence.counts.err} err, ${evidence.counts.warn} warn); output growth since launch ${growth}; +${evidence.delta.total} lines since prior check (+${evidence.delta.err} err, +${evidence.delta.warn} warn)${sample}${scanNote}`,
            260
        );
    } catch {
        return "";
    }
}

function completionLogEvidence(job: BackgroundJob): {
    text: string;
    counts?: LogCounts;
} {
    try {
        const evidence = jobLogEvidenceTracker.scan(job.id, job.logPath, true);
        if (!evidence) return { text: "" };
        const parts = [formatLogCounts(evidence.counts)];
        if (evidence.truncated) parts.push("scan capped");
        if (evidence.rotated) parts.push("log rotated");
        const tail = lastLogLine(job.logPath);
        if (tail) parts.push(`last: ${tail}`);
        return {
            text: oneLine(parts.join("; "), 220),
            counts: evidence.counts,
        };
    } catch {
        return { text: "" };
    }
}

/**
 * Preserve the same structured output metadata for foreground bash results
 * that jobs output already returns for background jobs. Short complete output
 * stays lightweight; reduced output carries its recovery reference and size.
 */
/**
 * Index a `pipe-nerf` stage-0 capture so a re-filter can run against it.
 *
 * Stage 0 is the command's own output BEFORE any filter, which every later pipe
 * stage is a deterministic function of. The command runs filtered, so this is
 * the only copy of it that exists. Indexed with `force`, because the inline
 * threshold that normally gates indexing is sized for "output nobody discarded",
 * and this output has just been filtered away.
 *
 * Returns the source id so the removal note can name it, or null when indexing
 * was unavailable -- which is not a failure: the file is still on disk at `path`
 * and the note offers it as a path.
 */
async function indexStageZeroCapture(
    capture: PipeStageZeroCapture,
    command: string,
    toolCallId: string,
    ctx: UiContext,
    exitCode?: number,
    status?: string
): Promise<string | null> {
    try {
        const outcome = await indexJobOutputWithOutcome(
            {
                id: `${toolCallId}-stage0`,
                command: capture.command.startsWith("Compound stage-0 capture:")
                    ? capture.command
                    : command,
                logPath: capture.path,
                exitCode,
                status,
            },
            ctx,
            "bash",
            { force: true, useExternalApi: false }
        );
        const sourceId = outcome.source?.sourceId ?? null;
        if (sourceId) {
            markStage0CaptureIndexed(capture.path, sourceId);
            sweepStage0Captures({
                directories: [
                    stageZeroDirectory(),
                    legacyStage0Directory(homedir()),
                ],
            });
        }
        return sourceId;
    } catch {
        // A capture write that could not be indexed is still a file on disk; the
        // note falls back to naming the path.
        return null;
    }
}

function preparedOutputDetails(
    prepared: Awaited<ReturnType<typeof prepareInlineOutput>>,
    logPath: string,
    /**
     * Include `fullOutputPath` even when nothing was truncated or indexed.
     *
     * The log file exists for every bash call regardless of size, so returning
     * `undefined` here hid a real path from the agent: measured over 7 days,
     * 361,451 of 364,362 bash results carried no path at all, which is every
     * small command. An agent that piped its output had no way to re-filter the
     * captured text locally, and re-ran instead.
     */
    alwaysIncludePath = false
): Partial<JobResultDetails> | undefined {
    if (!prepared.truncated && !prepared.source && !alwaysIncludePath) {
        return undefined;
    }
    return {
        ...(prepared.totalLines !== undefined
            ? { totalLines: prepared.totalLines }
            : {}),
        ...(prepared.byteCount !== undefined
            ? { byteCount: prepared.byteCount }
            : {}),
        ...(prepared.empty !== undefined ? { empty: prepared.empty } : {}),
        truncated: prepared.truncated,
        ...(prepared.partial !== undefined
            ? { partial: prepared.partial }
            : {}),
        ...(prepared.indexOutcome
            ? {
                  sidecarIndexStatus: prepared.indexOutcome.status,
                  sidecarIndexReason: prepared.indexOutcome.reason,
                  sidecarIndexErrorCategory:
                      prepared.indexOutcome.errorCategory,
              }
            : {}),
        ...(prepared.source
            ? {
                  sourceId: prepared.source.sourceId,
                  chunkIds: prepared.source.chunkIds,
              }
            : {}),
        fullOutputPath: logPath,
    };
}

/**
 * Count outstanding (still-running) jobs for a cosmetic suffix in
 * completion notifications. Uses `process.kill(pid, 0)` as a quick
 * liveness check — the signal 0 test returns successfully for running
 * processes without actually sending a signal. EACCES/EPERM from
 * permission errors on other platforms are treated as "running" since
 * they indicate the process exists. This is cosmetic only; job state
 * correctness is managed via the close handler.
 */
function outstandingJobsSuffix(state: TauState, excludeJobId: string): string {
    const count = countOutstandingJobs(state, excludeJobId);
    return count > 0 ? ` (${count} jobs outstanding)` : "";
}

/**
/**
 * Batch state for job-completion notifications.
 * Completions that fire close together are aggregated into one message
 * so the agent doesn't get re-awoken for every individual job.
 */

const BATCH_DEBOUNCE_MS = 2000; // sliding window: each new completion resets this
const BATCH_MAX_DELAY_MS = 10000; // force flush this long after the first job in the batch
// 284k completed tool-call pairs across 628 files: p95 25.7s, p99 81.4s.
// Round p95 up to 30s (25.7 + 4.3s headroom); about 5% take the handle path.
const INLINE_ATTACH_WINDOW_MS = 30_000;
const ACKNOWLEDGED_STALE_MAX_AGE_MS = 5 * 60 * 1000;

type CompletionTrigger =
    | "poller-observed"
    | "kill"
    | "deadline"
    | "cancel-miss-rearm"
    | "flush-suppressed-rearm"
    | "restore"
    | "other";

type CompletionBatchItem = {
    job: BackgroundJob;
    duration: string;
    emoji: string;
    /** Per-notification attempt generation, used to invalidate stale callbacks. */
    generation: number;
    /** Stable per-job generation persisted in the background task snapshot. */
    jobGeneration: number;
    /** Session owning this completion, captured before async indexing. */
    sessionId: string;
    /**
     * Jobs still running when THIS job completed, captured here because
     * delivery can be deferred by an agent-busy window for minutes. Counting
     * at delivery time made a notice report a world minutes newer than the
     * `duration` beside it, and after a session restore the captured state
     * no longer held the live siblings at all.
     */
    outstandingJobs: number;
};

const completionBatch: {
    jobs: CompletionBatchItem[];
    timer?: NodeJS.Timeout;
    startTime: number; // timestamp of the first job in the current batch
    pi?: ExtensionAPI;
    state?: TauState;
} = { jobs: [], startTime: 0 };

type PendingCompletionDelivery = {
    jobs: CompletionBatchItem[];
    pi: ExtensionAPI;
    state: TauState;
    sessionId: string;
    queueKey: string;
};

const pendingCompletionDeliveries: PendingCompletionDelivery[] = [];
const queuedCompletionDeliveries = new Map<string, PendingCompletionDelivery>();
const possiblyDeliveredCompletionDeliveries = new Map<
    string,
    PendingCompletionDelivery
>();
const acknowledgedCompletionAt = new Map<string, number>();
const completionDeliveryInstance = randomUUID();
let completionDeliverySequence = 0;

function nextCompletionQueueKey(): string {
    return `tau:bg:completion:${completionDeliveryInstance}:${++completionDeliverySequence}`;
}

/** Stable generation is persisted on first observation when legacy jobs lack it. */
let fallbackJobGenerationCounter = 0;
function stableJobGeneration(job: BackgroundJob): number {
    if (Number.isSafeInteger(job.generation) && job.generation! >= 0) {
        return job.generation!;
    }
    // The visible id counter can restart with TauState and two independently
    // restored/test-created jobs can share an id. A timestamp-derived sequence
    // is persisted on the job snapshot, so event identity remains stable.
    const generation = Math.max(
        0,
        Math.trunc(job.startTime * 1_000) + ++fallbackJobGenerationCounter
    );
    job.generation = generation;
    return generation;
}

const fallbackSessionIds = new WeakMap<TauState, string>();

function resolveCompletionSessionId(
    ctx: UiContext,
    job: BackgroundJob,
    state: TauState
): string {
    if (job.completionSessionId) return job.completionSessionId;
    try {
        const sessionId = ctx.sessionManager?.getSessionId?.();
        if (typeof sessionId === "string" && sessionId.length > 0) {
            job.completionSessionId = sessionId;
            return sessionId;
        }
    } catch {
        // A replaced extension context may no longer expose its session.
    }
    // This fallback intentionally scopes an unidentifiable event to this pi
    // process; it cannot suppress a completion after a process restart.
    let fallback = fallbackSessionIds.get(state);
    if (!fallback) {
        fallback = `unknown-process-${process.pid}-${randomUUID()}`;
        fallbackSessionIds.set(state, fallback);
    }
    job.completionSessionId = fallback;
    return fallback;
}

function stableCompletionIdentity(
    sessionId: string,
    jobId: string,
    generation: number
): string {
    return JSON.stringify([sessionId, jobId, generation]);
}

function completionAttemptIdentity(item: CompletionBatchItem): string {
    return JSON.stringify([
        item.sessionId,
        item.job.id,
        item.jobGeneration,
        item.generation,
    ]);
}

const deliveredCompletionIdentities = new Set<string>();
let completionTelemetryUnavailableCount = 0;

export function getCompletionTelemetryUnavailableCount(): number {
    return completionTelemetryUnavailableCount;
}

function restoreCompletionDeliveryMarkers(
    entries: Array<{ type: string; customType?: string; data?: unknown }>
): void {
    for (const entry of entries) {
        if (
            entry.type !== "custom" ||
            entry.customType !== "background-completion-telemetry" ||
            !entry.data ||
            typeof entry.data !== "object"
        ) {
            continue;
        }
        const data = entry.data as Record<string, unknown>;
        if (
            typeof data.sessionId !== "string" ||
            typeof data.jobId !== "string" ||
            typeof data.jobGeneration !== "number"
        ) {
            continue;
        }
        const identity = stableCompletionIdentity(
            data.sessionId,
            data.jobId,
            data.jobGeneration
        );
        const notificationGeneration =
            typeof data.generation === "number" ? data.generation : undefined;
        const attemptIdentity =
            notificationGeneration === undefined
                ? identity
                : JSON.stringify([
                      data.sessionId,
                      data.jobId,
                      data.jobGeneration,
                      notificationGeneration,
                  ]);
        if (
            (data.event === "delivery-terminal" &&
                (data.reason === "delivered" || data.reason === "consumed")) ||
            data.event === "delivered-to-agent"
        ) {
            deliveredCompletionIdentities.add(attemptIdentity);
        } else if (
            (data.event === "delivery-terminal" &&
                data.reason === "cancelled") ||
            data.event === "delivery-cancelled"
        ) {
            deliveredCompletionIdentities.delete(attemptIdentity);
        }
    }
}

function pruneQueuedCompletionDeliveryMetadata(state: TauState): void {
    // Keep metadata only for jobs still addressable in the active/recent job
    // registry. recentTerminalJobs is capped, so retained delivery metadata is
    // bounded without mutating the host queue or dropping live job keys.
    if (state.recentTerminalJobs.length < MAX_RECENT_TERMINAL) return;
    const addressable = new Set([
        ...state.backgroundJobs.values(),
        ...state.recentTerminalJobs,
    ]);
    for (const [queueKey, delivery] of queuedCompletionDeliveries) {
        if (delivery.state !== state) continue;
        // Keep every item in a live keyed batch: removing an older sibling
        // would silently lose its notification when another member is acked.
        if (!delivery.jobs.some(({ job }) => addressable.has(job))) {
            queuedCompletionDeliveries.delete(queueKey);
            recordCompletionTelemetry(delivery.pi, "metadata-pruned", {
                queueKey,
                jobIds: delivery.jobs.map(({ job }) => job.id),
            });
        }
    }
}

function recordCompletionTelemetry(
    pi: ExtensionAPI,
    event: string,
    fields: {
        queueKey?: string;
        jobIds?: string[];
        jobId?: string;
        sessionId?: string;
        generation?: number;
        jobGeneration?: number;
        reason?:
            | "delivered"
            | "suppressed-stale"
            | "suppressed-acknowledged"
            | "cancelled";
        ageSeconds?: number;
        batchSize?: number;
        ageMs?: number;
        durationMs?: number;
        status?: BackgroundJob["status"];
        exitCode?: number;
        trigger?: CompletionTrigger;
        observedBy?: CompletionTrigger;
        outstandingJobs?: number;
        delivery?: "immediate" | "deferred-batch" | "suppressed";
    } = {}
): void {
    const appendEntry = (
        pi as ExtensionAPI & {
            appendEntry?: (
                customType: string,
                data: Record<string, unknown>
            ) => void;
        }
    ).appendEntry;
    if (!appendEntry) {
        completionTelemetryUnavailableCount++;
        return;
    }
    try {
        if (pendingStaleCompletionSendCount > 0) {
            appendEntry("background-completion-telemetry", {
                event: "stale-context-skipped",
                count: pendingStaleCompletionSendCount,
                at: Date.now(),
            });
            pendingStaleCompletionSendCount = 0;
        }
        appendEntry("background-completion-telemetry", {
            event,
            at: Date.now(),
            ...(fields.queueKey ? { queueKey: fields.queueKey } : {}),
            ...(fields.jobIds ? { jobIds: fields.jobIds } : {}),
            ...(fields.jobId ? { jobId: fields.jobId } : {}),
            ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
            ...(fields.jobGeneration !== undefined
                ? { jobGeneration: fields.jobGeneration }
                : {}),
            ...(fields.reason ? { reason: fields.reason } : {}),
            ...(fields.ageSeconds !== undefined
                ? { ageSeconds: fields.ageSeconds }
                : {}),
            ...(fields.batchSize !== undefined
                ? { batchSize: fields.batchSize }
                : {}),
            ...(fields.ageMs !== undefined ? { ageMs: fields.ageMs } : {}),
            ...(fields.durationMs !== undefined
                ? { durationMs: fields.durationMs }
                : {}),
            ...(fields.status ? { status: fields.status } : {}),
            ...(fields.exitCode !== undefined
                ? { exitCode: fields.exitCode }
                : {}),
            ...(fields.generation !== undefined
                ? { generation: fields.generation }
                : {}),
            ...(fields.trigger ? { trigger: fields.trigger } : {}),
            ...(fields.observedBy ? { observedBy: fields.observedBy } : {}),
            ...(fields.outstandingJobs !== undefined
                ? { outstandingJobs: fields.outstandingJobs }
                : {}),
            ...(fields.delivery ? { delivery: fields.delivery } : {}),
        });
    } catch {
        completionTelemetryUnavailableCount++;
        // Telemetry must never interfere with completion delivery or cancellation.
    }
}
let completionAgentBusy = false;
let completionLifecycleToken = 0;
let pendingStaleCompletionSendCount = 0;
let settledCompletionFlushTimer: NodeJS.Timeout | undefined;
// Prevent duplicate notifications when both error and close handlers fire.
// A Set (rather than WeakSet) lets cancellation restore a completion that was
// marked before asynchronous indexing/enqueueing finished.
//
// Deliberately keyed by object identity, not by job id: job ids are
// `tmux-<pid>-<counter>` and the counter restarts with each TauState, so a
// second job in the same process can legitimately reuse an id. Keying by id
// suppresses that job's completion notice (two bg-deadline-wake tests catch
// it). The cost is that a session-restored object for an already-notified job
// is not deduplicated here.
const completionNotifiedJobs = new Set<BackgroundJob>();
// Jobs marked for completion notification but not yet delivered. Cancellation
// removes them here so autonomous wake evaluation can expose them again.
const pendingCompletionJobs = new Map<string, BackgroundJob>();
const deliveringCompletionJobIds = new Set<string>();
// Per-job generations invalidate asynchronous indexing callbacks after a
// completion is cancelled and then potentially re-notified.
const completionJobGenerations = new Map<string, number>();
const completionRearmTriggers = new WeakMap<BackgroundJob, CompletionTrigger>();
// Invalidates asynchronous indexing callbacks after a batch is cleared.
let completionBatchGeneration = 0;

/**
 * Count live running jobs for completion-notice suffixes.
 *
 * A missing pid is treated as outstanding because there is no process handle
 * with which to prove the job is dead. EACCES/EPERM likewise means the process
 * exists but cannot be signalled; other kill errors (notably ESRCH) mean it is
 * not live. Job status remains authoritative for excluding terminal jobs.
 */
function countOutstandingJobs(state: TauState, excludeJobId?: string): number {
    return Array.from(state.backgroundJobs.values()).filter((job) => {
        if (job.id === excludeJobId || job.status !== "running") return false;
        if (job.pid === undefined) return true;
        try {
            process.kill(job.pid, 0);
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return code === "EACCES" || code === "EPERM";
        }
    }).length;
}

function isCompletionAcknowledged(item: CompletionBatchItem): boolean {
    return (
        acknowledgedCompletionAt.has(
            stableCompletionIdentity(
                item.sessionId,
                item.job.id,
                item.jobGeneration
            )
        ) || acknowledgedCompletionAt.has(`job:${item.job.id}`)
    );
}

function recordCompletionItemTelemetry(
    pi: ExtensionAPI,
    event: string,
    item: CompletionBatchItem,
    extra: Parameters<typeof recordCompletionTelemetry>[2] = {}
): void {
    recordCompletionTelemetry(pi, event, {
        jobId: item.job.id,
        sessionId: item.sessionId,
        generation: item.generation,
        jobGeneration: item.jobGeneration,
        status: item.job.status,
        exitCode: item.job.exitCode,
        ...extra,
    });
}

export function flushCompletionBatch(): void {
    const batch = completionBatch.jobs.splice(0);
    const pi = completionBatch.pi!;
    const state = completionBatch.state!;
    completionBatch.timer = undefined;
    completionBatch.startTime = 0;
    completionBatch.pi = undefined;
    completionBatch.state = undefined;

    if (batch.length === 0) return;
    const freshBatch = batch;
    for (const item of freshBatch) {
        recordCompletionItemTelemetry(pi, "batch-flushed", item, {
            batchSize: freshBatch.length,
            outstandingJobs: item.outstandingJobs,
            delivery: "deferred-batch",
        });
    }
    if (freshBatch.length === 0) return;

    // Suppress successful completions to avoid wasted LLM turns — UNLESS
    // one of the jobs has linked callbacks (meaning the agent explicitly
    // asked to be reminded) OR a linked callback fired while the job was
    // still running (meaning a progress check was delivered but the agent
    // still wants the final completion notification). In either case,
    // deliver the notification (which cancels any remaining linked callbacks).
    // Failed completions are always delivered.
    if (!hasFailedCompletion(freshBatch)) {
        const hasLinked = freshBatch.some(
            (j) =>
                hasLinkedCallbacksForJob(j.job.id) ||
                j.job.wantsCompletionNotification
        );
        if (!hasLinked) {
            // No normal follow-up is emitted for an unlinked successful
            // completion. Record this terminal outcome and leave it visible
            // to the optional autonomous wake evaluator.
            for (const item of freshBatch) {
                recordCompletionItemTelemetry(pi, "delivery-terminal", item, {
                    reason: "cancelled",
                    status: item.job.status,
                    exitCode: item.job.exitCode,
                });
                item.job.completionNotified = false;
                completionNotifiedJobs.delete(item.job);
                completionRearmTriggers.set(item.job, "flush-suppressed-rearm");
                pendingCompletionJobs.delete(item.job.id);
            }
            state.wakeupEvaluate?.();
            return;
        }
    }

    queueCompletionDelivery(freshBatch, pi, state);
}

function hasFailedCompletion(jobs: CompletionBatchItem[]): boolean {
    return jobs.some((j) => j.job.status !== "completed");
}

function completionNeedsDelivery(jobs: CompletionBatchItem[]): boolean {
    return (
        hasFailedCompletion(jobs) ||
        jobs.some(
            ({ job }) =>
                job.status === "completed" &&
                (job.wantsCompletionNotification ||
                    hasLinkedCallbacksForJob(job.id))
        )
    );
}

function restoreCompletionForWake(
    job: BackgroundJob,
    wakeStates: Set<TauState>,
    state?: TauState,
    trigger: CompletionTrigger = "flush-suppressed-rearm"
): void {
    if (deliveringCompletionJobIds.has(job.id)) return;
    pendingCompletionJobs.delete(job.id);
    completionNotifiedJobs.delete(job);
    completionRearmTriggers.set(job, trigger);
    job.completionDeliveredAt = undefined;
    job.completionNotified = false;
    completionJobGenerations.set(
        job.id,
        (completionJobGenerations.get(job.id) ?? 0) + 1
    );
    if (state) wakeStates.add(state);
}

function pruneConsumedCompletions(
    jobs: CompletionBatchItem[]
): CompletionBatchItem[] {
    const unconsumedFailed = jobs.filter(
        (j) => j.job.status !== "completed" && !j.job.outputConsumed
    );
    const unconsumedCompleted = jobs.filter(
        (j) => j.job.status === "completed" && !j.job.outputConsumed
    );

    if (unconsumedFailed.length === 0 && unconsumedCompleted.length === 0) {
        return [];
    }

    const failedIds = new Set(unconsumedFailed.map((j) => j.job.id));
    const completedIds = new Set(unconsumedCompleted.map((j) => j.job.id));

    return jobs.filter(
        (j) => completedIds.has(j.job.id) || failedIds.has(j.job.id)
    );
}

/** Best-effort GPU utilization snapshot at the time a job completes. */
function readGpuSnapshot(): string | null {
    try {
        const entries = readdirSync("/sys/class/drm");
        const lines: string[] = [];
        for (const entry of entries) {
            if (!entry.startsWith("card") || entry.includes("-")) continue;
            try {
                const busy = parseInt(
                    readFileSync(
                        `/sys/class/drm/${entry}/device/gpu_busy_percent`,
                        "utf-8"
                    ).trim(),
                    10
                );
                let temp = "";
                try {
                    const hwmons = readdirSync("/sys/class/hwmon");
                    for (const hw of hwmons) {
                        try {
                            const name = readFileSync(
                                `/sys/class/hwmon/${hw}/name`,
                                "utf-8"
                            ).trim();
                            if (name === "amdgpu" || name === "i915") {
                                const t = parseInt(
                                    readFileSync(
                                        `/sys/class/hwmon/${hw}/temp1_input`,
                                        "utf-8"
                                    ).trim(),
                                    10
                                );
                                temp = ` ${(t / 1000).toFixed(0)}C`;
                                break;
                            }
                        } catch {
                            /* hwmon read failed — ignore */
                        }
                    }
                } catch {
                    /* gpu busy read failed — ignore */
                }
                lines.push(`${entry}: ${busy}%${temp}`);
            } catch {
                /* card entry read failed — ignore */
            }
        }
        return lines.length > 0 ? lines.join(", ") : null;
    } catch {
        return null;
    }
}

function completeCompletionDeliveryHandoff(
    delivery: PendingCompletionDelivery,
    sent: boolean
): void {
    const { pi } = delivery;
    if (!sent) {
        pendingStaleCompletionSendCount++;
        for (const item of delivery.jobs) {
            recordCompletionItemTelemetry(pi, "delivery-terminal", item, {
                reason: "cancelled",
                status: item.job.status,
                exitCode: item.job.exitCode,
            });
        }
        return;
    }

    const { state } = delivery;
    pruneQueuedCompletionDeliveryMetadata(state);
    queuedCompletionDeliveries.set(delivery.queueKey, delivery);
    recordCompletionTelemetry(pi, "queued", {
        queueKey: delivery.queueKey,
        jobIds: delivery.jobs.map(({ job }) => job.id),
    });
    const deliveredAt = Date.now();
    for (const item of delivery.jobs) {
        const { job } = item;
        pendingCompletionJobs.delete(job.id);
        job.completionDeliveredAt = deliveredAt;
        deliveredCompletionIdentities.add(completionAttemptIdentity(item));
        recordCompletionItemTelemetry(pi, "delivery-terminal", item, {
            reason: "delivered",
            batchSize: delivery.jobs.length,
            ageMs:
                job.endTime === undefined
                    ? undefined
                    : Math.max(0, deliveredAt - job.endTime),
            durationMs:
                job.endTime === undefined
                    ? undefined
                    : Math.max(0, job.endTime - job.startTime),
            delivery: "immediate",
        });
    }
}

function deliverCompletionNotification(
    delivery: PendingCompletionDelivery
): void {
    const originalJobs = delivery.jobs;
    const unconsumed = pruneConsumedCompletions(originalJobs);
    for (const item of originalJobs) {
        if (item.job.outputConsumed) {
            const now = Date.now();
            recordCompletionItemTelemetry(
                delivery.pi,
                "consumed-suppressed",
                item,
                { batchSize: delivery.jobs.length, delivery: "suppressed" }
            );
            recordCompletionItemTelemetry(
                delivery.pi,
                "delivery-terminal",
                item,
                {
                    reason: "suppressed-acknowledged",
                    ageSeconds: Math.max(
                        0,
                        Math.floor((now - (item.job.endTime ?? now)) / 1000)
                    ),
                    status: item.job.status,
                    exitCode: item.job.exitCode,
                }
            );
        }
    }
    const eligible = unconsumed.filter((item) => {
        if (!isCompletionAcknowledged(item)) return true;
        const now = Date.now();
        recordCompletionItemTelemetry(
            delivery.pi,
            "acknowledged-suppressed",
            item,
            { batchSize: delivery.jobs.length, delivery: "suppressed" }
        );
        recordCompletionItemTelemetry(delivery.pi, "delivery-terminal", item, {
            reason: "suppressed-acknowledged",
            ageSeconds: Math.max(
                0,
                Math.floor((now - (item.job.endTime ?? now)) / 1000)
            ),
            status: item.job.status,
            exitCode: item.job.exitCode,
        });
        return false;
    });
    delivery.jobs = eligible;
    if (eligible.length === 0) {
        for (const { job } of originalJobs)
            pendingCompletionJobs.delete(job.id);
        return;
    }

    const now = Date.now();
    const stale = eligible.filter(
        ({ job }) =>
            job.endTime !== undefined &&
            now - job.endTime > ACKNOWLEDGED_STALE_MAX_AGE_MS
    );
    const staleIdentities = new Set(
        stale.map((item) =>
            stableCompletionIdentity(
                item.sessionId,
                item.job.id,
                item.jobGeneration
            )
        )
    );
    const batch = eligible.filter(
        (item) =>
            !staleIdentities.has(
                stableCompletionIdentity(
                    item.sessionId,
                    item.job.id,
                    item.jobGeneration
                )
            )
    );
    for (const item of stale) {
        const ageSeconds = Math.max(
            0,
            Math.floor((now - (item.job.endTime ?? now)) / 1000)
        );
        recordCompletionItemTelemetry(delivery.pi, "suppressed-stale", item, {
            batchSize: eligible.length,
            ageMs: Math.max(0, now - (item.job.endTime ?? now)),
            delivery: "suppressed",
        });
        recordCompletionItemTelemetry(delivery.pi, "delivery-terminal", item, {
            reason: "suppressed-stale",
            ageSeconds,
            status: item.job.status,
            exitCode: item.job.exitCode,
        });
    }
    const olderFailures = stale
        .filter(({ job }) => job.status !== "completed")
        .map(
            ({ job }) =>
                `${job.id} (${job.status}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""})`
        );
    const staleSummary =
        stale.length > 0
            ? `${stale.length} older completion${stale.length === 1 ? "" : "s"} suppressed from individual delivery.` +
              (olderFailures.length > 0
                  ? ` Older failures: ${olderFailures.join(", ")}.`
                  : "")
            : "";

    const { pi } = delivery;
    if (batch.length === 0) {
        delivery.jobs = [];
        const sent = sendQueuedMessage(
            pi,
            {
                customType: "job-completion",
                content: staleSummary,
                display: true,
                details: {
                    suppressedOlderCount: stale.length,
                    olderFailures,
                    batchSize: eligible.length,
                },
            },
            {
                deliverAs: "followUp",
                triggerTurn: true,
                queueKey: delivery.queueKey,
            }
        );
        completeCompletionDeliveryHandoff(delivery, sent);
        return;
    }
    // Use the count captured when each job completed, not a fresh count: the
    // delivery may be minutes later (agent-busy deferral), and the notice's
    // own `duration` describes the completion instant.
    const outstandingCount = Math.max(
        0,
        ...batch.map((item) => item.outstandingJobs)
    );
    const suffix =
        outstandingCount > 0 ? ` (${outstandingCount} jobs outstanding)` : "";
    const completionEvidenceById = new Map<
        string,
        ReturnType<typeof completionLogEvidence>
    >();
    for (const item of batch) {
        completionEvidenceById.set(
            item.job.id,
            completionLogEvidence(item.job)
        );
    }

    delivery.jobs = batch;
    if (batch.length === 1) {
        const { job, duration, emoji } = batch[0];
        const logEvidence = completionEvidenceById.get(job.id);
        const exitLine =
            job.exitCode !== undefined ? `, exit ${job.exitCode}` : "";
        // Supervision facts ride along, never replacing the outcome: a
        // requested termination or a fired deadline wake stays visible on a
        // completed/failed job instead of being rewritten into it.
        const supervisionLine =
            (job.terminationRequestedAt !== undefined
                ? `, termination requested (${job.terminationRequestedBy ?? "unknown"})`
                : "") +
            (job.deadlineFiredAt !== undefined
                ? ", deadline fired (wake only)"
                : "");

        // Best-effort GPU snapshot at completion time
        const gpuLine = readGpuSnapshot();
        const resourceInfo = gpuLine ? `\nGPU: ${gpuLine}` : "";

        const sent = sendQueuedMessage(
            pi,
            {
                customType: "job-completion",
                content:
                    `${emoji} ${job.id} ${job.status} (${duration})${suffix}${exitLine}${supervisionLine}\n` +
                    `${logEvidence?.text ? `Output evidence: ${logEvidence.text}\n` : ""}` +
                    `Command: ${job.command}\nOutput: ${job.logPath}${
                        job.sidecarIndexStatus === "failed"
                            ? `\nWarning: sidecar indexing failed (${job.sidecarIndexErrorCategory ?? "unknown"}); output remains at the log path.`
                            : ""
                    }${resourceInfo}${staleSummary ? `\n${staleSummary}` : ""}`,
                display: true,
                details: {
                    jobId: job.id,
                    sessionId: batch[0].sessionId,
                    generation: batch[0].generation,
                    jobGeneration: batch[0].jobGeneration,
                    suppressedOlderCount: stale.length,
                    olderFailures,
                    status: job.status,
                    exitCode: job.exitCode,
                    duration,
                    ...(job.deadlineRequestedAt !== undefined
                        ? { deadlineRequestedAt: job.deadlineRequestedAt }
                        : {}),
                    ...(job.deadlineFiredAt !== undefined
                        ? { deadlineFiredAt: job.deadlineFiredAt }
                        : {}),
                    ...(job.terminationRequestedAt !== undefined
                        ? { terminationRequestedAt: job.terminationRequestedAt }
                        : {}),
                    ...(job.terminationRequestedBy !== undefined
                        ? { terminationRequestedBy: job.terminationRequestedBy }
                        : {}),
                    ...(logEvidence?.counts
                        ? { severityCounts: logEvidence.counts }
                        : {}),
                    command: job.command,
                    logPath: job.logPath,
                    sourceId: job.sourceId,
                    chunkIds: job.chunkIds,
                    sidecarIndexStatus: job.sidecarIndexStatus,
                    sidecarIndexReason: job.sidecarIndexReason,
                    sidecarIndexErrorCategory: job.sidecarIndexErrorCategory,
                    outstandingJobs: outstandingCount,
                },
            },
            {
                deliverAs: "followUp",
                triggerTurn: true,
                queueKey: delivery.queueKey,
            }
        );
        completeCompletionDeliveryHandoff(delivery, sent);
        return;
    }

    const completed = batch.filter((j) => j.job.status === "completed");
    const failed = batch.filter((j) => j.job.status !== "completed");
    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} completed`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);

    const header = `🏁 ${parts.join(", ")}${suffix}`;
    const lines = batch.map(
        (j) =>
            `  ${j.emoji} ${j.job.id} ${j.job.status} (${j.duration})${
                j.job.exitCode !== undefined ? `, exit ${j.job.exitCode}` : ""
            }${
                j.job.terminationRequestedAt !== undefined
                    ? `, termination requested (${j.job.terminationRequestedBy ?? "unknown"})`
                    : ""
            }${
                j.job.deadlineFiredAt !== undefined
                    ? ", deadline fired (wake only)"
                    : ""
            }${
                j.job.sidecarIndexStatus === "failed"
                    ? `, sidecar indexing failed (${j.job.sidecarIndexErrorCategory ?? "unknown"})`
                    : ""
            }`
    );
    const detailLines = batch.map((j) => `  Command: ${j.job.command}`);
    const outputEvidence = oneLine(
        batch
            .map((item) => {
                const evidence = completionEvidenceById.get(item.job.id);
                return evidence?.text ? `${item.job.id}: ${evidence.text}` : "";
            })
            .filter(Boolean)
            .join(" | "),
        280
    );

    const gpuLine = readGpuSnapshot();
    const resourceInfo = gpuLine ? `\nGPU: ${gpuLine}` : "";

    const sent = sendQueuedMessage(
        pi,
        {
            customType: "job-completion",
            content: `${header}\n${lines.join("\n")}${outputEvidence ? `\nOutput evidence: ${outputEvidence}` : ""}\n${detailLines.join("\n")}${resourceInfo}${staleSummary ? `\n${staleSummary}` : ""}`,
            display: true,
            details: {
                jobIds: batch.map(({ job }) => job.id),
                batch: batch.map((b) => ({
                    jobId: b.job.id,
                    sessionId: b.sessionId,
                    generation: b.generation,
                    jobGeneration: b.jobGeneration,
                    status: b.job.status,
                    exitCode: b.job.exitCode,
                    duration: b.duration,
                    ...(completionEvidenceById.get(b.job.id)?.counts
                        ? {
                              severityCounts: completionEvidenceById.get(
                                  b.job.id
                              )!.counts,
                          }
                        : {}),
                    command: b.job.command,
                    logPath: b.job.logPath,
                    sourceId: b.job.sourceId,
                    chunkIds: b.job.chunkIds,
                    sidecarIndexStatus: b.job.sidecarIndexStatus,
                    sidecarIndexReason: b.job.sidecarIndexReason,
                    sidecarIndexErrorCategory: b.job.sidecarIndexErrorCategory,
                })),
                outstandingJobs: outstandingCount,
                suppressedOlderCount: stale.length,
                olderFailures,
            },
        },
        {
            deliverAs: "followUp",
            triggerTurn: true,
            queueKey: delivery.queueKey,
        }
    );
    completeCompletionDeliveryHandoff(delivery, sent);
}

function flushPendingCompletionDeliveries(): void {
    if (completionAgentBusy || pendingCompletionDeliveries.length === 0) return;
    const pending = pendingCompletionDeliveries.splice(0);
    const groups: PendingCompletionDelivery[] = [];
    for (const delivery of pending) {
        let group = groups.find(
            (candidate) =>
                candidate.pi === delivery.pi &&
                candidate.state === delivery.state &&
                candidate.sessionId === delivery.sessionId
        );
        if (!group) {
            group = { ...delivery, jobs: [] };
            groups.push(group);
        }
        const known = new Set(group.jobs.map(completionAttemptIdentity));
        for (const item of delivery.jobs) {
            const identity = completionAttemptIdentity(item);
            if (!known.has(identity)) {
                group.jobs.push(item);
                known.add(identity);
            }
        }
    }
    for (const group of groups) {
        for (const item of group.jobs) {
            recordCompletionItemTelemetry(
                group.pi,
                "busy-queue-drained",
                item,
                {
                    batchSize: group.jobs.length,
                    delivery: "deferred-batch",
                }
            );
        }
        deliverCompletionNotification(group);
    }
}

function queueCompletionDelivery(
    jobs: CompletionBatchItem[],
    pi: ExtensionAPI,
    state: TauState
): void {
    const jobsToDeliver = jobs;

    // Cancel linked callbacks for all delivered jobs — we're about to
    // send the result to the agent, so remind callbacks are now stale. Guard
    // this internal cancellation: it must not retract the delivery itself.
    for (const { job } of jobsToDeliver) deliveringCompletionJobIds.add(job.id);
    try {
        for (const { job } of jobsToDeliver) cancelCallbacksForJob(job.id);
    } finally {
        for (const { job } of jobsToDeliver)
            deliveringCompletionJobIds.delete(job.id);
    }
    const wasBusy = completionAgentBusy;
    const sessionId = jobsToDeliver[0].sessionId;
    const delivery: PendingCompletionDelivery = {
        jobs: jobsToDeliver,
        pi,
        state,
        sessionId,
        queueKey: nextCompletionQueueKey(),
    };
    pendingCompletionDeliveries.push(delivery);
    if (wasBusy) {
        for (const item of jobsToDeliver) {
            recordCompletionItemTelemetry(pi, "busy-queue-inserted", item, {
                batchSize: jobsToDeliver.length,
                delivery: "deferred-batch",
            });
        }
    }
    flushPendingCompletionDeliveries();
}

/**
 * Remove a job's pending completion notification from the debounced batch.
 * Called when the agent cancels callbacks — no point sending stale
 * notifications for jobs the agent has already acknowledged.
 */
export function clearJobFromCompletionBatch(jobId: string): void {
    const acknowledgedAt = Date.now();
    const acknowledgedItems = [
        ...completionBatch.jobs,
        ...pendingCompletionDeliveries.flatMap((delivery) => delivery.jobs),
        ...Array.from(queuedCompletionDeliveries.values()).flatMap(
            (delivery) => delivery.jobs
        ),
    ].filter((item) => item.job.id === jobId);
    for (const item of acknowledgedItems) {
        if (item.job.outputConsumed) {
            acknowledgedCompletionAt.set(`job:${jobId}`, acknowledgedAt);
            acknowledgedCompletionAt.set(
                stableCompletionIdentity(
                    item.sessionId,
                    item.job.id,
                    item.jobGeneration
                ),
                acknowledgedAt
            );
        }
        const telemetryPi =
            Array.from(queuedCompletionDeliveries.values()).find((delivery) =>
                delivery.jobs.includes(item)
            )?.pi ??
            pendingCompletionDeliveries.find((delivery) =>
                delivery.jobs.includes(item)
            )?.pi ??
            completionBatch.pi;
        if (telemetryPi && item.job.outputConsumed) {
            recordCompletionItemTelemetry(
                telemetryPi,
                "acknowledged-consumed",
                item,
                { batchSize: 1, delivery: "suppressed" }
            );
        } else if (!telemetryPi) {
            completionTelemetryUnavailableCount++;
        }
    }
    for (const [queueKey, delivery] of possiblyDeliveredCompletionDeliveries) {
        if (!delivery.jobs.some(({ job }) => job.id === jobId)) continue;
        possiblyDeliveredCompletionDeliveries.delete(queueKey);
    }
    // Completion messages already handed to pi remain cancellable while queued.
    // A false result is the delivery boundary: do not re-emit siblings because
    // the original batch may already have reached the agent.
    for (const [queueKey, delivery] of queuedCompletionDeliveries) {
        if (!delivery.jobs.some((item) => item.job.id === jobId)) continue;
        const cancel = (
            delivery.pi as ExtensionAPI & {
                cancelQueuedMessage?: (key: string) => boolean;
            }
        ).cancelQueuedMessage;
        const cancelled = staleSafe(() => cancel?.(queueKey));
        queuedCompletionDeliveries.delete(queueKey);
        recordCompletionTelemetry(
            delivery.pi,
            cancelled === true ? "cancelled" : "cancel-miss",
            { queueKey, jobIds: [jobId] }
        );
        if (cancelled !== true) continue;

        for (const item of delivery.jobs) {
            const identity = completionAttemptIdentity(item);
            deliveredCompletionIdentities.delete(identity);
            item.job.completionDeliveredAt = undefined;
            recordCompletionItemTelemetry(
                delivery.pi,
                "delivery-cancelled",
                item,
                { batchSize: delivery.jobs.length, delivery: "suppressed" }
            );
            recordCompletionItemTelemetry(
                delivery.pi,
                "delivery-terminal",
                item,
                {
                    reason:
                        item.job.outputConsumed ||
                        isCompletionAcknowledged(item)
                            ? "suppressed-acknowledged"
                            : "cancelled",
                    status: item.job.status,
                    exitCode: item.job.exitCode,
                }
            );
        }
        delivery.jobs = delivery.jobs.filter((item) => item.job.id !== jobId);
        if (completionNeedsDelivery(delivery.jobs)) {
            recordCompletionTelemetry(delivery.pi, "rebuilt", {
                queueKey,
                jobIds: delivery.jobs.map(({ job }) => job.id),
            });
            queueCompletionDelivery(delivery.jobs, delivery.pi, delivery.state);
        } else {
            const wakeStates = new Set<TauState>();
            for (const { job } of delivery.jobs) {
                restoreCompletionForWake(job, wakeStates, delivery.state);
            }
            for (const wakeState of wakeStates) wakeState.wakeupEvaluate?.();
        }
    }

    // The indexing promise may not have queued the job yet. Invalidate that
    // callback and restore the terminal result unless delivery is already in
    // progress (where this cancellation is only clearing linked callbacks).
    const pendingJob = pendingCompletionJobs.get(jobId);
    const wakeState =
        completionBatch.state ??
        pendingCompletionDeliveries.find((delivery) =>
            delivery.jobs.some((item) => item.job.id === jobId)
        )?.state;
    let restored = false;
    if (pendingJob && !deliveringCompletionJobIds.has(jobId)) {
        pendingCompletionJobs.delete(jobId);
        completionNotifiedJobs.delete(pendingJob);
        pendingJob.completionNotified = false;
        completionJobGenerations.set(
            jobId,
            (completionJobGenerations.get(jobId) ?? 0) + 1
        );
        restored = true;
    }
    const idx = completionBatch.jobs.findIndex((j) => j.job.id === jobId);
    if (idx !== -1) {
        completionBatch.jobs.splice(idx, 1);
        if (
            completionBatch.jobs.length > 0 &&
            !completionNeedsDelivery(completionBatch.jobs)
        ) {
            const remaining = completionBatch.jobs.splice(0);
            const batchState = completionBatch.state;
            const wakeStates = new Set<TauState>();
            for (const { job: remainingJob } of remaining) {
                restoreCompletionForWake(remainingJob, wakeStates, batchState);
            }
            if (completionBatch.timer) {
                clearTimeout(completionBatch.timer);
                completionBatch.timer = undefined;
            }
            completionBatch.pi = undefined;
            completionBatch.state = undefined;
            if (batchState) batchState.wakeupEvaluate?.();
        } else if (completionBatch.jobs.length === 0) {
            if (completionBatch.timer) {
                clearTimeout(completionBatch.timer);
                completionBatch.timer = undefined;
            }
            completionBatch.pi = undefined;
            completionBatch.state = undefined;
        }
    }

    for (let i = pendingCompletionDeliveries.length - 1; i >= 0; i--) {
        const delivery = pendingCompletionDeliveries[i];
        delivery.jobs = delivery.jobs.filter((j) => j.job.id !== jobId);
        if (!completionNeedsDelivery(delivery.jobs)) {
            const wakeStates = new Set<TauState>();
            for (const { job: remainingJob } of delivery.jobs) {
                restoreCompletionForWake(
                    remainingJob,
                    wakeStates,
                    delivery.state
                );
            }
            pendingCompletionDeliveries.splice(i, 1);
            for (const state of wakeStates) state.wakeupEvaluate?.();
        }
    }
    if (restored) wakeState?.wakeupEvaluate?.();
}

/**
 * Clear all pending completion notifications from the debounced batch.
 * Called when the agent cancels all callbacks — no point sending stale
 * notifications for jobs the agent has already acknowledged.
 */
export function clearAllCompletionBatches(): void {
    completionBatchGeneration++;
    const wakeStates = new Set<TauState>();
    for (const [queueKey, delivery] of queuedCompletionDeliveries) {
        const cancel = (
            delivery.pi as ExtensionAPI & {
                cancelQueuedMessage?: (key: string) => boolean;
            }
        ).cancelQueuedMessage;
        const cancelled = staleSafe(() => cancel?.(queueKey));
        recordCompletionTelemetry(
            delivery.pi,
            cancelled === true ? "cancelled-all" : "cancel-miss-all",
            {
                queueKey,
                jobIds: delivery.jobs.map(({ job }) => job.id),
            }
        );
        if (cancelled === true) {
            for (const item of delivery.jobs) {
                deliveredCompletionIdentities.delete(
                    completionAttemptIdentity(item)
                );
                item.job.completionDeliveredAt = undefined;
                recordCompletionItemTelemetry(
                    delivery.pi,
                    "delivery-cancelled",
                    item,
                    { batchSize: delivery.jobs.length, delivery: "suppressed" }
                );
                recordCompletionItemTelemetry(
                    delivery.pi,
                    "delivery-terminal",
                    item,
                    {
                        reason:
                            item.job.outputConsumed ||
                            isCompletionAcknowledged(item)
                                ? "suppressed-acknowledged"
                                : "cancelled",
                        status: item.job.status,
                        exitCode: item.job.exitCode,
                    }
                );
                restoreCompletionForWake(item.job, wakeStates, delivery.state);
            }
        } else {
            possiblyDeliveredCompletionDeliveries.set(queueKey, delivery);
            recordCompletionTelemetry(delivery.pi, "cancel-miss-retained", {
                queueKey,
                jobIds: delivery.jobs.map(({ job }) => job.id),
            });
            for (const { job } of delivery.jobs) {
                restoreCompletionForWake(
                    job,
                    wakeStates,
                    delivery.state,
                    "cancel-miss-rearm"
                );
            }
        }
    }
    queuedCompletionDeliveries.clear();
    for (const [jobId, job] of pendingCompletionJobs) {
        if (deliveringCompletionJobIds.has(jobId)) continue;
        completionNotifiedJobs.delete(job);
        completionRearmTriggers.set(job, "flush-suppressed-rearm");
        job.completionNotified = false;
        completionJobGenerations.set(
            jobId,
            (completionJobGenerations.get(jobId) ?? 0) + 1
        );
        const wakeState =
            completionBatch.state ??
            pendingCompletionDeliveries.find((delivery) =>
                delivery.jobs.some((item) => item.job.id === jobId)
            )?.state;
        if (wakeState) wakeStates.add(wakeState);
    }
    pendingCompletionJobs.clear();
    for (const state of wakeStates) state?.wakeupEvaluate?.();
    if (completionBatch.timer) {
        clearTimeout(completionBatch.timer);
        completionBatch.timer = undefined;
    }
    completionBatch.jobs.length = 0;
    completionBatch.startTime = 0;
    completionBatch.pi = undefined;
    completionBatch.state = undefined;
    pendingCompletionDeliveries.length = 0;
    queuedCompletionDeliveries.clear();
}

/** Send a structured completion notification to the agent. */
export function notifyCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext,
    observedBy: CompletionTrigger = "other"
): void {
    // A terminal result supersedes any queued timeout/stall warning for the
    // same job. This is deterministic cancellation, not a time-based expiry.
    cancelQueuedBackgroundNotification(pi, job.id, "timeout");
    cancelQueuedBackgroundNotification(pi, job.id, "stall");

    // Record every observation, including one suppressed by the object-identity
    // guard. A re-arm cause takes precedence over the observer because it is the
    // information needed to explain a repeated notice.
    const sessionId = resolveCompletionSessionId(ctx, job, state);
    const stableGeneration = stableJobGeneration(job);
    const previousGeneration = completionJobGenerations.get(job.id) ?? 0;
    const notifyGeneration = previousGeneration + 1;
    const attemptIdentity = JSON.stringify([
        sessionId,
        job.id,
        stableGeneration,
        notifyGeneration,
    ]);
    const alreadyDelivered =
        job.completionDeliveredAt !== undefined ||
        deliveredCompletionIdentities.has(attemptIdentity);
    const suppressed = completionNotifiedJobs.has(job) || alreadyDelivered;
    const rearmTrigger = completionRearmTriggers.get(job);
    recordCompletionTelemetry(pi, "notify-called", {
        jobId: job.id,
        sessionId,
        generation: notifyGeneration,
        jobGeneration: stableGeneration,
        trigger: rearmTrigger ?? observedBy,
        ...(rearmTrigger ? { observedBy } : {}),
        outstandingJobs: countOutstandingJobs(state, job.id),
        delivery: suppressed ? "suppressed" : "deferred-batch",
    });
    if (alreadyDelivered) {
        recordCompletionTelemetry(pi, "duplicate-suppressed", {
            jobId: job.id,
            sessionId,
            jobGeneration: stableGeneration,
            status: job.status,
        });
    }
    if (suppressed) return;
    completionRearmTriggers.delete(job);
    completionNotifiedJobs.add(job);
    job.completionNotified = true;
    completionJobGenerations.set(job.id, notifyGeneration);
    job.completionNotificationGeneration = notifyGeneration;
    pendingCompletionJobs.set(job.id, job);

    // Linked callbacks (remindDelay) are NOT cancelled here — delivery
    // is deferred to flushCompletionBatch which decides whether to
    // suppress (no linked callbacks) or deliver (linked callbacks
    // present for any job in the batch).

    const duration = formatDuration(Date.now() - job.startTime);
    const notificationStartedAt = Date.now();
    const outstandingJobsAtCompletion = countOutstandingJobs(state, job.id);
    const emoji = job.status === "completed" ? "✅" : "❌";

    // Toast notification fires immediately for each job. The toast is the
    // only ctx access here; a stale ctx (session replaced while the job ran)
    // must not turn this completion path into an uncaughtException.
    staleSafe(() =>
        ctx.ui.notify(
            `${emoji} ${job.id} ${job.status} (${duration})`,
            job.status === "completed" ? "success" : "error"
        )
    );

    // Indexing is asynchronous. Queue the completion only after it settles so
    // sourceId/chunkIds are present in the notification. Cleanup remains
    // immediate, preserving the lifecycle contract for jobs/attach.
    recordCompletionTelemetry(pi, "output-index-started", {
        jobId: job.id,
        sessionId,
        generation: notifyGeneration,
        jobGeneration: stableGeneration,
        status: job.status,
        exitCode: job.exitCode,
    });
    const generation = completionBatchGeneration;
    const enqueue = (): void => {
        if (
            generation !== completionBatchGeneration ||
            completionJobGenerations.get(job.id) !== notifyGeneration
        ) {
            // Only clear the pending entry if this callback still owns the
            // current generation. A stale indexing callback must not delete a
            // newer re-notification for the same job.
            if (completionJobGenerations.get(job.id) === notifyGeneration) {
                pendingCompletionJobs.delete(job.id);
            }
            return;
        }
        if (job.sidecarIndexStatus === "failed") {
            staleSafe(() =>
                ctx.ui.notify(
                    `Sidecar indexing failed for ${job.id} (${job.sidecarIndexErrorCategory ?? "unknown"}); output remains at ${job.logPath}`,
                    "warning"
                )
            );
        }
        recordCompletionTelemetry(pi, "output-index-settled", {
            jobId: job.id,
            sessionId,
            generation: notifyGeneration,
            jobGeneration: stableGeneration,
            durationMs: Date.now() - notificationStartedAt,
            status: job.status,
            exitCode: job.exitCode,
        });
        completionBatch.jobs.push({
            job,
            duration,
            emoji,
            generation: notifyGeneration,
            jobGeneration: stableGeneration,
            sessionId,
            outstandingJobs: outstandingJobsAtCompletion,
        });
        completionBatch.pi = pi;
        completionBatch.state = state;

        // Sliding-window debounce: each new completion resets the timer,
        // extending the window to collect near-simultaneous completions.
        if (completionBatch.timer) clearTimeout(completionBatch.timer);
        else completionBatch.startTime = Date.now();
        const elapsed = Date.now() - completionBatch.startTime;
        const delay = Math.min(BATCH_DEBOUNCE_MS, BATCH_MAX_DELAY_MS - elapsed);
        completionBatch.timer = setTimeout(
            () => flushCompletionBatch(),
            Math.max(delay, 0)
        );
        completionBatch.timer.unref();
    };

    if (job.outputIndexPromise) {
        void job.outputIndexPromise.then(enqueue, enqueue);
    } else {
        enqueue();
    }

    // Remove from active state immediately; indexing and notification delivery
    // must not keep jobs/attach waiting for sidecar I/O.
    removeJob(state, job);
}

// ── Background a running foreground process (signal-based) ─────────

/**
 * Register a foreground process as a background job, start stall watchdog,
 * and set up completion handlers. Called when the background signal wins
 * the Promise.race (timeout or Ctrl+B).
 */
export function registerBackgroundJob(
    proc: import("node:child_process").ChildProcess,
    logPath: string,
    command: string,
    toolCallId: string,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext,
    options?: StallWatchdogOptions
): BackgroundJob {
    const jobId = generateJobId(++state.jobCounter);

    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: proc.pid!,
        startTime: Date.now(),
        status: "running",
        logPath,
        proc,
        toolCallId,
        isBackgrounded: true,
    };
    createJobDonePromise(job);

    // Update existing job registration from foreground to background
    const existingJob = state.backgroundJobs.get(jobId);
    if (existingJob) {
        existingJob.isBackgrounded = true;
    } else {
        state.backgroundJobs.set(jobId, job);
    }
    startJobLiveness(existingJob ?? job, pi);
    // Only release ownership this call actually holds: a concurrent tool call
    // may have overwritten the global owner, and clearing it would break
    // Ctrl+B targeting for the newer call.
    if (state.currentlyRunningToolCallId === toolCallId) {
        state.currentlyRunningToolCallId = null;
    }

    const cancelStall = startStallWatchdog(
        jobId,
        command,
        logPath,
        pi,
        state,
        () => {
            if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
            silenceJobAfterKill(job, "stall");
            cancelQueuedBackgroundNotifications(pi, job.id);
            state.wakeupEvaluate?.();
        },
        options
    );

    proc.on("close", (code) => {
        cancelStall();
        // markJobTerminal must run before anything reads final state: it sets
        // status/exitCode AND resolves job.donePromise. Setting job.status
        // manually first would make markJobTerminal early-return and the
        // donePromise would never resolve — `jobs attach` awaits it and would
        // hang forever on a completed job.
        markJobTerminal(
            job,
            code === 0 || code === null ? "completed" : "failed",
            code ?? 0
        );
        // Index after markJobTerminal so the sidecar captures final state.
        // UiContext now carries cwd/sessionManager (see types.ts) so it
        // satisfies SidecarContext directly.
        void trackJobOutputIndex(job, ctx);
        clearPendingDecision(state, job);
        notifyCompletion(job, state, pi, ctx);
        updateWidget(state, ctx);
    });

    ctx.ui.notify(
        `Process backgrounded as ${jobId}${formatBackgroundEvidence(job)}`,
        "info"
    );
    updateWidget(state, ctx);

    return job;
}

// ── Default timeout timer (signal-based) ─────────────────────────────

/** Return the job-control tools currently available to the agent. */
export function getActiveBackgroundControlTools(pi: ExtensionAPI): string[] {
    const getActive = (pi as ExtensionAPI & { getActiveTools?: () => string[] })
        .getActiveTools;
    if (typeof getActive !== "function") {
        // Older hosts/mocks may not expose active-tool introspection. Keep
        // the historical behavior there; current pi always provides it.
        return ["jobs", "job_decide"];
    }
    const tools = staleSafe(() => getActive());
    if (tools === "stale") {
        // Session replaced — there is no agent that could use the controls.
        return [];
    }
    return tools.filter((name) => name === "jobs" || name === "job_decide");
}

function notifyBackgroundUnavailable(
    pi: ExtensionAPI,
    command: string,
    timeoutMs: number
): void {
    staleSafe(() =>
        pi.sendMessage(
            {
                customType: "bg-unavailable",
                content:
                    `⏰ Command exceeded ${formatDuration(timeoutMs)} and was terminated ` +
                    `instead of backgrounded because no job-control tool is active.\n` +
                    `Command: ${command}\n\n` +
                    `Do not use shell kill/pkill cleanup. Enable the jobs or job_decide ` +
                    `tool, then rerun the command.`,
                display: true,
                details: { command, timeoutMs },
            },
            { deliverAs: "followUp", triggerTurn: true }
        )
    );
}

/**
 * Start a timer that resolves the background signal after timeoutMs.
 * If the command is not auto-backgroundable or no job-control tool is active,
 * kills the process instead. Returns the timer handle so it can be cleared on
 * early completion.
 */
export function startTimeoutTimer(
    triggerBackground: () => void,
    command: string,
    state: TauState,
    toolCallId: string,
    explicitTimeoutMs?: number,
    canBackground: () => boolean = () => true,
    onBackgroundUnavailable: () => void = () => {}
): NodeJS.Timeout {
    const timeoutMs = explicitTimeoutMs ?? resolveBackgroundAfterMs();

    const timer = setTimeout(() => {
        // Non-interactive (print/`-p`/non-TTY): there is no agent loop to answer
        // the auto-background job_decide prompt, so never auto-background or kill
        // on timeout — let the command run to completion.
        if (state.nonInteractive) return;

        // Guard: only act if this tool call still has a running process.
        // The global currentlyRunningToolCallId may have been overwritten by
        // a concurrent tool call — that doesn't mean *this* call finished.
        if (!state.runningProcesses.has(toolCallId)) return;

        // If auto-backgrounding is disallowed for this command, kill it
        if (!isAutoBackgroundAllowed(command)) {
            const rp = state.runningProcesses.get(toolCallId);
            if (rp?.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
            scheduleSigkillFallback(rp?.proc);
            return;
        }

        // Never create an unmanageable background job. A pending decision
        // gate blocks normal tools, so backgrounding without jobs/job_decide
        // would strand the agent and encourage unsafe shell cleanup attempts.
        if (!canBackground()) {
            const rp = state.runningProcesses.get(toolCallId);
            if (rp?.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
            scheduleSigkillFallback(rp?.proc);
            onBackgroundUnavailable();
            return;
        }

        triggerBackground();
    }, timeoutMs);
    timer.unref();
    return timer;
}

// ─── Feature registration ───────────────────────────────────────────

export function registerBackgroundJobs(
    pi: ExtensionAPI,
    state: TauState
): void {
    const eventPi = pi as ExtensionAPI & {
        on?: (event: string, handler: (...args: unknown[]) => unknown) => void;
    };
    eventPi.on?.("agent_start", () => {
        completionLifecycleToken++;
        completionAgentBusy = true;
        if (settledCompletionFlushTimer) {
            clearTimeout(settledCompletionFlushTimer);
            settledCompletionFlushTimer = undefined;
        }
    });
    eventPi.on?.("agent_settled", () => {
        const token = completionLifecycleToken;
        if (settledCompletionFlushTimer) return;
        // agent_settled handlers run before the core finishes returning from
        // the turn. Defer delivery until the handler stack has unwound so a
        // triggerTurn message cannot re-enter the settling agent.
        settledCompletionFlushTimer = setTimeout(() => {
            settledCompletionFlushTimer = undefined;
            if (token !== completionLifecycleToken) return;
            completionAgentBusy = false;
            flushPendingCompletionDeliveries();
        }, 0);
    });
    eventPi.on?.("session_shutdown", () => {
        completionLifecycleToken++;
        completionAgentBusy = false;
        if (settledCompletionFlushTimer) {
            clearTimeout(settledCompletionFlushTimer);
            settledCompletionFlushTimer = undefined;
        }
        pendingCompletionDeliveries.length = 0;
        clearAllCompletionBatches();
        stopAllJobLiveness();
    });

    // ── Override bash tool ─────────────────────────────────────────────

    const originalBashTool = createBashTool(process.cwd());

    pi.registerTool({
        ...originalBashTool,
        name: "bash",
        description:
            "Execute bash commands with streaming output. Commands that run longer than the auto-background delay " +
            "(15 seconds by default, PI_TAU_BACKGROUND_AFTER_MS to override, backgroundAfter per call) " +
            "are automatically backgrounded and the agent is asked whether to kill or let them continue. " +
            "For waits of about 2 seconds or more, avoid a bare leading sleep (it is blocked): use bash_bg " +
            "for deliberate backgrounding, optionally with timeout (wakes you to inspect/decide; never kills) " +
            "and/or remindDelay (auto-cancels when the job completes), or poll with a loop that sleeps under 2 " +
            "seconds and checks output/state each iteration. " +
            "Use Ctrl+Shift+B to manually background a running process. " +
            "Background job output is written to per-session log files. " +
            "Set backgroundAfter to auto-background after a specific number of seconds.",
        promptSnippet:
            "Execute shell commands (backgroundable with Ctrl+Shift+B)",
        promptGuidelines: [
            "Use bash_bg when you know a command should run in background from the start.",
            "Use the jobs tool with action 'list' to check background job status.",
            "Use the jobs tool with action 'output' to read a background job's output file.",
            "Use backgroundAfter to set a custom background-after timeout in seconds.",
            "Pass cwd when working in a directory other than the session root (e.g. a git worktree) " +
                "so the command and the UI location indicator match.",
        ],
        parameters: Type.Object({
            command: Type.String({
                description: "Bash command to execute",
            }),
            backgroundAfter: Type.Optional(
                Type.Number({
                    description:
                        "Background the command after this many seconds (default: auto, ~15 seconds or PI_TAU_BACKGROUND_AFTER_MS). " +
                        "The command continues running in the background; use jobs/attach to monitor it.",
                })
            ),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "Working directory to run the command in (e.g. a git worktree). Defaults to the " +
                        "session working directory.",
                })
            ),
        }),

        async execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx
        ): Promise<AgentToolResult<BashToolDetails | undefined>> {
            const { command, cwd } = params;
            const execCwd = resolveExecutionCwd(cwd, ctx.cwd);
            validateWorkingDirectory(execCwd);

            // Validate: block sleep >= 2s
            const sleepMatch = detectBlockedSleep(command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash_bg for long waits. ` +
                        "For pacing < 2s, sleep is fine."
                );
            }

            // ── Tmux path ─────────────────────────────────────────────
            if (state.tmuxAvailable) {
                try {
                    return await executeTmuxForeground(
                        toolCallId,
                        command,
                        params,
                        signal,
                        onUpdate,
                        ctx,
                        state,
                        pi
                    );
                } catch (error) {
                    // Only spawn/setup failures should fall through to the
                    // direct-spawn path. All other outcomes are terminal: a
                    // PossiblyStuckError is the intentional tool result from
                    // a running tmux command, and a killed/aborted/non-zero-
                    // exit error means the command already ran in tmux —
                    // re-running it on the direct path would execute side
                    // effects twice and mask the real result.
                    if (!(error instanceof TmuxSpawnError)) throw error;
                    // TmuxSpawnError (no git root, tmux server error):
                    // fall through to direct spawn.
                }
            }

            // ── Direct spawn path (fallback when tmux unavailable) ───
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);
            mkdirSync(dirname(logPath), { recursive: true });

            const logFd = openSync(logPath, "w");
            let proc: ChildProcess;
            try {
                proc = spawnBashProcess(command, execCwd, {
                    stdio: ["pipe", logFd, logFd],
                    detached: true,
                });
            } finally {
                closeSync(logFd);
            }

            if (!proc.pid) {
                throw new Error("Failed to spawn process");
            }

            // Background signal — resolved by timeout timer or Ctrl+B
            let backgroundResolve: (() => void) | null = null;
            const backgroundSignal = new Promise<void>((resolve) => {
                backgroundResolve = resolve;
            });

            function triggerBackground(): void {
                backgroundResolve?.();
            }

            // Register as a foreground RunningProcess so Ctrl+B can find it
            const rp: RunningProcess = {
                toolCallId,
                proc,
                command,
                logPath,
                triggerBackground,
            };
            state.runningProcesses.set(toolCallId, rp);
            state.currentlyRunningToolCallId = toolCallId;

            // Register as foreground job in backgroundJobs
            state.backgroundJobs.set(jobId, {
                id: jobId,
                command,
                pid: proc.pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc,
                toolCallId,
                isBackgrounded: false,
            });

            // Build process result promise
            const procResult = new Promise<{
                code: number | null;
                interrupted: boolean;
            }>((resolve) => {
                proc.on("close", (code) => {
                    resolve({
                        code,
                        interrupted: code === 137 || code === 143,
                    });
                });
                proc.on("error", () => {
                    resolve({ code: 1, interrupted: false });
                });
            });

            // Abort handler. Detached below once the command becomes a
            // background job: an abort belongs to the tool call waiting on the
            // foreground command, not to the job it turned into. Leaving it
            // attached let a later turn's abort SIGTERM a healthy detached job.
            const onAbort = (): void => {
                killProcessGroup(proc.pid!, "SIGTERM");
            };
            if (signal) signal.addEventListener("abort", onAbort);

            // Explicit per-call delay (sanitized: NaN/negative fall back to
            // the configured default); hoisted so the stall watchdog below
            // can stay behind it.
            const explicitTimeoutMs = resolveExplicitBackgroundAfterMs(
                params.backgroundAfter
            );
            const foregroundTimeoutMs =
                explicitTimeoutMs ?? resolveBackgroundAfterMs();

            // Start timeout timer (background-after timer, not a kill timeout)
            const timer = startTimeoutTimer(
                triggerBackground,
                command,
                state,
                toolCallId,
                explicitTimeoutMs,
                () => getActiveBackgroundControlTools(pi).length > 0,
                () =>
                    notifyBackgroundUnavailable(
                        pi,
                        command,
                        foregroundTimeoutMs
                    )
            );

            // Background hint
            const hintTimer = setTimeout(() => {
                ctx.ui.notify("⏱ Ctrl+Alt+B to background", "info");
            }, 2_000);
            hintTimer.unref();

            // File-polling for foreground progress
            const PROGRESS_POLL_MS = 1_000;
            let pollTimer: NodeJS.Timeout | undefined;
            let cancelNoOutputWatchdog: (() => void) | undefined;
            let noOutputResolve: (() => void) | null = null;
            const noOutputSignal = new Promise<void>((resolve) => {
                noOutputResolve = resolve;
            });
            const startPolling = (): void => {
                pollTimer = setInterval(() => {
                    try {
                        const content = readOutputTailSync(logPath, 4_096);
                        if (content && content !== "(no output yet)") {
                            onUpdate?.({
                                content: [
                                    { type: "text" as const, text: content },
                                ],
                                details: undefined,
                            });
                        }
                    } catch {
                        // File may not be readable yet
                    }
                }, PROGRESS_POLL_MS);
                pollTimer.unref();
            };

            try {
                // Wait for initial output or quick completion (2s threshold)
                const initialResult = await Promise.race([
                    procResult,
                    new Promise<null>((resolve) => {
                        const t = setTimeout(() => resolve(null), 2_000);
                        t.unref();
                    }),
                ]);

                // Command completed quickly — return result
                if (initialResult !== null) {
                    // Clean up foreground job registration
                    state.backgroundJobs.delete(jobId);
                    state.runningProcesses.delete(toolCallId);
                    if (state.currentlyRunningToolCallId === toolCallId) {
                        state.currentlyRunningToolCallId = null;
                    }
                    const output = await readFile(logPath, "utf-8").catch(
                        () => ""
                    );
                    const forcedIndex = state.pipeHoistedCalls.has(toolCallId);
                    const stageZero = state.pipeStageZeroCalls.get(toolCallId);
                    const prepared = await prepareInlineOutput(
                        {
                            id: jobId,
                            command,
                            logPath,
                            exitCode: initialResult.code ?? undefined,
                            status:
                                initialResult.code === 0
                                    ? "completed"
                                    : "failed",
                        },
                        ctx,
                        output,
                        "bash",
                        // A hoisted pipe means the agent is shown a bounded
                        // view of this output, so the rest exists only here.
                        // Index it even when it is under the inline threshold.
                        { force: forcedIndex }
                    );
                    // The index decision has been made; do not let the flag
                    // survive to affect a later call.
                    state.pipeHoistedCalls.delete(toolCallId);
                    let stageZeroSourceId: string | null = null;
                    if (stageZero) {
                        state.pipeStageZeroCalls.delete(toolCallId);
                        stageZeroSourceId = await indexStageZeroCapture(
                            stageZero,
                            command,
                            toolCallId,
                            ctx,
                            initialResult.code ?? undefined,
                            initialResult.code === 0 ? "completed" : "failed"
                        );
                    }
                    return {
                        content: [
                            { type: "text" as const, text: prepared.text },
                        ],
                        // A hoisted pipe means the agent is viewing a bounded
                        // slice, so the capture has to be reachable even when
                        // nothing was truncated or indexed.
                        details: {
                            ...preparedOutputDetails(
                                prepared,
                                logPath,
                                forcedIndex
                            ),
                            ...(stageZero
                                ? {
                                      pipeStageZero: {
                                          path: stageZero.path,
                                          command: stageZero.command,
                                          sourceId: stageZeroSourceId,
                                      },
                                  }
                                : {}),
                        },
                    };
                }

                // Command still running — start polling for progress
                startPolling();

                // Stall wake (both modes): a foreground command that outlives
                // its timeout handling must wake the supervising agent at most
                // every PI_TAU_STALL_WAKE_MS (default 4 min) so outstanding
                // jobs and subagent completions get checked. Non-interactive
                // always arms it (auto-background no-ops there); interactive
                // arms it as a safety net behind the background/kill timer
                // (covers SIGTERM-ignoring processes and kill failures).
                // The safety net must stay *behind* an explicit long delay:
                // with backgroundAfter=3600 on a silent command, a fixed 4
                // min watchdog would kill what the user asked to keep.
                const stallWakeMs = state.nonInteractive
                    ? resolveNonInteractiveStallWakeMs()
                    : Math.max(
                          resolveNonInteractiveStallWakeMs(),
                          foregroundTimeoutMs +
                              resolveInteractiveStallWakeMarginMs()
                      );
                cancelNoOutputWatchdog = startNoOutputWatchdog(
                    logPath,
                    stallWakeMs,
                    () => noOutputResolve?.()
                );

                // Race: completion vs background signal
                const raceResult = await Promise.race([
                    procResult.then((r) => ({
                        type: "completed" as const,
                        ...r,
                    })),
                    backgroundSignal.then(() => ({
                        type: "backgrounded" as const,
                    })),
                    noOutputSignal.then(() => ({
                        type: "stalled" as const,
                    })),
                ]);

                // Interactive sessions keep kill semantics: the auto-background
                // timer normally wins long before this safety net, so a stall
                // here means a SIGTERM-ignoring or unmanageable process. In
                // non-interactive sessions the command is instead detached to
                // the background (it keeps running) so the agent is woken to
                // check on it without destroying in-flight work.
                if (raceResult.type === "stalled" && !state.nonInteractive) {
                    clearInterval(pollTimer);
                    clearTimeout(timer);
                    clearTimeout(hintTimer);
                    cancelNoOutputWatchdog?.();
                    state.runningProcesses.delete(toolCallId);
                    if (state.currentlyRunningToolCallId === toolCallId) {
                        state.currentlyRunningToolCallId = null;
                    }
                    // Remove foreground job registration
                    state.backgroundJobs.delete(jobId);
                    killProcessGroup(proc.pid, "SIGTERM");
                    // SIGKILL fallback: a SIGTERM-ignoring process must not
                    // outlive the wake and re-stall the session.
                    scheduleSigkillFallback(proc);
                    const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
                    throw new PossiblyStuckError(
                        `Possibly stuck: no output for ${formatDuration(stallWakeMs)}. ` +
                            `Killed the command so the session can continue.\n` +
                            `Command: ${command}\n` +
                            `Output (${logPath}):\n${tail}\n` +
                            `If this command is expected to stay silent longer, set PI_TAU_STALL_WAKE_MS (ms) higher and re-run, or use bash_bg for a long-running command.`
                    );
                }

                if (
                    raceResult.type === "backgrounded" ||
                    raceResult.type === "stalled"
                ) {
                    // Clean up foreground state
                    clearInterval(pollTimer);
                    clearTimeout(timer);
                    clearTimeout(hintTimer);
                    state.runningProcesses.delete(toolCallId);

                    // Register as background job with completion handlers
                    const job = registerBackgroundJob(
                        proc,
                        logPath,
                        command,
                        toolCallId,
                        state,
                        pi,
                        ctx,
                        {
                            // A stall detach already told the agent the job is
                            // silent; only re-announce silence after it has
                            // produced output and gone quiet again.
                            silenceNoticeOnlyAfterGrowth:
                                raceResult.type === "stalled",
                        }
                    );

                    // Remove stale foreground entry created earlier — same process,
                    // separate job ID that would otherwise stay in state forever.
                    state.backgroundJobs.delete(jobId);

                    // Non-interactive sessions have no UI to answer the
                    // job_decide gate, so never arm it there: it would block
                    // every subsequent tool call.
                    if (!state.nonInteractive) {
                        state.pendingDecisionJobId = job.id;
                    }

                    const silenceNotice =
                        raceResult.type === "stalled"
                            ? `No output for ${formatDuration(stallWakeMs)}; detached the still-running command to the background instead of killing it.\n`
                            : "";

                    // The tool result below is the authoritative backgrounding
                    // notice. Do not enqueue a second model turn with the same
                    // facts; the UI already received the backgrounded toast.
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    silenceNotice +
                                    `Process backgrounded as ${job.id}${formatBackgroundEvidence(job)}\nCommand: ${command}\nPID: ${job.pid}\nOutput: ${job.logPath}\n\n${backgroundCompletionNotice("failure-only")}`,
                            },
                        ],
                        details: undefined,
                    };
                }

                // Command completed normally
                clearInterval(pollTimer);
                clearTimeout(timer);
                clearTimeout(hintTimer);
                state.runningProcesses.delete(toolCallId);
                if (state.currentlyRunningToolCallId === toolCallId) {
                    state.currentlyRunningToolCallId = null;
                }
                // Remove foreground job registration
                state.backgroundJobs.delete(jobId);

                const output = await readFile(logPath, "utf-8").catch(() => "");
                const stageZero = state.pipeStageZeroCalls.get(toolCallId);
                const prepared = await prepareInlineOutput(
                    {
                        id: jobId,
                        command,
                        logPath,
                        exitCode: raceResult.code ?? undefined,
                        status: raceResult.code === 0 ? "completed" : "failed",
                    },
                    ctx,
                    output,
                    "bash",
                    { force: state.pipeHoistedCalls.has(toolCallId) }
                );
                // Stage 0 is indexed even when the command FAILED: a failed
                // build's pre-filter output is still what a re-run would want,
                // and this is its only copy. Cleared on every path so a later
                // call cannot index a stale file.
                let stageZeroSourceId: string | null = null;
                if (stageZero) {
                    state.pipeStageZeroCalls.delete(toolCallId);
                    stageZeroSourceId = await indexStageZeroCapture(
                        stageZero,
                        command,
                        toolCallId,
                        ctx,
                        raceResult.code ?? undefined,
                        raceResult.code === 0 ? "completed" : "failed"
                    );
                }

                const details = {
                    ...preparedOutputDetails(
                        prepared,
                        logPath,
                        state.pipeHoistedCalls.has(toolCallId)
                    ),
                    ...(stageZero
                        ? {
                              pipeStageZero: {
                                  path: stageZero.path,
                                  command: stageZero.command,
                                  sourceId: stageZeroSourceId,
                              },
                          }
                        : {}),
                };

                if (
                    raceResult.code !== 0 &&
                    raceResult.code !== null &&
                    !raceResult.interrupted
                ) {
                    throw new Error(
                        prepared.text ||
                            `Command exited with code ${raceResult.code}`
                    );
                }

                return {
                    content: [{ type: "text" as const, text: prepared.text }],
                    details,
                };
            } finally {
                clearInterval(pollTimer);
                clearTimeout(timer);
                clearTimeout(hintTimer);
                cancelNoOutputWatchdog?.();
                signal?.removeEventListener("abort", onAbort);
            }
        },
    });

    // ── bash_bg tool ────────────────────────────────────────────────────

    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Run a bash command in background immediately. Output streams to a log file in real-time " +
            "and can be queried with the jobs tool (output, grep, head/tail) while the job is still running. " +
            "Use the jobs tool to check status and read output. " +
            "Completed output is automatically indexed in the context sidecar SQLite database when available " +
            "and is searchable via context_search, context_list, and context_get. " +
            "Optionally set a decision deadline (timeout; wakes you to check progress and decide, never kills automatically), schedule an inline reminder (remindDelay), or both.",
        promptSnippet:
            "Run bash command in background immediately" +
            " (supports a decision deadline that wakes you, not a kill, and an inline reminder)",
        promptGuidelines: [
            "Use bash_bg when you want to start a long-running command in background immediately.",
            "This is different from regular bash + Ctrl+Shift+B — bash_bg backgrounds from the start.",
            "Use timeout to set a decision deadline: when it fires you are woken to check progress and decide (extend, jobs kill, ignore). The job is not terminated automatically.",
            "Use remindDelay to schedule a reminder callback (auto-cancels if the job finishes first).",
            "Output accumulates in the log file while the job runs. Use jobs output to read it at any time.",
            "The result details include jobId, status, line metadata, and logPath; terminal output may also include sidecar sourceId/chunkIds.",
            "Completed output is automatically indexed in the context sidecar when available. " +
                "Use context_search with tool_name='bash_bg' to find past job output, " +
                "or context_list with tool_name='bash_bg' to see recent indexed job runs.",
            "Pass cwd when working in a directory other than the session root (e.g. a git worktree) " +
                "so the command and the UI location indicator match.",
        ],
        parameters: Type.Object({
            command: Type.String({
                description: "Command to run in background",
            }),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "Working directory to run the command in (e.g. a git worktree). Defaults to the " +
                        "session working directory.",
                })
            ),
            notify: Type.Optional(
                Type.Boolean({
                    description: "Notify when complete (default: true)",
                })
            ),
            timeout: Type.Optional(
                Type.Number({
                    description:
                        "Deadline in seconds. When the job runs longer than this you are woken to inspect progress and decide: " +
                        "extend it, terminate it with jobs kill, or ignore. The job is NOT killed automatically.",
                })
            ),
            remindDelay: Type.Optional(
                Type.String({
                    description:
                        'Schedule a reminder callback after this duration (e.g. "5m", "30s", "2h"). ' +
                        "The reminder auto-cancels if the job completes before it fires.",
                })
            ),
            remindMessage: Type.Optional(
                Type.String({
                    description:
                        'Message for the reminder callback (default: "check on <command>"). ' +
                        "Only used when remindDelay is set.",
                })
            ),
        }),

        async execute(
            toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<JobResultDetails | undefined>> {
            const shouldNotify = params.notify !== false;
            // Admission before spawn: an invalid timeout/remindDelay must
            // fail the tool call without creating any job or payload.
            validateRequestedPolicies(params);
            const execCwd = resolveExecutionCwd(params.cwd, ctx.cwd);
            validateWorkingDirectory(execCwd);

            // ── Tmux path ─────────────────────────────────────────────
            if (state.tmuxAvailable) {
                let cancelDeadlineWake: (() => void) | undefined;
                const job = spawnBackgroundTmux(
                    params.command,
                    execCwd,
                    toolCallId,
                    state,
                    pi,
                    ctx,
                    (jobId, command, logPath) =>
                        startStallWatchdog(
                            jobId,
                            command,
                            logPath,
                            pi,
                            state,
                            () => {
                                const oversizeJob =
                                    state.backgroundJobs.get(jobId) ??
                                    ({
                                        id: jobId,
                                        command,
                                        pid: -1,
                                        startTime: Date.now(),
                                        status: "running",
                                        logPath,
                                        toolCallId,
                                        isBackgrounded: true,
                                    } satisfies BackgroundJob);
                                requestJobTermination(oversizeJob, "stall");
                                killTmuxJob(oversizeJob);
                            }
                        ),
                    // Finalize through the shared completion machinery
                    // (notifyCompletion + tmux window cleanup).
                    (job) => {
                        cancelDeadlineWake?.();
                        cancelDeadlineWake = undefined;
                        handleTmuxCompletion(job, state, pi, ctx, shouldNotify);
                    },
                    // Refresh once finalized, and tick elapsed-duration pills
                    // from this existing completion poll while the job runs.
                    () => updateWidget(state, ctx),
                    createRunningJobsWidgetRefresh(state, ctx)
                );

                startJobLiveness(job, pi);
                updateWidget(state, ctx);

                // Requested policies are armed identically on both backends
                // (notification parity): the deadline wakes the agent to
                // decide, it never terminates the job; the reminder is the
                // linked nonterminating callback.
                let deadlineWarning = "";
                if (typeof params.timeout === "number" && params.timeout > 0) {
                    cancelDeadlineWake = armDeadlineWake(
                        job,
                        pi,
                        params.timeout
                    );
                }
                let reminder:
                    | { reminderId?: string; armed: boolean }
                    | undefined;
                if (params.remindDelay !== undefined) {
                    reminder = armJobReminder(
                        job,
                        params.remindDelay,
                        params.remindMessage
                    );
                    if (!reminder.armed) {
                        deadlineWarning =
                            "\nWarning: reminder could not be armed";
                    }
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Started background job ${job.id}${formatBackgroundEvidence(job)}\nCommand: ${params.command}\nOutput: ${job.logPath}${formatArmedPolicies(params, reminder)}${deadlineWarning}\n\n${backgroundCompletionNotice(shouldNotify ? "guaranteed" : "none")}`,
                        },
                    ],
                    details: jobDetails(job),
                };
            }

            // ── Direct spawn path (fallback) ──────────────────────────
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);

            const logFd = openSync(logPath, "w");
            let proc: ChildProcess;
            try {
                proc = spawnBashProcess(params.command, execCwd, {
                    stdio: ["pipe", logFd, logFd],
                    detached: true,
                });
            } finally {
                closeSync(logFd);
            }

            if (!proc.pid) {
                throw new Error("Failed to spawn background process");
            }

            const job: BackgroundJob = {
                id: jobId,
                command: params.command,
                pid: proc.pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc,
                toolCallId,
                isBackgrounded: true,
                // bash_bg defaults to notifying on completion. This flag
                // makes that explicit request survive successful-completion
                // suppression in flushCompletionBatch.
                wantsCompletionNotification: shouldNotify,
            };
            createJobDonePromise(job);
            state.backgroundJobs.set(jobId, job);
            startJobLiveness(job, pi);

            const cancelStall = startStallWatchdog(
                jobId,
                params.command,
                logPath,
                pi,
                state,
                () => {
                    if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                    silenceJobAfterKill(job, "stall");
                    cancelQueuedBackgroundNotifications(pi, job.id);
                    state.wakeupEvaluate?.();
                }
            );

            // ── Decision-deadline wake (decision point, never a kill) ─────────────────────────────
            let cancelDeadlineWake: (() => void) | undefined;
            if (typeof params.timeout === "number" && params.timeout > 0) {
                cancelDeadlineWake = armDeadlineWake(job, pi, params.timeout);
            }

            // ── Inline reminder ───────────────────────────────────────
            let reminder: { reminderId?: string; armed: boolean } | undefined;
            if (params.remindDelay !== undefined) {
                reminder = armJobReminder(
                    job,
                    params.remindDelay,
                    params.remindMessage
                );
            }

            proc.on("close", (code) => {
                cancelStall();
                cancelDeadlineWake?.();
                cancelDeadlineWake = undefined;
                // Terminal status comes only from the observed exit. A prior
                // termination request plus a signal death (null code, or the
                // shell's 128+n encodings for SIGTERM/SIGKILL) is an observed
                // kill; any other exit — including a clean exit after a
                // termination request — is completed/failed, with the request
                // still visible in details. A deadline wake is not recorded
                // here at all: it never contributed to the outcome.
                const signalDeath =
                    code === null || code === 137 || code === 143;
                const terminationWasRequested =
                    job.terminationRequestedAt !== undefined;
                markJobTerminal(
                    job,
                    terminationWasRequested && signalDeath
                        ? "killed"
                        : code === 0 || code === null
                          ? "completed"
                          : "failed",
                    code ?? 0
                );
                void trackJobOutputIndex(job, ctx);
                clearPendingDecision(state, job);
                if (shouldNotify)
                    notifyCompletion(
                        job,
                        state,
                        pi,
                        ctx,
                        terminationWasRequested && signalDeath
                            ? "kill"
                            : job.deadlineFiredAt !== undefined
                              ? "deadline"
                              : "other"
                    );
                else {
                    job.suppressAutonomousWake = true;
                    removeJob(state, job);
                }
                updateWidget(state, ctx);
            });

            proc.on("error", () => {
                cancelStall();
                cancelDeadlineWake?.();
                cancelDeadlineWake = undefined;
                markJobTerminal(job, "failed");
                void trackJobOutputIndex(job, ctx);
                clearPendingDecision(state, job);
                if (shouldNotify)
                    notifyCompletion(
                        job,
                        state,
                        pi,
                        ctx,
                        job.deadlineFiredAt !== undefined ? "deadline" : "other"
                    );
                else {
                    job.suppressAutonomousWake = true;
                    removeJob(state, job);
                }
                updateWidget(state, ctx);
            });

            updateWidget(state, ctx);

            // Build summary line for the armed policies (wake + reminder).
            const extra = formatArmedPolicies(params, reminder);

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Started background job ${jobId}${formatBackgroundEvidence(job)}\n` +
                            `Command: ${params.command}\n` +
                            `PID: ${proc.pid}\n` +
                            `Output: ${logPath}${extra}\n\n${backgroundCompletionNotice(shouldNotify ? "guaranteed" : "none")}`,
                    },
                ],
                details: jobDetails(job),
            };
        },
    });

    // ── jobs tool ───────────────────────────────────────────────────────

    pi.registerTool({
        name: "jobs",
        label: "Background Jobs",
        description:
            "List, inspect, kill, or attach to background jobs. Output is read from disk files. " +
            "Jobs(attach) is non-blocking — it polls the job periodically and streams progress " +
            "updates to the agent. The agent can abort at any time, and a configurable timeout " +
            "(default 10 min) prevents indefinite blocking. " +
            "Output accumulates in the log file in real-time — you can query it while the job is running. " +
            "For completed jobs not found in memory, output(action) falls back to the context sidecar. " +
            "Use output(action) with grep/tail/head to search and filter accumulated output.",
        promptSnippet: "Manage background jobs (list/output/kill/attach)",
        promptGuidelines: [
            "Use jobs with action 'list' to see all background jobs.",
            "Use jobs with action 'output' to read a job's accumulated output (works while running).",
            "Use jobs with action 'output' grep='pattern' to search for matching lines in the output.",
            "Use jobs with action 'output' head=50 to show the first 50 lines (default: tail=10).",
            "Use jobs with action 'output' tail=15 to show the last 15 matching lines, the default.",
            "Output results include structured line/empty/error/truncation metadata; use the returned sourceId or chunkIds with context_get for full indexed output.",
            "Use jobs with action 'kill' to terminate a running background job (also cancels linked reminders).",
            "Use jobs with action 'attach' to monitor a running job with progress polling; " +
                "attach is safe to use — it will not block indefinitely (has a timeout).",
            "Use the optional 'timeout' parameter (seconds) to control how long to wait; " +
                "default is 600 (10 minutes).",
            "When jobs(output) hides lines or truncates, it will suggest grep='pattern' automatically — " +
                "prefer grep over bash for searching large output.",
            "For searching across past or indexed job output, use context_search with tool_name='bash_bg'.",
        ],
        parameters: Type.Object({
            action: StringEnum(["list", "output", "kill", "attach"] as const, {
                description: "Action to perform",
            }),
            jobId: Type.Optional(
                Type.String({
                    description: "Job ID for output/kill/attach",
                })
            ),
            grep: Type.Optional(
                Type.String({
                    description:
                        "JavaScript regex pattern for action=output (case-insensitive). " +
                        "Only lines matching the pattern are returned, with line numbers. " +
                        "Examples: 'error|fail', '^\\d+', 'timeout.*exit'.",
                })
            ),
            head: Type.Optional(
                Type.Number({
                    description:
                        "Show at most this many matching lines (from the start). " +
                        "Applied after grep filter.",
                    minimum: 1,
                })
            ),
            tail: Type.Optional(
                Type.Number({
                    description:
                        "Show at most this many matching lines (from the end). " +
                        "Default: 10 if neither head nor tail is given. " +
                        "Applied after grep filter.",
                    minimum: 1,
                })
            ),
            wait: Type.Optional(
                Type.Boolean({
                    description:
                        "For attach: wait for completion (default true)",
                })
            ),
            timeout: Type.Optional(
                Type.Number({
                    description:
                        "For attach: max seconds to wait before returning partial output " +
                        "(default 600 = 10 minutes)",
                })
            ),
        }),

        async execute(
            _toolCallId,
            params,
            signal,
            onUpdate,
            ctx
        ): Promise<AgentToolResult<JobResultDetails | undefined>> {
            switch (params.action) {
                case "list": {
                    const running = Array.from(state.backgroundJobs.values());
                    const recent = state.recentTerminalJobs.slice(-5).reverse();
                    const lines = [
                        ...running.map((j) => formatJobLine(j)),
                        ...recent.map((j) => formatJobLine(j)),
                    ];
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    lines.length > 0
                                        ? `Background Jobs:\n${lines.join("\n")}`
                                        : "No background jobs",
                            },
                        ],
                        details: undefined,
                    };
                }

                case "output": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=output");

                    const grepPattern = params.grep;
                    const headCount = params.head;
                    const tailCount = params.tail;

                    // Try the in-memory job first
                    const job = lookupJob(state, params.jobId);
                    if (job) {
                        const output = await readOutputTail(
                            job.logPath,
                            MAX_OUTPUT_PREVIEW_CHARS
                        );
                        // Agent has seen this terminal job's output —
                        // suppress completion notification and cancel reminds.
                        if (job.status !== "running") {
                            job.outputConsumed = true;
                            state.cancelCompletionBatchForJob?.(job.id);
                            cancelCallbacksForJob(job.id);
                            cancelQueuedBackgroundNotifications(pi, job.id);
                            state.wakeupEvaluate?.();
                        }
                        const formatted = formatJobOutput({
                            text: output,
                            grepPattern,
                            headCount,
                            tailCount,
                        });
                        const source = await sourceDetailsForJob(job);
                        const metadata: OutputMetadata = {
                            totalLines: formatted.totalLines,
                            truncated: formatted.truncated,
                            partial: formatted.partial,
                            ...(formatted.omittedLines !== undefined
                                ? { omittedLines: formatted.omittedLines }
                                : {}),
                            byteCount: formatted.byteCount,
                            empty: formatted.empty,
                            error:
                                formatted.error ||
                                outputReadFailed(job, output),
                            ...logEvidenceMetadata(
                                job,
                                job.status !== "running",
                                `${job.id}:jobs-output`
                            ),
                        };
                        const severityNote = metadata.severityCounts
                            ? `\nLog severity: ${formatLogCounts(metadata.severityCounts)}; ` +
                              `since prior read +${metadata.severityDelta?.total ?? 0} lines ` +
                              `(+${metadata.severityDelta?.err ?? 0} err, +${metadata.severityDelta?.warn ?? 0} warn)` +
                              (metadata.severityScanTruncated
                                  ? "; scan capped at 512KB"
                                  : "")
                            : "";
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Output for ${job.id} (${job.status})${
                                        grepPattern
                                            ? `, grep "${grepPattern}"`
                                            : ""
                                    }${
                                        headCount !== undefined
                                            ? `, head=${headCount}`
                                            : ""
                                    }${
                                        tailCount !== undefined
                                            ? `, tail=${tailCount}`
                                            : ""
                                    }\nLog: ${job.logPath}${severityNote}\n\n${formatted.text}`,
                                },
                            ],
                            details: outputDetails(job, metadata, source),
                        };
                    }

                    // Fall back to sidecar for completed jobs (persists across sessions)
                    const sidecarOutput = await readJobOutputDetailsFromSidecar(
                        params.jobId
                    );
                    if (sidecarOutput) {
                        const formatted = formatJobOutput({
                            text: sidecarOutput.text,
                            grepPattern,
                            headCount,
                            tailCount,
                        });
                        const logLine = sidecarOutput.logPath
                            ? `\nLog: ${sidecarOutput.logPath}`
                            : "";
                        const evidence = sidecarOutput.logPath
                            ? jobLogEvidenceTracker.scan(
                                  `${params.jobId}:jobs-output`,
                                  sidecarOutput.logPath,
                                  true
                              )
                            : undefined;
                        const severityCounts =
                            evidence?.counts ?? countLines(sidecarOutput.text);
                        const severityDelta = evidence?.delta;
                        const severityNote =
                            `\nLog severity: ${formatLogCounts(severityCounts)}` +
                            (severityDelta
                                ? `; since prior read +${severityDelta.total} lines (+${severityDelta.err} err, +${severityDelta.warn} warn)`
                                : "") +
                            (evidence?.truncated
                                ? "; scan capped at 512KB"
                                : "");
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Output for ${params.jobId} (from sidecar)${
                                        grepPattern
                                            ? `, grep "${grepPattern}"`
                                            : ""
                                    }${
                                        headCount !== undefined
                                            ? `, head=${headCount}`
                                            : ""
                                    }${
                                        tailCount !== undefined
                                            ? `, tail=${tailCount}`
                                            : ""
                                    }${logLine}${severityNote}\n\n${formatted.text}`,
                                },
                            ],
                            details: {
                                jobId: params.jobId,
                                status: "completed",
                                logPath: sidecarOutput.logPath,
                                totalLines: formatted.totalLines,
                                severityCounts,
                                ...(severityDelta ? { severityDelta } : {}),
                                ...(evidence?.truncated
                                    ? { severityScanTruncated: true }
                                    : {}),
                                truncated: formatted.truncated,
                                empty: formatted.empty,
                                error: formatted.error,
                                sourceId: sidecarOutput.sourceId,
                                chunkIds: sidecarOutput.chunkIds,
                            },
                        };
                    }

                    throw new Error(
                        `Job not found: ${params.jobId}. It may have been cleaned up.`
                    );
                }

                case "kill": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=kill");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);

                    if (state.pendingBackgroundAgents.has(job.id)) {
                        cancelPendingBackgroundAgent(state, job.id);
                        clearPendingDecision(state, job);
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Killed queued background agent ${job.id} before it started.`,
                                },
                            ],
                            details: jobDetails(job),
                        };
                    }

                    // Tmux jobs don't have proc — kill via tmux window.
                    const tmuxCtx = getTmuxContext(job);
                    if (tmuxCtx) {
                        killTmuxJob(job);
                    } else if (job.proc && job.status === "running") {
                        killProcessGroup(job.proc.pid!, "SIGTERM");
                    } else {
                        throw new Error(`Job is not running: ${job.id}`);
                    }
                    silenceJobAfterKill(job, "manual");
                    cancelQueuedBackgroundNotifications(pi, job.id);
                    clearPendingDecision(state, job);
                    state.wakeupEvaluate?.();
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: tmuxCtx
                                    ? `Killed tmux window ${tmuxCtx.windowId} for ${job.id}`
                                    : `Sent SIGTERM to ${job.id} (process group)`,
                            },
                        ],
                        details: jobDetails(job),
                    };
                }

                case "attach": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=attach");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);

                    // If already done or wait=false, return output immediately
                    const waitForCompletion = params.wait ?? true;
                    if (job.status !== "running" || !waitForCompletion) {
                        // Completion indexing/delivery can settle while the
                        // output reads below are pending. Invalidate that
                        // notification before yielding; consumption itself is
                        // recorded only after the output has been read.
                        state.cancelCompletionBatchForJob?.(job.id);
                        const output = await readOutputTail(
                            job.logPath,
                            MAX_OUTPUT_PREVIEW_CHARS
                        );
                        const source = await sourceDetailsForJob(job);
                        const metadata = getOutputMetadata(
                            output,
                            outputReadFailed(job, output)
                        );
                        job.outputConsumed = true;
                        state.cancelCompletionBatchForJob?.(job.id);
                        cancelQueuedBackgroundNotifications(pi, job.id);
                        state.wakeupEvaluate?.();
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text:
                                        job.status !== "running"
                                            ? `Attach finished for ${job.id}. Status: ${job.status}\nLog: ${job.logPath}\n\n${output}`
                                            : `Job ${job.id} (${job.status})\nLog: ${job.logPath}\n\n${output}`,
                                },
                            ],
                            details: outputDetails(job, metadata, source),
                        };
                    }

                    // Ensure donePromise exists
                    if (!job.donePromise) createJobDonePromise(job);

                    const POLL_INTERVAL_MS = 5_000;
                    const MAX_ATTACH_MS = (params.timeout ?? 600) * 1_000;
                    const attachStartedAt = Date.now();
                    const deadline = attachStartedAt + MAX_ATTACH_MS;
                    const inlineDeadline =
                        attachStartedAt + INLINE_ATTACH_WINDOW_MS;

                    // Resolve when the caller aborts so the poll wait below
                    // wakes immediately instead of waiting out the 5s interval.
                    let abortResolve: () => void = () => {};
                    const abortPromise = new Promise<void>((resolve) => {
                        abortResolve = resolve;
                    });
                    if (signal?.aborted) abortResolve();
                    signal?.addEventListener("abort", abortResolve, {
                        once: true,
                    });

                    // Non-blocking poll loop with progress updates.
                    // Polls periodically; exits promptly when the job completes
                    // (via donePromise race), the signal is aborted, a dead PID
                    // is detected, or the timeout expires.
                    while (job.status === "running") {
                        // Check abort signal
                        if (signal?.aborted) {
                            break;
                        }

                        // Dead-PID detection: a process that died without
                        // emitting close (SIGKILL, crash) would otherwise keep
                        // the job "running" until the attach timeout. Mark it
                        // terminal so attach returns promptly.
                        if (job.pid > 0) {
                            try {
                                process.kill(job.pid, 0);
                            } catch {
                                markJobTerminal(job, "failed");
                                void trackJobOutputIndex(job, ctx);
                                clearPendingDecision(state, job);
                                break;
                            }
                        }

                        // The configured deadline remains the backstop; the
                        // shorter inline window returns a resumable job handle.
                        if (
                            Date.now() >= deadline ||
                            Date.now() >= inlineDeadline
                        ) {
                            break;
                        }

                        // Read latest output
                        const tail = await readOutputTail(
                            job.logPath,
                            MAX_OUTPUT_PREVIEW_CHARS
                        );
                        const runtime = formatDuration(
                            Date.now() - job.startTime
                        );
                        const timeLeft = Math.round(
                            (deadline - Date.now()) / 1000
                        );

                        // Send progress update to agent
                        onUpdate?.({
                            content: [
                                {
                                    type: "text" as const,
                                    text:
                                        `Attaching to ${job.id} (running ${runtime}, ` +
                                        `${timeLeft}s timeout remaining)...\n\n${tail}`,
                                },
                            ],
                            details: {
                                ...jobDetails(job),
                                ...getOutputMetadata(
                                    tail,
                                    outputReadFailed(job, tail)
                                ),
                            },
                        });

                        // Wait for the next poll interval, job completion, or abort
                        const now = Date.now();
                        const waitMs = Math.max(
                            0,
                            Math.min(
                                POLL_INTERVAL_MS,
                                deadline - now,
                                inlineDeadline - now
                            )
                        );
                        await Promise.race([
                            new Promise<void>((resolve) =>
                                setTimeout(resolve, waitMs)
                            ),
                            job.donePromise,
                            abortPromise,
                        ]);
                    }

                    // The poll loop has finished; avoid retaining the signal
                    // listener for the lifetime of the tool context.
                    signal?.removeEventListener("abort", abortResolve);

                    // Read final output
                    const output = await readOutputTail(
                        job.logPath,
                        MAX_OUTPUT_PREVIEW_CHARS
                    );
                    const metadata = getOutputMetadata(
                        output,
                        outputReadFailed(job, output)
                    );
                    const source = await sourceDetailsForJob(job);
                    if (
                        job.status === "running" &&
                        !signal?.aborted &&
                        Date.now() >= inlineDeadline &&
                        inlineDeadline < deadline
                    ) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text:
                                        `Inline attach window elapsed for ${job.id}; ` +
                                        `the job is still running. This is partial output.\n` +
                                        `Job ID: ${job.id}\nLog: ${job.logPath}\n` +
                                        `Use jobs(attach) with this job ID to attach again.\n\n${output}`,
                                },
                            ],
                            details: outputDetails(job, metadata, source, {
                                timedOut: false,
                            }),
                        };
                    }
                    if (job.status !== "running") {
                        job.outputConsumed = true;
                        state.cancelCompletionBatchForJob?.(job.id);
                    }
                    cancelQueuedBackgroundNotifications(pi, job.id);
                    state.wakeupEvaluate?.();

                    if (signal?.aborted) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text:
                                        `Attach aborted for ${job.id}. ` +
                                        `Job is still running.\n` +
                                        `Log: ${job.logPath}\n\n${output}`,
                                },
                            ],
                            details: outputDetails(job, metadata, source, {
                                timedOut: false,
                            }),
                        };
                    }

                    if (Date.now() >= deadline && job.status === "running") {
                        const runtime = formatDuration(
                            Date.now() - job.startTime
                        );
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text:
                                        `⚠️ Attach timed out after ${MAX_ATTACH_MS / 1000}s ` +
                                        `for ${job.id}. Job is still running ` +
                                        `(${runtime}).\n` +
                                        `PID: ${job.pid}\n` +
                                        `Log: ${job.logPath}\n\n${output}\n\n` +
                                        `Use jobs(output) to check again, ` +
                                        `or jobs(kill) to terminate.`,
                                },
                            ],
                            details: outputDetails(job, metadata, source, {
                                timedOut: true,
                            }),
                        };
                    }

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `Attach finished for ${job.id}. ` +
                                    `Status: ${job.status}\n` +
                                    `Log: ${job.logPath}\n\n${output}`,
                            },
                        ],
                        details: outputDetails(job, metadata, source, {
                            timedOut: false,
                        }),
                    };
                }
            }
        },
    });

    // ── job_decide tool ─────────────────────────────────────────────────

    pi.registerTool({
        name: "job_decide",
        label: "Job Decision",
        description:
            "Decide what to do with a background job that timed out. Use this when prompted after a command is backgrounded.",
        promptSnippet: "Decide on a timed-out background job",
        promptGuidelines: [
            "Use job_decide with decision 'keep' to let the job continue running in the background.",
            "Use job_decide with decision 'kill' to terminate the job (also cancels linked reminders).",
            "Use job_decide with decision 'check' to see the job's current output before deciding.",
        ],
        parameters: Type.Object({
            jobId: Type.String({
                description: "The job ID to decide on",
            }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description:
                    "keep = let it run, kill = terminate it, check = inspect output first",
            }),
        }),

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            _ctx
        ): Promise<AgentToolResult<JobResultDetails | undefined>> {
            const job = lookupJob(state, params.jobId);
            if (!job) {
                state.pendingDecisionJobId = undefined;
                state.wakeupEvaluate?.();
                return {
                    content: [
                        {
                            type: "text",
                            text: `Job ${params.jobId} not found.`,
                        },
                    ],
                    details: {
                        jobId: params.jobId,
                    },
                };
            }

            switch (params.decision) {
                case "kill": {
                    if (state.pendingBackgroundAgents.has(job.id)) {
                        cancelPendingBackgroundAgent(state, job.id);
                        state.pendingDecisionJobId = undefined;
                        state.wakeupEvaluate?.();
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Killed queued background agent ${job.id} before it started.`,
                                },
                            ],
                            details: jobDetails(job),
                        };
                    }

                    // Tmux jobs don't have proc — kill via tmux window.
                    const tmuxCtx = getTmuxContext(job);
                    if (tmuxCtx) {
                        killTmuxJob(job);
                    } else if (job.proc && job.status === "running") {
                        killProcessGroup(job.proc.pid!, "SIGTERM");
                    }
                    silenceJobAfterKill(job, "manual");
                    cancelQueuedBackgroundNotifications(pi, job.id);
                    state.pendingDecisionJobId = undefined;
                    state.wakeupEvaluate?.();
                    return {
                        content: [{ type: "text", text: `Killed ${job.id}.` }],
                        details: jobDetails(job),
                    };
                }
                case "keep": {
                    state.pendingDecisionJobId = undefined;
                    // An explicit keep is a request to be told the terminal
                    // result. Without this marker a successful completion is
                    // silently suppressed for jobs that were not launched with
                    // bash_bg's notify (auto-backgrounded/detached foreground
                    // commands), so the kept job's result is stranded until the
                    // agent happens to poll `jobs` — the observed "job finished
                    // but the agent never woke" gap.
                    if (job.status === "running") {
                        job.wantsCompletionNotification = true;
                    }
                    state.wakeupEvaluate?.();
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Keeping ${job.id} running in the background. You will be notified when it completes.`,
                            },
                        ],
                        details: jobDetails(job),
                    };
                }
                case "check": {
                    const output = await readOutputTail(
                        job.logPath,
                        MAX_OUTPUT_PREVIEW_CHARS
                    );
                    const metadata = getOutputMetadata(
                        output,
                        outputReadFailed(job, output)
                    );
                    const source = await sourceDetailsForJob(job);
                    // Agent has seen this terminal job's output —
                    // suppress completion notification and cancel reminds.
                    if (job.status !== "running") {
                        job.outputConsumed = true;
                        state.cancelCompletionBatchForJob?.(job.id);
                        cancelCallbacksForJob(job.id);
                        state.wakeupEvaluate?.();
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Output of ${job.id}:\n${output}`,
                            },
                        ],
                        details: outputDetails(job, metadata, source),
                    };
                }
            }
        },
    });

    // Wire completion-batch cancellation into state so the callbacks module
    // can suppress stale job-completion notifications when cancelling reminders.
    state.cancelCompletionBatchForJob = clearJobFromCompletionBatch;
    state.cancelAllCompletionBatches = clearAllCompletionBatches;
    state._flushCompletionBatch = flushCompletionBatch;

    // Inject guidance about bash_bg + remindDelay into the remind tool.
    // This belongs here (the bg module) rather than hardcoded in callbacks.ts
    // because it's guidance about bg workflow, cross-cutting two tools.
    const registerToolPromptGuidelines = (
        pi as ExtensionAPI & {
            registerToolPromptGuidelines?: (
                toolName: string,
                guidelines: string[]
            ) => void;
        }
    ).registerToolPromptGuidelines;
    registerToolPromptGuidelines?.call(pi, "remind", [
        "Use bash_bg with remindDelay instead of manual remind() for job progress checks — " +
            "the callback auto-cancels when the job completes.",
        "When you do use manual remind() to check on a running job, pass the jobId parameter " +
            "so the callback auto-cancels when the job completes or is killed.",
        "Use manual remind() only for standalone reminders that aren't linked to a job.",
    ]);
}

// ─── Tmux foreground execution ──────────────────────────────────────

/**
 * Execute a bash command in the foreground using tmux.
 *
 * Spawns the command inside a tmux window and polls the exit-code
 * sentinel file for completion. On timeout, the tmux window stays
 * alive — no foreground→background race window.
 */
async function executeTmuxForeground(
    toolCallId: string,
    command: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: { cwd: string } & UiContext,
    state: TauState,
    pi: ExtensionAPI
): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const jobId = `tmux-${process.pid}-${++state.jobCounter}`;
    let logPath: string;
    let tmuxCtx: import("./bash-tmux.ts").TmuxJobContext;

    try {
        const execCwd = resolveExecutionCwd(params.cwd, ctx.cwd);
        const result = spawnForegroundTmux(command, execCwd);
        logPath = result.logPath;
        tmuxCtx = result.tmuxCtx;
    } catch (error) {
        // Spawn/setup failure (no git root, tmux server error): the outer
        // catch in execute() sees the TmuxSpawnError and falls through to
        // the direct-spawn path. Do not mask the real reason here — a
        // converted generic message would defeat the outer routing.
        state.jobCounter--;
        throw error;
    }

    // Register as foreground job
    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: -1, // tmux — no single PID
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: false,
    };
    createJobDonePromise(job);
    attachTmuxContext(job, tmuxCtx);
    state.backgroundJobs.set(jobId, job);
    const refreshRunningJobsWidget = createRunningJobsWidgetRefresh(state, ctx);

    // Ctrl+B background signal
    let backgroundResolve: (() => void) | null = null;
    const backgroundSignal = new Promise<void>((resolve) => {
        backgroundResolve = resolve;
    });

    function triggerBackground(): void {
        backgroundResolve?.();
    }

    // Register so Ctrl+B can find this job
    // Tmux jobs don't have a ChildProcess, so we store a minimal RunningProcess
    // that can trigger backgrounding.
    state.runningProcesses.set(toolCallId, {
        toolCallId,
        proc: { pid: -1 } as never, // sentinel — not a real process
        command,
        logPath,
        triggerBackground,
    });
    state.currentlyRunningToolCallId = toolCallId;

    // Abort handler — kill tmux window and settle the race at once. Without
    // the killed signal an aborted call would pend until the stall watchdog
    // (up to 4 min) instead of failing fast. Detached below when the command
    // becomes a background job so a later abort cannot kill it.
    const onAbort = (): void => {
        killTmuxJob(job);
        triggerKilled("aborted");
    };
    if (signal) signal.addEventListener("abort", onAbort);

    // Timeout timer — matches the direct-spawn path: backgroundAfter
    // overrides the default timeout, so `backgroundAfter=300` actually
    // backgrounds after 300s instead of the 15s default.
    // Killed signal: killing a tmux window never writes the exit-code
    // sentinel, so the completion poller would wait forever. Resolve a
    // dedicated signal so the race below settles (observed: `sleep 15\n...`
    // bypassed the sleep block via newline, hit the disallowed kill path,
    // and hung the session ~24h waiting for a sentinel that never arrives).
    let killedResolve: ((reason: string) => void) | null = null;
    const killedSignal = new Promise<string>((resolve) => {
        killedResolve = resolve;
    });
    function triggerKilled(reason: string): void {
        killedResolve?.(reason);
    }
    const explicitTimeoutMs = resolveExplicitBackgroundAfterMs(
        params.backgroundAfter
    );
    const timeoutMs = explicitTimeoutMs ?? resolveBackgroundAfterMs();
    const timer = setTimeout(() => {
        // Non-interactive (print/`-p`/non-TTY): no agent loop to answer the
        // auto-background job_decide prompt, so let the command run to
        // completion instead of backgrounding or killing it on timeout.
        if (state.nonInteractive) return;
        if (!state.runningProcesses.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killTmuxJob(job);
            triggerKilled("timeout-disallowed");
            return;
        }
        if (getActiveBackgroundControlTools(pi).length === 0) {
            killTmuxJob(job);
            notifyBackgroundUnavailable(pi, command, timeoutMs);
            triggerKilled("timeout-no-controls");
            return;
        }
        triggerBackground();
    }, timeoutMs);
    timer.unref();

    // Background hint
    const hintTimer = setTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+Alt+B to background", "info");
    }, 2_000);
    hintTimer.unref();

    // Progress polling
    const PROGRESS_POLL_MS = 1_000;
    let pollTimer: NodeJS.Timeout | undefined;
    let cancelNoOutputWatchdog: (() => void) | undefined;
    let noOutputResolve: (() => void) | null = null;
    const noOutputSignal = new Promise<void>((resolve) => {
        noOutputResolve = resolve;
    });
    const emitWaitHeartbeat = createBgWaitHeartbeat(
        jobId,
        job.startTime,
        logPath,
        onUpdate
    );
    const startPolling = (): void => {
        pollTimer = setInterval(() => {
            refreshRunningJobsWidget();
            try {
                const content = readOutputTailSync(logPath, 4_096);
                if (content && content !== "(no output yet)") {
                    onUpdate?.({
                        content: [{ type: "text" as const, text: content }],
                        details: undefined,
                    });
                }
            } catch {
                // File may not be readable yet
            }
            emitWaitHeartbeat();
        }, PROGRESS_POLL_MS);
        pollTimer.unref();
    };

    // Completion polling — check the exit-code sentinel. Hoisted to function
    // scope so the backgrounded branch and finally block can clear it: a
    // leaked interval keeps reading AND unlinking the sentinel file, starving
    // the 500ms bgPoller of the exit code and leaving the job "running"
    // forever — which silently defeats the linked-callback auto-cancel.
    let checkTimer: NodeJS.Timeout | undefined;
    const completionPromise = new Promise<number | null>((resolve) => {
        checkTimer = setInterval(() => {
            const code = checkExitCode(tmuxCtx.exitCodeFile);
            if (code !== undefined) {
                clearInterval(checkTimer);
                resolve(code);
            }
        }, 200);
        checkTimer.unref();
    });

    try {
        // Wait for initial output or quick completion (2s threshold)
        const initialResult = await Promise.race([
            completionPromise,
            new Promise<null>((resolve) => {
                const t = setTimeout(() => resolve(null), 2_000);
                t.unref();
            }),
        ]);

        // Command completed quickly
        if (initialResult !== null) {
            state.backgroundJobs.delete(jobId);
            const output = captureOutput(
                tmuxCtx.windowId,
                2000,
                tmuxCtx.outputFile
            );
            const prepared = await prepareInlineOutput(
                {
                    id: jobId,
                    command,
                    logPath,
                    exitCode: initialResult ?? undefined,
                    status: initialResult === 0 ? "completed" : "failed",
                },
                ctx,
                output,
                "bash",
                { force: state.pipeHoistedCalls.has(toolCallId) }
            );
            // Stage 0's pre-filter capture, indexed on the same terms as the
            // command's own output. The tmux backend is the default when tmux
            // is available, so this is the path most piped commands actually
            // take -- leaving it unwired made the capture invisible on the
            // common path while it worked on the fallback.
            const tmuxStageZero = state.pipeStageZeroCalls.get(toolCallId);
            let tmuxStageZeroSourceId: string | null = null;
            if (tmuxStageZero) {
                state.pipeStageZeroCalls.delete(toolCallId);
                tmuxStageZeroSourceId = await indexStageZeroCapture(
                    tmuxStageZero,
                    command,
                    toolCallId,
                    ctx,
                    initialResult ?? undefined,
                    initialResult === 0 ? "completed" : "failed"
                );
            }
            // Clean up tmux window. Keep the session alive so the next
            // spawnInTmux call reuses it via new-window instead of creating
            // a fresh session — avoids tmux server state accumulation across
            // hundreds of create/destroy cycles which causes fork()+waitpid()
            // deadlocks (child exits but parent waitpid never returns).
            killWindow(tmuxCtx.windowId);
            const tmuxDetails = {
                ...preparedOutputDetails(
                    prepared,
                    logPath,
                    state.pipeHoistedCalls.has(toolCallId)
                ),
                ...(tmuxStageZero
                    ? {
                          pipeStageZero: {
                              path: tmuxStageZero.path,
                              command: tmuxStageZero.command,
                              sourceId: tmuxStageZeroSourceId,
                          },
                      }
                    : {}),
            };
            if (initialResult !== 0 && initialResult !== null) {
                // A failed command's stage-0 capture is still indexed and its
                // source id still reported: the file is on disk either way, and
                // a failed build is exactly when an agent wants to re-filter.
                throw new Error(
                    prepared.text || `Command exited with code ${initialResult}`
                );
            }
            return {
                content: [{ type: "text" as const, text: prepared.text }],
                details: tmuxDetails,
            };
        }

        // Command still running — start polling for progress
        startPolling();

        // Stall wake (both modes): a foreground command that outlives its
        // timeout handling — killed tmux window with no sentinel, ignored
        // SIGTERM, deadlocked binary — must wake the supervising agent at
        // most every PI_TAU_STALL_WAKE_MS (default 4 min) so outstanding
        // jobs and subagent completions get checked. Non-interactive always
        // arms it (auto-background no-ops there); interactive arms it as a
        // safety net behind the background/kill timer — scaled past an
        // explicit long delay so the net never kills what the user asked
        // to keep.
        const stallWakeMs = state.nonInteractive
            ? resolveNonInteractiveStallWakeMs()
            : Math.max(
                  resolveNonInteractiveStallWakeMs(),
                  timeoutMs + resolveInteractiveStallWakeMarginMs()
              );
        cancelNoOutputWatchdog = startNoOutputWatchdog(
            logPath,
            stallWakeMs,
            () => noOutputResolve?.()
        );

        // Race: completion vs background vs killed vs stall signal
        const raceResult = await Promise.race([
            completionPromise.then((code) => ({
                type: "completed" as const,
                code,
                killReason: undefined as string | undefined,
            })),
            backgroundSignal.then(() => ({
                type: "backgrounded" as const,
                code: undefined as number | undefined,
                killReason: undefined as string | undefined,
            })),
            noOutputSignal.then(() => ({
                type: "stalled" as const,
                code: undefined as number | undefined,
                killReason: undefined as string | undefined,
            })),
            killedSignal.then((killReason) => ({
                type: "killed" as const,
                code: undefined as number | undefined,
                killReason,
            })),
        ]);

        if (raceResult.type === "killed") {
            clearInterval(pollTimer);
            clearInterval(checkTimer);
            clearTimeout(timer);
            clearTimeout(hintTimer);
            cancelNoOutputWatchdog?.();
            state.runningProcesses.delete(toolCallId);
            if (state.currentlyRunningToolCallId === toolCallId) {
                state.currentlyRunningToolCallId = null;
            }
            silenceJobAfterKill(job, "manual");
            state.backgroundJobs.delete(jobId);
            updateWidget(state, ctx);
            const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
            throw buildKilledError(
                raceResult.killReason,
                command,
                logPath,
                tail
            );
        }

        // Interactive sessions keep kill semantics: the auto-background timer
        // normally wins long before this safety net, so a stall here means a
        // SIGTERM-ignoring or unmanageable window. Non-interactive sessions
        // instead detach the still-running window to the background so the
        // agent is woken to check on it without destroying in-flight work.
        if (raceResult.type === "stalled" && !state.nonInteractive) {
            clearInterval(pollTimer);
            clearInterval(checkTimer);
            clearTimeout(timer);
            clearTimeout(hintTimer);
            cancelNoOutputWatchdog?.();
            state.runningProcesses.delete(toolCallId);
            if (state.currentlyRunningToolCallId === toolCallId) {
                state.currentlyRunningToolCallId = null;
            }
            silenceJobAfterKill(job, "stall");
            killTmuxJob(job);
            // Drop the foreground entry like the direct-spawn stall kill and
            // the `killed` arm do: leaving a terminal job in the map made the
            // killed command linger in job listings.
            state.backgroundJobs.delete(jobId);
            // No SIGKILL fallback here: tmux jobs carry a pid -1 sentinel,
            // not a real process — the window kill above is the escalation.
            updateWidget(state, ctx);
            const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
            throw new PossiblyStuckError(
                `Possibly stuck: no output for ${formatDuration(stallWakeMs)}. ` +
                    `Killed tmux job ${jobId} so the session can continue.\n` +
                    `Command: ${command}\n` +
                    `Output (${logPath}):\n${tail}\n` +
                    `If this command is expected to stay silent longer, set PI_TAU_STALL_WAKE_MS (ms) higher and re-run, or use bash_bg for a long-running command.`
            );
        }

        if (
            raceResult.type === "backgrounded" ||
            raceResult.type === "stalled"
        ) {
            clearInterval(pollTimer);
            clearInterval(checkTimer);
            clearTimeout(timer);
            clearTimeout(hintTimer);
            state.runningProcesses.delete(toolCallId);

            // Mark as backgrounded — the completion poller in bash-tmux will handle notification.
            // Start the background completion poller.
            job.isBackgrounded = true;
            startJobLiveness(job, pi);
            if (state.currentlyRunningToolCallId === toolCallId) {
                state.currentlyRunningToolCallId = null;
            }

            // Start stall watchdog and cancel it when the completion poller
            // observes terminal state. Otherwise completed jobs emit stale
            // bg-stall notifications on the next watchdog tick.
            const cancelStall = startStallWatchdog(
                jobId,
                command,
                logPath,
                pi,
                state,
                () => {
                    killTmuxJob(job);
                },
                {
                    // A stall detach already told the agent the job is silent;
                    // only re-announce silence after it has produced output and
                    // gone quiet again.
                    silenceNoticeOnlyAfterGrowth: raceResult.type === "stalled",
                }
            );

            // Start background completion poller
            const bgPoller = setInterval(() => {
                refreshRunningJobsWidget();
                const result = pollTmuxCompletion(job);
                if (!result.completed) return;
                clearInterval(bgPoller);
                cancelStall();
                // A vanished window reports no exit code; leave exitCode
                // undefined rather than fabricating one.
                markJobTerminal(
                    job,
                    result.vanished
                        ? "failed"
                        : result.exitCode === 0 || result.exitCode === null
                          ? "completed"
                          : "failed",
                    result.vanished ? undefined : (result.exitCode ?? 0)
                );
                clearPendingDecision(state, job);
                void trackJobOutputIndex(job, ctx, "bash_bg");
                handleTmuxCompletion(job, state, pi, ctx, true);
                updateWidget(state, ctx);
            }, 500);
            bgPoller.unref();

            // Non-interactive sessions have no UI to answer the job_decide
            // gate, so never arm it there: it would block every subsequent
            // tool call.
            if (!state.nonInteractive) {
                state.pendingDecisionJobId = jobId;
            }

            // The tool result below is the authoritative backgrounding
            // notice. Do not enqueue a duplicate model turn.
            updateWidget(state, ctx);

            const silenceNotice =
                raceResult.type === "stalled"
                    ? `No output for ${formatDuration(stallWakeMs)}; detached the still-running command to the background instead of killing it.\n`
                    : "";

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            silenceNotice +
                            `Process backgrounded as ${jobId}${formatBackgroundEvidence(job)}\nCommand: ${command}\nTmux window: ${tmuxCtx.windowId}\nOutput: ${logPath}\n\n${backgroundCompletionNotice("failure-only")}`,
                    },
                ],
                details: undefined,
            };
        }

        // Command completed normally
        clearInterval(pollTimer);
        clearInterval(checkTimer);
        clearTimeout(timer);
        clearTimeout(hintTimer);
        state.runningProcesses.delete(toolCallId);
        if (state.currentlyRunningToolCallId === toolCallId) {
            state.currentlyRunningToolCallId = null;
        }
        state.backgroundJobs.delete(jobId);

        const output = captureOutput(
            tmuxCtx.windowId,
            2000,
            tmuxCtx.outputFile
        );
        const raceStageZero = state.pipeStageZeroCalls.get(toolCallId);
        const prepared = await prepareInlineOutput(
            {
                id: jobId,
                command,
                logPath,
                exitCode: raceResult.code ?? undefined,
                status: raceResult.code === 0 ? "completed" : "failed",
            },
            ctx,
            output,
            "bash",
            { force: state.pipeHoistedCalls.has(toolCallId) }
        );
        let raceStageZeroSourceId: string | null = null;
        if (raceStageZero) {
            state.pipeStageZeroCalls.delete(toolCallId);
            raceStageZeroSourceId = await indexStageZeroCapture(
                raceStageZero,
                command,
                toolCallId,
                ctx,
                raceResult.code ?? undefined,
                raceResult.code === 0 ? "completed" : "failed"
            );
        }
        killWindow(tmuxCtx.windowId);
        // Session is intentionally kept alive — reuse avoids tmux server
        // state accumulation that causes waitpid deadlocks.

        const raceDetails = {
            ...preparedOutputDetails(
                prepared,
                logPath,
                state.pipeHoistedCalls.has(toolCallId)
            ),
            ...(raceStageZero
                ? {
                      pipeStageZero: {
                          path: raceStageZero.path,
                          command: raceStageZero.command,
                          sourceId: raceStageZeroSourceId,
                      },
                  }
                : {}),
        };

        if (raceResult.code !== 0 && raceResult.code !== null) {
            throw new Error(
                prepared.text || `Command exited with code ${raceResult.code}`
            );
        }

        return {
            content: [{ type: "text" as const, text: prepared.text }],
            details: raceDetails,
        };
    } finally {
        clearInterval(pollTimer);
        clearInterval(checkTimer);
        clearTimeout(timer);
        clearTimeout(hintTimer);
        cancelNoOutputWatchdog?.();
        signal?.removeEventListener("abort", onAbort);
    }
}

// ─── Helpers used by executeTmuxForeground ──────────────────────────

/**
 * Build the error for the tmux foreground `killed` race arm. Pure (exported
 * for unit tests). Reasons: `timeout-disallowed` (sleep and other
 * non-backgroundable commands), `timeout-no-controls` (backgroundable
 * command killed because no job-control tool is active), `aborted`
 * (cancellation requested).
 */
export function buildKilledError(
    reason: string | undefined,
    command: string,
    logPath: string,
    tail: string
): Error {
    const context = `Command: ${command}\n` + `Output (${logPath}):\n${tail}`;
    if (reason === "aborted") {
        return new Error(
            `Command aborted (cancellation requested).\n${context}`
        );
    }
    if (reason === "timeout-no-controls") {
        return new Error(
            `Command killed on timeout (${reason}); no job-control tool ` +
                `(jobs/job_decide) is active, so the command was terminated ` +
                `instead of backgrounded. Enable the jobs or job_decide tool, ` +
                `then rerun the command.\n${context}`
        );
    }
    return new Error(
        `Command killed on timeout (${reason ?? "unknown"}); ` +
            `sleep and other non-backgroundable commands are killed instead of backgrounded. ` +
            `Use bash_bg for long waits.\n${context}`
    );
}

import { checkExitCode, killWindow } from "../tmux.ts";
