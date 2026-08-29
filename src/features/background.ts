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

import {
    findJobSourceDetailsInSidecar,
    findJobSourceIdInSidecar,
    indexJobOutputInSidecar,
    purgeSidecar,
    readJobOutputDetailsFromSidecar,
    prepareInlineOutput,
    readJobOutputFromSidecar,
    searchSidecarSources,
    trackJobOutputIndex,
} from "./sidecar.ts";

export {
    findJobSourceDetailsInSidecar,
    findJobSourceIdInSidecar,
    indexJobOutputInSidecar,
    purgeSidecar,
    readJobOutputDetailsFromSidecar,
    prepareInlineOutput,
    readJobOutputFromSidecar,
    searchSidecarSources,
    trackJobOutputIndex,
};

import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import {
    cancelCallbacksForJob,
    hasLinkedCallbacksForJob,
    scheduleJobReminder,
} from "./callbacks.ts";
import type {
    BackgroundJob,
    JobOutputIndex,
    JobResultDetails,
    RunningProcess,
    UiContext,
} from "../types.ts";
import {
    DEFAULT_TIMEOUT_MS,
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
    looksLikePrompt,
    markJobTerminal,
    readOutputTail,
    readOutputTailSync,
    formatJobLine,
} from "../utils.ts";
import {
    attachTmuxContext,
    getTmuxContext,
    killTmuxJob,
    pollTmuxCompletion,
    spawnBackgroundTmux,
    spawnForegroundTmux,
} from "./bash-tmux.ts";
import { captureOutput } from "../tmux.ts";

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
export function silenceJobAfterKill(job: BackgroundJob): void {
    markJobTerminal(job, "killed");
    job.outputConsumed = true;
}

// ─── Stall watchdog ─────────────────────────────────────────────────

export function startStallWatchdog(
    jobId: string,
    command: string,
    logPath: string,
    pi: ExtensionAPI,
    state: TauState,
    onOversize?: () => void
): () => void {
    let lastSize = 0;
    let lastGrowth = Date.now();
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
                pi.sendMessage(
                    {
                        customType: "bg-stall",
                        content: `⚠️ Background job ${jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.${suffix}`,
                        display: true,
                        details: { jobId, logPath, command },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
                );
                return;
            }

            if (size > lastSize) {
                lastSize = size;
                lastGrowth = Date.now();
                return;
            }
            if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

            const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);

            cancelled = true;
            clearInterval(timer);

            const suffix = outstandingJobsSuffix(state, jobId);
            if (looksLikePrompt(tail)) {
                const summary =
                    `Background job ${jobId} appears to be waiting for interactive input.\n` +
                    `Command: ${command}\n\n` +
                    `Last output:\n${tail.trimEnd()}\n\n` +
                    `The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
                    `with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;
                pi.sendMessage(
                    {
                        customType: "bg-stall",
                        content: `⚠️ ${summary}${suffix}`,
                        display: true,
                        details: { jobId, logPath, command },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
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
                `Command: ${command}\n\n` +
                `The job may be spinning, hung, or silently computing. Use job_decide ` +
                `to keep it running or kill it.`;
            pi.sendMessage(
                {
                    customType: "bg-stall",
                    content: `⚠️ ${summary}${suffix}`,
                    display: true,
                    details: { jobId, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
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

export function updateWidget(state: TauState, ctx: UiContext): void {
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
 * Clear pendingDecisionJobId if it matches the given job's id.
 * Extracted so both bash_bg close/error handlers and job_decide
 * can share the same logic.
 */
export function clearPendingDecision(
    state: TauState,
    job: BackgroundJob
): void {
    if (state.pendingDecisionJobId === job.id)
        state.pendingDecisionJobId = undefined;
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
    shouldNotify: boolean
): void {
    if (shouldNotify) {
        // bash_bg's notify option is an explicit request for a completion
        // turn. Preserve it through the shared successful-completion
        // suppression check; otherwise successful tmux jobs are silently
        // dropped even though notify defaults to true.
        job.wantsCompletionNotification = true;
        notifyCompletion(job, state, pi, ctx);
    } else {
        removeJob(state, job);
    }
    killTmuxJob(job);
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
        // Full duration once terminal; elapsed-so-far while still running.
        durationMs: (job.endTime ?? Date.now()) - job.startTime,
        sourceId: job.sourceId,
        chunkIds: job.chunkIds,
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

/**
 * Preserve the same structured output metadata for foreground bash results
 * that jobs output already returns for background jobs. Short complete output
 * stays lightweight; reduced output carries its recovery reference and size.
 */
function preparedOutputDetails(
    prepared: Awaited<ReturnType<typeof prepareInlineOutput>>,
    logPath: string
): Partial<JobResultDetails> | undefined {
    if (!prepared.truncated && !prepared.source) return undefined;
    return {
        ...(prepared.totalLines !== undefined
            ? { totalLines: prepared.totalLines }
            : {}),
        ...(prepared.byteCount !== undefined
            ? { byteCount: prepared.byteCount }
            : {}),
        ...(prepared.empty !== undefined ? { empty: prepared.empty } : {}),
        truncated: prepared.truncated,
        ...(prepared.partial !== undefined ? { partial: prepared.partial } : {}),
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
    const count = Array.from(state.backgroundJobs.values()).filter((j) => {
        if (j.id === excludeJobId) return false;
        if (j.status !== "running") return false;
        try {
            if (j.pid) process.kill(j.pid, 0);
            return true;
        } catch {
            // ESRCH = no such process, EACCES/EPERM = exists but can't signal
            return false;
        }
    }).length;
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

type CompletionBatchItem = {
    job: BackgroundJob;
    duration: string;
    emoji: string;
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
};

const pendingCompletionDeliveries: PendingCompletionDelivery[] = [];
let completionAgentBusy = false;
let completionLifecycleToken = 0;
let settledCompletionFlushTimer: NodeJS.Timeout | undefined;
// Prevent duplicate notifications when both error and close handlers fire.
const completionNotifiedJobs = new WeakSet<BackgroundJob>();
// Invalidates asynchronous indexing callbacks after a batch is cleared.
let completionBatchGeneration = 0;
const suppressedCompletionJobIds = new Set<string>();

/** Count currently running background jobs (excluding any completed/failed/killed). */
function countOutstandingJobs(state: TauState): number {
    return Array.from(state.backgroundJobs.values()).filter(
        (j) => j.status === "running"
    ).length;
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

    // Suppress successful completions to avoid wasted LLM turns — UNLESS
    // one of the jobs has linked callbacks (meaning the agent explicitly
    // asked to be reminded) OR a linked callback fired while the job was
    // still running (meaning a progress check was delivered but the agent
    // still wants the final completion notification). In either case,
    // deliver the notification (which cancels any remaining linked callbacks).
    // Failed completions are always delivered.
    if (!hasFailedCompletion(batch)) {
        const hasLinked = batch.some(
            (j) =>
                hasLinkedCallbacksForJob(j.job.id) ||
                j.job.wantsCompletionNotification
        );
        if (!hasLinked) return;
    }

    queueCompletionDelivery(batch, pi, state);
}

function hasFailedCompletion(jobs: CompletionBatchItem[]): boolean {
    return jobs.some((j) => j.job.status !== "completed");
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

function deliverCompletionNotification(
    delivery: PendingCompletionDelivery
): void {
    const batch = pruneConsumedCompletions(delivery.jobs);
    if (batch.length === 0) return;

    const { pi, state } = delivery;
    const outstandingCount = countOutstandingJobs(state);
    const suffix =
        outstandingCount > 0 ? ` (${outstandingCount} jobs outstanding)` : "";

    if (batch.length === 1) {
        const { job, duration, emoji } = batch[0];
        const exitLine =
            job.exitCode !== undefined ? `, exit ${job.exitCode}` : "";

        // Best-effort GPU snapshot at completion time
        const gpuLine = readGpuSnapshot();
        const resourceInfo = gpuLine ? `\nGPU: ${gpuLine}` : "";

        pi.sendMessage(
            {
                customType: "job-completion",
                content:
                    `${emoji} ${job.id} ${job.status} (${duration})${suffix}${exitLine}\n` +
                    `Command: ${job.command}\nOutput: ${job.logPath}${resourceInfo}`,
                display: true,
                details: {
                    jobId: job.id,
                    status: job.status,
                    exitCode: job.exitCode,
                    duration,
                    command: job.command,
                    logPath: job.logPath,
                    sourceId: job.sourceId,
                    chunkIds: job.chunkIds,
                    outstandingJobs: outstandingCount,
                },
            },
            { deliverAs: "followUp", triggerTurn: true }
        );
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
            }`
    );
    const detailLines = batch.map((j) => `  Command: ${j.job.command}`);

    const gpuLine = readGpuSnapshot();
    const resourceInfo = gpuLine ? `\nGPU: ${gpuLine}` : "";

    pi.sendMessage(
        {
            customType: "job-completion",
            content: `${header}\n${lines.join("\n")}\n${detailLines.join("\n")}${resourceInfo}`,
            display: true,
            details: {
                batch: batch.map((b) => ({
                    jobId: b.job.id,
                    status: b.job.status,
                    exitCode: b.job.exitCode,
                    duration: b.duration,
                    command: b.job.command,
                    logPath: b.job.logPath,
                    sourceId: b.job.sourceId,
                    chunkIds: b.job.chunkIds,
                })),
                outstandingJobs: outstandingCount,
            },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
}

function flushPendingCompletionDeliveries(): void {
    if (completionAgentBusy) return;
    while (pendingCompletionDeliveries.length > 0) {
        const delivery = pendingCompletionDeliveries.shift();
        if (delivery) deliverCompletionNotification(delivery);
    }
}

function queueCompletionDelivery(
    jobs: CompletionBatchItem[],
    pi: ExtensionAPI,
    state: TauState
): void {
    const jobsToDeliver = pruneConsumedCompletions(jobs);
    if (jobsToDeliver.length === 0) return;

    // Cancel linked callbacks for all delivered jobs — we're about to
    // send the result to the agent, so remind callbacks are now stale.
    for (const { job } of jobsToDeliver) {
        cancelCallbacksForJob(job.id);
    }
    pendingCompletionDeliveries.push({ jobs: jobsToDeliver, pi, state });
    flushPendingCompletionDeliveries();
}

/**
 * Remove a job's pending completion notification from the debounced batch.
 * Called when the agent cancels callbacks — no point sending stale
 * notifications for jobs the agent has already acknowledged.
 */
export function clearJobFromCompletionBatch(jobId: string): void {
    // The indexing promise may not have queued the job yet.
    suppressedCompletionJobIds.add(jobId);
    const idx = completionBatch.jobs.findIndex((j) => j.job.id === jobId);
    if (idx !== -1) {
        completionBatch.jobs.splice(idx, 1);
        if (completionBatch.jobs.length === 0) {
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
        if (!hasFailedCompletion(delivery.jobs)) {
            pendingCompletionDeliveries.splice(i, 1);
        }
    }
}

/**
 * Clear all pending completion notifications from the debounced batch.
 * Called when the agent cancels all callbacks — no point sending stale
 * notifications for jobs the agent has already acknowledged.
 */
export function clearAllCompletionBatches(): void {
    completionBatchGeneration++;
    suppressedCompletionJobIds.clear();
    if (completionBatch.timer) {
        clearTimeout(completionBatch.timer);
        completionBatch.timer = undefined;
    }
    completionBatch.jobs.length = 0;
    completionBatch.startTime = 0;
    completionBatch.pi = undefined;
    completionBatch.state = undefined;
    pendingCompletionDeliveries.length = 0;
}

/** Send a structured completion notification to the agent. */
export function notifyCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    // If the job was already silenced (killed by watchdog, tool, etc.),
    // skip notification entirely — the killing path already sent one.
    if (job.outputConsumed || completionNotifiedJobs.has(job)) return;
    completionNotifiedJobs.add(job);

    // Linked callbacks (remindDelay) are NOT cancelled here — delivery
    // is deferred to flushCompletionBatch which decides whether to
    // suppress (no linked callbacks) or deliver (linked callbacks
    // present for any job in the batch).

    const duration = formatDuration(Date.now() - job.startTime);
    const emoji = job.status === "completed" ? "✅" : "❌";

    // Toast notification fires immediately for each job
    ctx.ui.notify(
        `${emoji} ${job.id} ${job.status} (${duration})`,
        job.status === "completed" ? "success" : "error"
    );

    // Indexing is asynchronous. Queue the completion only after it settles so
    // sourceId/chunkIds are present in the notification. Cleanup remains
    // immediate, preserving the lifecycle contract for jobs/attach.
    const generation = completionBatchGeneration;
    const enqueue = (): void => {
        if (
            generation !== completionBatchGeneration ||
            job.outputConsumed ||
            suppressedCompletionJobIds.delete(job.id)
        )
            return;
        completionBatch.jobs.push({ job, duration, emoji });
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
    ctx: UiContext
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
    state.currentlyRunningToolCallId = null;

    const cancelStall = startStallWatchdog(
        jobId,
        command,
        logPath,
        pi,
        state,
        () => {
            if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
            silenceJobAfterKill(job);
        }
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

    ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
    updateWidget(state, ctx);

    return job;
}

// ── Default timeout timer (signal-based) ─────────────────────────────

/** Return the job-control tools currently available to the agent. */
export function getActiveBackgroundControlTools(pi: ExtensionAPI): string[] {
    try {
        return pi
            .getActiveTools()
            .filter((name) => name === "jobs" || name === "job_decide");
    } catch {
        // Older hosts/mocks may not expose active-tool introspection. Keep the
        // historical behavior there; current pi always provides this method.
        return ["jobs", "job_decide"];
    }
}

function jobControlInstructions(pi: ExtensionAPI, jobId: string): string {
    const controls = getActiveBackgroundControlTools(pi);
    if (controls.includes("job_decide")) {
        return (
            `Use the job_decide tool with jobId "${jobId}" to decide:\n` +
            `- decision "check": inspect the output first\n` +
            `- decision "keep": let it continue running\n` +
            `- decision "kill": terminate it`
        );
    }
    return (
        `Use the jobs tool with action "list", "output", "attach", or "kill" ` +
        `and jobId "${jobId}" to manage it.`
    );
}

function notifyBackgroundUnavailable(
    pi: ExtensionAPI,
    command: string,
    timeoutMs: number
): void {
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
    const timeoutMs = explicitTimeoutMs ?? DEFAULT_TIMEOUT_MS;

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
            return;
        }

        // Never create an unmanageable background job. A pending decision
        // gate blocks normal tools, so backgrounding without jobs/job_decide
        // would strand the agent and encourage unsafe shell cleanup attempts.
        if (!canBackground()) {
            const rp = state.runningProcesses.get(toolCallId);
            if (rp?.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
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
    });

    // ── Override bash tool ─────────────────────────────────────────────

    const originalBashTool = createBashTool(process.cwd());

    pi.registerTool({
        ...originalBashTool,
        name: "bash",
        description:
            "Execute bash commands with streaming output. Commands that run longer than 15 seconds " +
            "are automatically backgrounded and the agent is asked whether to kill or let them continue. " +
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
                        "Background the command after this many seconds (default: auto, ~15 seconds). " +
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
                } catch {
                    // tmux spawn failed (not in git repo, server error, etc.)
                    // Fall through to direct-spawn path.
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

            // Abort handler
            if (signal) {
                signal.addEventListener("abort", () => {
                    killProcessGroup(proc.pid!, "SIGTERM");
                });
            }

            // Start timeout timer (background-after timer, not a kill timeout)
            const timer = startTimeoutTimer(
                triggerBackground,
                command,
                state,
                toolCallId,
                typeof params.backgroundAfter === "number"
                    ? params.backgroundAfter * 1_000
                    : undefined,
                () => getActiveBackgroundControlTools(pi).length > 0,
                () =>
                    notifyBackgroundUnavailable(
                        pi,
                        command,
                        typeof params.backgroundAfter === "number"
                            ? params.backgroundAfter * 1_000
                            : DEFAULT_TIMEOUT_MS
                    )
            );

            // Background hint
            const hintTimer = setTimeout(() => {
                ctx.ui.notify("⏱ Ctrl+B to background", "info");
            }, 2_000);
            hintTimer.unref();

            // File-polling for foreground progress
            const PROGRESS_POLL_MS = 1_000;
            let pollTimer: NodeJS.Timeout | undefined;
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
                        "bash"
                    );
                    return {
                        content: [
                            { type: "text" as const, text: prepared.text },
                        ],
                        details: preparedOutputDetails(prepared, logPath),
                    };
                }

                // Command still running — start polling for progress
                startPolling();

                // Race: completion vs background signal
                const raceResult = await Promise.race([
                    procResult.then((r) => ({
                        type: "completed" as const,
                        ...r,
                    })),
                    backgroundSignal.then(() => ({
                        type: "backgrounded" as const,
                    })),
                ]);

                if (raceResult.type === "backgrounded") {
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
                        ctx
                    );

                    // Remove stale foreground entry created earlier — same process,
                    // separate job ID that would otherwise stay in state forever.
                    state.backgroundJobs.delete(jobId);

                    state.pendingDecisionJobId = job.id;

                    const duration = formatDuration(
                        typeof params.backgroundAfter === "number"
                            ? params.backgroundAfter * 1_000
                            : DEFAULT_TIMEOUT_MS
                    );
                    const bgSuffix = outstandingJobsSuffix(state, job.id);
                    pi.sendMessage(
                        {
                            customType: "bg-timeout",
                            content:
                                `⏰ Command timed out after ${duration} and has been backgrounded as ${job.id}${bgSuffix}.\n` +
                                `Command: ${command}\n` +
                                `PID: ${job.pid}\n` +
                                `Output so far: ${job.logPath}\n\n` +
                                `${jobControlInstructions(pi, job.id)}\n\n` +
                                `Use jobs action "attach" with a timeout to monitor its progress with periodic updates.`,
                            display: true,
                            details: {
                                jobId: job.id,
                                logPath: job.logPath,
                                command,
                                pid: job.pid,
                                startTime: job.startTime,
                            },
                        },
                        { deliverAs: "followUp", triggerTurn: true }
                    );

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Process backgrounded as ${job.id}\nCommand: ${command}\nPID: ${job.pid}\nOutput: ${job.logPath}`,
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
                    "bash"
                );

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
                    details: preparedOutputDetails(prepared, logPath),
                };
            } finally {
                clearInterval(pollTimer);
                clearTimeout(timer);
                clearTimeout(hintTimer);
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
            "Optionally set a kill deadline (timeout), schedule an inline reminder (remindDelay), or both.",
        promptSnippet:
            "Run bash command in background immediately" +
            " (supports kill deadline and inline reminder)",
        promptGuidelines: [
            "Use bash_bg when you want to start a long-running command in background immediately.",
            "This is different from regular bash + Ctrl+Shift+B — bash_bg backgrounds from the start.",
            "Use timeout to set a kill deadline: the job is terminated if it runs longer than N seconds.",
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
                        "Kill deadline in seconds. If the job runs longer than this, it is terminated. " +
                        "Use when a command must finish within a time bound.",
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
            const execCwd = resolveExecutionCwd(params.cwd, ctx.cwd);
            validateWorkingDirectory(execCwd);

            // ── Tmux path ─────────────────────────────────────────────
            if (state.tmuxAvailable) {
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
                                killTmuxJob(
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
                                        } satisfies BackgroundJob)
                                );
                            }
                        ),
                    // Finalize through the shared completion machinery
                    // (notifyCompletion + tmux window cleanup).
                    (job) =>
                        handleTmuxCompletion(job, state, pi, ctx, shouldNotify),
                    // Refresh the background-jobs widget once the job is
                    // finalized (completion/cleanup), not just at spawn.
                    () => updateWidget(state, ctx)
                );

                updateWidget(state, ctx);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Started background job ${job.id}\nCommand: ${params.command}\nOutput: ${job.logPath}`,
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

            const cancelStall = startStallWatchdog(
                jobId,
                params.command,
                logPath,
                pi,
                state,
                () => {
                    if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                    silenceJobAfterKill(job);
                }
            );

            // ── Kill deadline timeout ──────────────────────────────────
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            if (typeof params.timeout === "number" && params.timeout > 0) {
                killTimer = setTimeout(() => {
                    if (proc.pid && job.status === "running") {
                        killProcessGroup(proc.pid, "SIGTERM");
                        markJobTerminal(job, "killed");
                        // Don't silence — let notifyCompletion send the notification
                    }
                }, params.timeout * 1_000);
                killTimer.unref();
            }

            // ── Inline reminder ───────────────────────────────────────
            let reminderId: string | undefined;
            if (params.remindDelay) {
                const msg =
                    params.remindMessage ??
                    `check on: ${params.command.slice(0, 80)}`;
                const rid = scheduleJobReminder(jobId, params.remindDelay, msg);
                if (rid) reminderId = rid;
            }

            proc.on("close", (code) => {
                cancelStall();
                if (killTimer) clearTimeout(killTimer);
                killTimer = undefined;
                markJobTerminal(
                    job,
                    code === 0 || code === null ? "completed" : "failed",
                    code ?? 0
                );
                void trackJobOutputIndex(job, ctx);
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                else removeJob(state, job);
                updateWidget(state, ctx);
            });

            proc.on("error", () => {
                cancelStall();
                if (killTimer) clearTimeout(killTimer);
                killTimer = undefined;
                markJobTerminal(job, "failed");
                void trackJobOutputIndex(job, ctx);
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                else removeJob(state, job);
                updateWidget(state, ctx);
            });

            updateWidget(state, ctx);

            // Build summary line for reminders / timeout
            let extra = "";
            if (killTimer) {
                extra += `\nKill deadline: ${params.timeout}s`;
            }
            if (reminderId) {
                extra += `\nReminder: ${reminderId} (in ${params.remindDelay})`;
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Started background job ${jobId}\n` +
                            `Command: ${params.command}\n` +
                            `PID: ${proc.pid}\n` +
                            `Output: ${logPath}${extra}`,
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
                            cancelCallbacksForJob(job.id);
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
                        };
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
                                    }\nLog: ${job.logPath}\n\n${formatted.text}`,
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
                                    }${logLine}\n\n${formatted.text}`,
                                },
                            ],
                            details: {
                                jobId: params.jobId,
                                status: "completed",
                                logPath: sidecarOutput.logPath,
                                totalLines: formatted.totalLines,
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
                    silenceJobAfterKill(job);
                    clearPendingDecision(state, job);
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
                    const deadline = Date.now() + MAX_ATTACH_MS;

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

                        // Check timeout
                        if (Date.now() >= deadline) {
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
                        const waitMs = Math.max(
                            0,
                            Math.min(POLL_INTERVAL_MS, deadline - Date.now())
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
                    job.outputConsumed = true;

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
                    silenceJobAfterKill(job);
                    state.pendingDecisionJobId = undefined;
                    return {
                        content: [{ type: "text", text: `Killed ${job.id}.` }],
                        details: jobDetails(job),
                    };
                }
                case "keep": {
                    state.pendingDecisionJobId = undefined;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Keeping ${job.id} running in the background. Use the jobs tool to check on it later.`,
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
                        cancelCallbacksForJob(job.id);
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
    (
        pi as ExtensionAPI & {
            registerToolPromptGuidelines: (
                toolName: string,
                guidelines: string[]
            ) => void;
        }
    ).registerToolPromptGuidelines("remind", [
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
    } catch {
        // Not in a git repo — fall back to direct spawn.
        state.jobCounter--;
        throw new Error(
            "tmux backend requires a git repository. " +
                "Falling back to direct process management."
        );
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

    // Abort handler — kill tmux window
    if (signal) {
        signal.addEventListener("abort", () => {
            killTmuxJob(job);
        });
    }

    // Timeout timer — matches the direct-spawn path: backgroundAfter
    // overrides the default timeout, so `backgroundAfter=300` actually
    // backgrounds after 300s instead of the 15s default.
    const timeoutMs =
        typeof params.backgroundAfter === "number"
            ? params.backgroundAfter * 1_000
            : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
        // Non-interactive (print/`-p`/non-TTY): no agent loop to answer the
        // auto-background job_decide prompt, so let the command run to
        // completion instead of backgrounding or killing it on timeout.
        if (state.nonInteractive) return;
        if (!state.runningProcesses.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killTmuxJob(job);
            return;
        }
        if (getActiveBackgroundControlTools(pi).length === 0) {
            killTmuxJob(job);
            notifyBackgroundUnavailable(pi, command, timeoutMs);
            return;
        }
        triggerBackground();
    }, timeoutMs);
    timer.unref();

    // Background hint
    const hintTimer = setTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+B to background", "info");
    }, 2_000);
    hintTimer.unref();

    // Progress polling
    const PROGRESS_POLL_MS = 1_000;
    let pollTimer: NodeJS.Timeout | undefined;
    const startPolling = (): void => {
        pollTimer = setInterval(() => {
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
                "bash"
            );
            // Clean up tmux window. Keep the session alive so the next
            // spawnInTmux call reuses it via new-window instead of creating
            // a fresh session — avoids tmux server state accumulation across
            // hundreds of create/destroy cycles which causes fork()+waitpid()
            // deadlocks (child exits but parent waitpid never returns).
            killWindow(tmuxCtx.windowId);
            if (initialResult !== 0 && initialResult !== null) {
                throw new Error(
                    prepared.text || `Command exited with code ${initialResult}`
                );
            }
            return {
                content: [{ type: "text" as const, text: prepared.text }],
                details: preparedOutputDetails(prepared, logPath),
            };
        }

        // Command still running — start polling for progress
        startPolling();

        // Race: completion vs background signal
        const raceResult = await Promise.race([
            completionPromise.then((code) => ({
                type: "completed" as const,
                code,
            })),
            backgroundSignal.then(() => ({
                type: "backgrounded" as const,
                code: undefined as number | undefined,
            })),
        ]);

        if (raceResult.type === "backgrounded") {
            clearInterval(pollTimer);
            clearInterval(checkTimer);
            clearTimeout(timer);
            clearTimeout(hintTimer);
            state.runningProcesses.delete(toolCallId);

            // Mark as backgrounded — the completion poller in bash-tmux will handle notification.
            // Start the background completion poller.
            job.isBackgrounded = true;
            state.currentlyRunningToolCallId = null;

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
                }
            );

            // Start background completion poller
            const bgPoller = setInterval(() => {
                const result = pollTmuxCompletion(job);
                if (!result.completed) return;
                clearInterval(bgPoller);
                cancelStall();
                markJobTerminal(
                    job,
                    result.exitCode === 0 || result.exitCode === null
                        ? "completed"
                        : "failed",
                    result.exitCode ?? 0
                );
                clearPendingDecision(state, job);
                void trackJobOutputIndex(job, ctx, "bash_bg");
                handleTmuxCompletion(job, state, pi, ctx, true);
                updateWidget(state, ctx);
            }, 500);
            bgPoller.unref();

            state.pendingDecisionJobId = jobId;

            const duration = formatDuration(timeoutMs);
            pi.sendMessage(
                {
                    customType: "bg-timeout",
                    content:
                        `⏰ Command timed out after ${duration} and has been backgrounded as ${jobId}.\n` +
                        `Command: ${command}\n` +
                        `Tmux window: ${tmuxCtx.windowId}\n` +
                        `Output so far: ${logPath}\n\n` +
                        `${jobControlInstructions(pi, jobId)}\n\n` +
                        `You can attach to the tmux window with: tmux attach -t ${tmuxCtx.windowId}`,
                    display: true,
                    details: { jobId, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );

            updateWidget(state, ctx);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Process backgrounded as ${jobId}\nCommand: ${command}\nTmux window: ${tmuxCtx.windowId}\nOutput: ${logPath}`,
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
                exitCode: raceResult.code ?? undefined,
                status: raceResult.code === 0 ? "completed" : "failed",
            },
            ctx,
            output,
            "bash"
        );
        killWindow(tmuxCtx.windowId);
        // Session is intentionally kept alive — reuse avoids tmux server
        // state accumulation that causes waitpid deadlocks.

        if (raceResult.code !== 0 && raceResult.code !== null) {
            throw new Error(
                prepared.text || `Command exited with code ${raceResult.code}`
            );
        }

        return {
            content: [{ type: "text" as const, text: prepared.text }],
            details: preparedOutputDetails(prepared, logPath),
        };
    } finally {
        clearInterval(pollTimer);
        clearInterval(checkTimer);
        clearTimeout(timer);
        clearTimeout(hintTimer);
    }
}

// ─── Helpers used by executeTmuxForeground ──────────────────────────

import { checkExitCode, killWindow } from "../tmux.ts";
