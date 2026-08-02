/**
 * Background jobs feature — bash override, bash_bg, jobs, job_decide tools.
 *
 * Handles background process management, auto-timeout, stall detection,
 * and the pill-bar status widget.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ─── Context sidecar integration ────────────────────────────────────

/**
 * Hard cap on stored output per job (bytes).
 */
const SIDECAR_MAX_BYTES = 512 * 1024;

/** Default age (days) for purging sidecar entries at startup. */
const SIDECAR_PURGE_AGE_DAYS = 10;

/**
 * Build the path to the context sidecar's SQLite database.
 */
function sidecarDbPath(): string {
    const agentDir =
        process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return join(agentDir, "context.db");
}

/**
 * Purge sidecar entries older than `ageDays` days. Runs at startup to
 * prevent unbounded growth. Scoped to bash_bg entries since that's what
 * pi-tau owns.
 */
export function purgeSidecar(ageDays: number = SIDECAR_PURGE_AGE_DAYS): void {
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) return;

    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;

    try {
        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });
        try {
            // Select IDs to delete so we can log the count
            const toDelete = db
                .prepare(
                    `SELECT id FROM context_sources
                     WHERE tool_name = 'bash_bg'
                       AND created_at < ?`
                )
                .all(cutoff) as { id: string }[];

            if (toDelete.length === 0) {
                return;
            }

            // Delete chunks first (FTS triggers fire properly), then sources.
            // Use chunked batches to keep the WAL manageable.
            const ids = toDelete.map((r) => r.id);
            const batchSize = 100;
            for (let i = 0; i < ids.length; i += batchSize) {
                const batch = ids.slice(i, i + batchSize);
                const placeholders = batch.map(() => "?").join(",");

                db.prepare(
                    `DELETE FROM context_chunks WHERE source_id IN (${placeholders})`
                ).run(...batch);

                db.prepare(
                    `DELETE FROM context_sources WHERE id IN (${placeholders})`
                ).run(...batch);
            }

            // VACUUM to reclaim free pages (fast at startup — no concurrent
            // readers). For DBs with thousands of old entries this may take
            // ~100-500ms; acceptable at startup where overall init time is
            // dominated by model loading, not DB maintenance.
            db.prepare("VACUUM").run();

            // Minimal logging — visible in pi startup output
            console.error(
                `[tau] purged ${toDelete.length} sidecar entries older than ${ageDays} days, ` +
                `VACUUM reclaimed freed space`
            );
        } finally {
            db.close();
        }
    } catch (err) {
        console.error(
            `[tau] sidecar purge failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

/**
 * Look up a completed job's output from the context sidecar by job ID.
 * Returns the concatenated chunk content, or null if not found.
 */
export async function readJobOutputFromSidecar(jobId: string): Promise<string | null> {
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) return null;

    try {
        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });
        try {
            // Check if the source table exists
            const tableCheck = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='context_sources'"
                )
                .get();
            if (!tableCheck) {
                return null;
            }

            // Find source by jobId in input_summary, also get input_summary
            // for the log path reference.
            const source = db
                .prepare(
                    `SELECT id, input_summary FROM context_sources
                     WHERE tool_name = 'bash_bg'
                       AND json_extract(input_summary, '$.jobId') = ?
                     LIMIT 1`
                )
                .get(jobId) as { id: string; input_summary: string } | undefined;

            if (!source) {
                return null;
            }

            // Extract logPath from input_summary for the reference line
            let logPathRef = "";
            try {
                const summary = JSON.parse(source.input_summary);
                if (summary.logPath) {
                    logPathRef = `Log: ${summary.logPath}\n\n`;
                }
            } catch {
                // old records may lack logPath; skip
            }

            // Read all chunks for this source, ordered by ordinal
            const chunks = db
                .prepare(
                    `SELECT content FROM context_chunks
                     WHERE source_id = ?
                     ORDER BY ordinal ASC`
                )
                .all(source.id) as { content: string }[];

            if (chunks.length === 0) return null;
            return logPathRef + chunks.map((c) => c.content).join("\n\n");
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

/**
 * Split text into ~4 KiB chunks, matching the sidecar's chunk_text().
 */
export function chunkText(
    text: string,
    sourceId: string
): {
    id: string;
    sourceId: string;
    ordinal: number;
    title: string;
    content: string;
    byteCount: number;
}[] {
    const paragraphs = text.split(/\n{2,}/);
    const chunks: string[] = [];
    let current = "";
    const targetBytes = 4096;

    for (const paragraph of paragraphs) {
        if (Buffer.byteLength(paragraph, "utf8") > targetBytes) {
            if (current) chunks.push(current);
            // Split large paragraph by lines
            for (const line of paragraph.split("\n")) {
                const next = current ? `${current}\n${line}` : line;
                if (Buffer.byteLength(next, "utf8") <= targetBytes) {
                    current = next;
                } else {
                    if (current) chunks.push(current);
                    current = line;
                }
            }
            current = "";
            continue;
        }
        const next = current ? `${current}\n\n${paragraph}` : paragraph;
        if (Buffer.byteLength(next, "utf8") > targetBytes && current) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    if (chunks.length === 0) chunks.push(text);

    return chunks.map((content, index) => ({
        id: `${sourceId}_${String(index + 1).padStart(4, "0")}`,
        sourceId,
        ordinal: index + 1,
        title:
            content
                .split("\n")
                .find((l) => l.trim())
                ?.trim() ?? "(empty)",
        content,
        byteCount: Buffer.byteLength(content, "utf8"),
    }));
}

/**
 * Build a short preview from the first content lines.
 */
function makePreview(text: string): string {
    const lines = text.split("\n");
    const previewLines = lines.slice(0, 40);
    let result = previewLines.join("\n");
    if (Buffer.byteLength(result, "utf8") > 4096) {
        result = Buffer.from(result, "utf8").subarray(0, 4096).toString("utf8");
    }
    if (lines.length > 40) result += "\n...";
    return result;
}

/**
 * Index a completed job's output into the context sidecar SQLite database.
 *
 * Writes directly to the sidecar's context.db using the same schema so that
 * context_search / context_get / context_list can find the data.  Skips
 * silently if the DB or the sidecar tables don't exist (sidecar not loaded).
 *
 * Only stores output exceeding ~24 KiB / 300 lines to avoid bloating the
 * index with trivial results (matching the sidecar's own filtering).
 */
export async function indexJobOutputInSidecar(
    job: BackgroundJob,
    ctx: {
        cwd?: string;
        sessionManager?: {
            getSessionFile?: () => string | null;
            getSessionId?: () => string | null;
        };
    }
): Promise<void> {
    try {
        const text = await readFile(job.logPath, "utf-8").catch(() => "");
        if (!text) return;

        // Check output size before indexing
        const bytes = Buffer.byteLength(text, "utf8");
        const lines = text.split("\n").length;
        if (bytes > SIDECAR_MAX_BYTES) return;

        const sessionId =
            ctx?.sessionManager?.getSessionFile?.() ??
            ctx?.sessionManager?.getSessionId?.() ??
            null;
        const projectPath = ctx?.cwd ?? process.cwd();

        const dbPath = sidecarDbPath();
        if (!existsSync(dbPath)) {
            // Sidecar not installed or never initialized — skip
            return;
        }

        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });

        try {
            // Check if the source table exists (sidecar schema applied)
            const tableCheck = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='context_sources'"
                )
                .get();
            if (!tableCheck) {
                return;
            }

            // Dedup: skip if exact content hash already exists for this project
            const contentHash = createHash("sha256").update(text).digest("hex");
            const existing = db
                .prepare(
                    "SELECT id FROM context_sources WHERE content_hash = ? AND (project_path = ? OR project_path IS NULL) LIMIT 1"
                )
                .get(contentHash, projectPath);
            if (existing) {
                // Update returned byte count on the existing record
                db.prepare(
                    "UPDATE context_sources SET returned_byte_count = returned_byte_count + ? WHERE id = ?"
                ).run(bytes, existing.id);
                return;
            }

            // Generate a unique source ID matching the sidecar's format
            const sourceId = `ctx_bg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
            const createdAt = Date.now();
            const preview = makePreview(text);
            const previewBytes = Buffer.byteLength(preview, "utf8");
            const inputSummary = JSON.stringify({
                command: job.command,
                jobId: job.id,
                exitCode: job.exitCode,
                status: job.status,
                logPath: job.logPath,
            });

            // Insert source record
            db.prepare(
                `INSERT INTO context_sources
                 (id, session_id, project_path, tool_name, input_summary,
                  created_at, byte_count, line_count, content_hash,
                  preview_byte_count, returned_byte_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
            ).run(
                sourceId,
                sessionId,
                projectPath,
                "bash_bg",
                inputSummary,
                createdAt,
                bytes,
                lines,
                contentHash,
                previewBytes
            );

            // Insert chunks (FTS5 trigger auto-populates context_chunks_fts)
            const chunks = chunkText(text, sourceId);
            const insertChunk = db.prepare(
                `INSERT INTO context_chunks
                 (id, source_id, ordinal, title, content, byte_count)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );

            for (const chunk of chunks) {
                insertChunk.run(
                    chunk.id,
                    chunk.sourceId,
                    chunk.ordinal,
                    chunk.title,
                    chunk.content,
                    chunk.byteCount
                );
            }
        } finally {
            db.close();
        }
    } catch {
        // DB unavailable or schema mismatch — skip silently
    }
}
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import { cancelCallbacksForJob, hasLinkedCallbacksForJob, scheduleJobReminder } from "./callbacks.ts";
import type { BackgroundJob, RunningProcess, UiContext } from "../types.ts";
import {
    DEFAULT_TIMEOUT_MS,
    MAX_LOG_BYTES,
    MAX_OUTPUT_PREVIEW_CHARS,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
    STALL_THRESHOLD_MS,
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
    readTmuxOutput,
    spawnBackgroundTmux,
    spawnForegroundTmux,
    notifyTmuxCompletion,
} from "./bash-tmux.ts";
import { captureOutput } from "../tmux.ts";

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
            if (!looksLikePrompt(tail)) {
                lastGrowth = Date.now();
                return;
            }

            cancelled = true;
            clearInterval(timer);

            const summary =
                `Background job ${jobId} appears to be waiting for interactive input.\n` +
                `Command: ${command}\n\n` +
                `Last output:\n${tail.trimEnd()}\n\n` +
                `The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
                `with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;

            const suffix = outstandingJobsSuffix(state, jobId);
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
export interface FormatJobOutputResult {
    /** The formatted text output (numbered lines, hints footer). */
    text: string;
    /** Total number of matched lines before applying head/tail slice. */
    totalLines: number;
    /** Whether the input was truncated (content starts with "...[truncated"). */
    isTruncated: boolean;
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
export function formatJobOutput(params: FormatJobOutputParams): FormatJobOutputResult {
    const { text, grepPattern, headCount, tailCount } = params;

    // Filter lines (by grep or all)
    const lines = text.split("\n");
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
                isTruncated: false,
            };
        }
        matched = lines
            .map((l, i) => ({ line: l, num: i + 1 }))
            .filter(({ line }) => re.test(line));
    }

    const totalLines = matched.length;

    if (matched.length === 0) {
        const text = grepPattern
            ? `(no lines matching /${grepPattern}/i)`
            : "(no lines)";
        return { text, totalLines, isTruncated: false };
    }

    if (headCount !== undefined) matched = matched.slice(0, headCount);
    if (tailCount !== undefined) matched = matched.slice(-tailCount);

    const isTruncated = text.startsWith("...[truncated");

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
    if (isTruncated) {
        hints.push("output was truncated");
    }

    let result = body;
    if (hints.length > 0) {
        const suggestion = !grepPattern ? " or grep='pattern' to search" : "";
        result += `\n... (${hints.join(", ")}, use head=N or tail=N to see more${suggestion})`;
    }

    return { text: result, totalLines, isTruncated };
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

const BATCH_DEBOUNCE_MS = 2000;   // sliding window: each new completion resets this
const BATCH_MAX_DELAY_MS = 10000; // force flush this long after the first job in the batch

type CompletionBatchItem = {
    job: BackgroundJob;
    duration: string;
    emoji: string;
};

const completionBatch: {
    jobs: CompletionBatchItem[];
    timer?: NodeJS.Timeout;
    startTime: number;   // timestamp of the first job in the current batch
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

/** Count currently running background jobs (excluding any completed/failed/killed). */
function countOutstandingJobs(state: TauState): number {
    return Array.from(state.backgroundJobs.values()).filter(
        (j) => j.status === "running"
    ).length;
}

function flushCompletionBatch(): void {
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

function pruneConsumedCompletions(jobs: CompletionBatchItem[]): CompletionBatchItem[] {
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
					readFileSync(`/sys/class/drm/${entry}/device/gpu_busy_percent`, "utf-8").trim(),
					10
				);
				let temp = "";
				try {
					const hwmons = readdirSync("/sys/class/hwmon");
					for (const hw of hwmons) {
						try {
							const name = readFileSync(`/sys/class/hwmon/${hw}/name`, "utf-8").trim();
							if (name === "amdgpu" || name === "i915") {
								const t = parseInt(readFileSync(`/sys/class/hwmon/${hw}/temp1_input`, "utf-8").trim(), 10);
								temp = ` ${(t / 1000).toFixed(0)}C`;
								break;
							}
						} catch {}
					}
				} catch {}
				lines.push(`${entry}: ${busy}%${temp}`);
			} catch {}
		}
		return lines.length > 0 ? lines.join(", ") : null;
	} catch {
		return null;
	}
}

function deliverCompletionNotification(delivery: PendingCompletionDelivery): void {
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
        const resourceInfo = gpuLine
            ? `\nGPU: ${gpuLine}`
            : "";

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
    const resourceInfo = gpuLine
        ? `\nGPU: ${gpuLine}`
        : "";

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
    if (job.outputConsumed) return;

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

    // Defer the followUp message into a batch that flushes after a short debounce.
    // Suffix and outstanding count are computed at flush time from current state,
    // so they accurately reflect jobs still running outside this batch.
    completionBatch.jobs.push({ job, duration, emoji });
    completionBatch.pi = pi;
    completionBatch.state = state;

    // Sliding-window debounce: each new completion resets the timer, extending
    // the window to collect near-simultaneous completions into one message.
    // Cap total delay so the agent never waits longer than BATCH_MAX_DELAY_MS
    // from the first job in the batch.
    if (completionBatch.timer) {
        clearTimeout(completionBatch.timer);
    } else {
        completionBatch.startTime = Date.now();
    }
    const elapsed = Date.now() - completionBatch.startTime;
    const delay = Math.min(BATCH_DEBOUNCE_MS, BATCH_MAX_DELAY_MS - elapsed);
    completionBatch.timer = setTimeout(() => {
        flushCompletionBatch();
    }, Math.max(delay, 0));
    completionBatch.timer.unref();

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
        // Update job status before indexing so the sidecar captures final state
        job.exitCode = code ?? 0;
        job.status = code === 0 || code === null ? "completed" : "failed";
        // ctx is ExtensionContext at runtime but typed as UiContext here
        void indexJobOutputInSidecar(
            job,
            ctx as {
                cwd?: string;
                sessionManager?: {
                    getSessionFile?: () => string | null;
                    getSessionId?: () => string | null;
                };
            }
        );
        markJobTerminal(
            job,
            code === 0 || code === null ? "completed" : "failed",
            code ?? 0
        );
        clearPendingDecision(state, job);
        notifyCompletion(job, state, pi, ctx);
        updateWidget(state, ctx);    });

    ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
    updateWidget(state, ctx);

    return job;
}

// ── Default timeout timer (signal-based) ─────────────────────────────

/**
 * Start a timer that resolves the background signal after timeoutMs.
 * If the command is not auto-backgroundable, kills the process instead.
 * Returns the timer handle so it can be cleared on early completion.
 */
export function startTimeoutTimer(
    triggerBackground: () => void,
    command: string,
    state: TauState,
    toolCallId: string,
    explicitTimeoutMs?: number
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
        completionAgentBusy = true;
    });
    eventPi.on?.("agent_end", () => {
        completionAgentBusy = false;
        flushPendingCompletionDeliveries();
    });
    eventPi.on?.("session_shutdown", () => {
        completionAgentBusy = false;
        pendingCompletionDeliveries.length = 0;
        clearAllCompletionBatches();
    });

    // ── Override bash tool ─────────────────────────────────────────────

    const originalBashTool = createBashTool(process.cwd());

    pi.registerTool({
        ...originalBashTool,
        name: "bash",
        description:
            "Execute bash commands with streaming output. Commands that run longer than 2 minutes " +
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
        ],
        parameters: Type.Object({
            command: Type.String({
                description: "Bash command to execute",
            }),
            backgroundAfter: Type.Optional(
                Type.Number({
                    description:
                        "Background the command after this many seconds (default: auto, ~2 minutes). " +
                        "The command continues running in the background; use jobs/attach to monitor it.",
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
            const { command } = params;

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
            const proc = spawn("bash", ["-c", command], {
                stdio: ["pipe", logFd, logFd],
                cwd: ctx.cwd,
                detached: true,
                env: { ...process.env },
            });
            closeSync(logFd);

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
                    : undefined
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
                        const t = setTimeout(
                            resolve,
                            2_000
                        ) as unknown as NodeJS.Timeout;
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
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: output || "(no output)",
                            },
                        ],
                        details: undefined,
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
                                `Use the job_decide tool with jobId "${job.id}" to decide:\n` +
                                `- decision "check": inspect the output first\n` +
                                `- decision "keep": let it continue running\n` +
                                `- decision "kill": terminate it\n\n` +
                                `Use jobs action "attach" with a timeout to monitor its progress with periodic updates.`,
                            display: true,
                            details: {
                                jobId: job.id,
                                logPath: job.logPath,
                                command,
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

                if (
                    raceResult.code !== 0 &&
                    raceResult.code !== null &&
                    !raceResult.interrupted
                ) {
                    throw new Error(
                        output || `Command exited with code ${raceResult.code}`
                    );
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: output || "(no output)",
                        },
                    ],
                    details: undefined,
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
            "Large output (~24 KiB+) is automatically indexed in the context sidecar SQLite database " +
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
            "Large output (~24 KiB+) is automatically indexed in the context sidecar. " +
                "Use context_search with tool_name='bash_bg' to find past job output, " +
                "or context_list with tool_name='bash_bg' to see recent indexed job runs.",
        ],
        parameters: Type.Object({
            command: Type.String({
                description: "Command to run in background",
            }),
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
        ): Promise<AgentToolResult<undefined>> {
            const shouldNotify = params.notify !== false;

            // ── Tmux path ─────────────────────────────────────────────
            if (state.tmuxAvailable) {
                const job = spawnBackgroundTmux(
                    params.command,
                    ctx.cwd,
                    toolCallId,
                    state,
                    pi,
                    ctx,
                    (jobId, command, logPath) =>
                        startStallWatchdog(jobId, command, logPath, pi, state, () => {
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
                        })
                );

                updateWidget(state, ctx);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Started background job ${job.id}\nCommand: ${params.command}\nOutput: ${job.logPath}`,
                        },
                    ],
                    details: undefined,
                };
            }

            // ── Direct spawn path (fallback) ──────────────────────────
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);

            const logFd = openSync(logPath, "w");
            const proc = spawn("bash", ["-c", params.command], {
                stdio: ["pipe", logFd, logFd],
                cwd: ctx.cwd,
                detached: true,
                env: { ...process.env },
            });
            closeSync(logFd);

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
                        job.status = "killed";
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
                void indexJobOutputInSidecar(
                    job,
                    ctx as {
                        cwd?: string;
                        sessionManager?: {
                            getSessionFile?: () => string | null;
                            getSessionId?: () => string | null;
                        };
                    }
                );
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            });

            proc.on("error", () => {
                cancelStall();
                if (killTimer) clearTimeout(killTimer);
                killTimer = undefined;
                markJobTerminal(job, "failed");
                void indexJobOutputInSidecar(
                    job,
                    ctx as {
                        cwd?: string;
                        sessionManager?: {
                            getSessionFile?: () => string | null;
                            getSessionId?: () => string | null;
                        };
                    }
                );
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            });

            updateWidget(state, ctx);

            // Build summary line for reminders / timeout
            let extra = "";
            if (killTimer) {
                extra += `\nKill deadline: ${params.timeout}s`;
            }
            if (reminderId) {
                extra += `\nReminder: ${reminderId} (in ${params.remindIn})`;
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
                details: undefined,
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
            _ctx
        ): Promise<AgentToolResult<undefined>> {
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
                                    }\nLog: ${job.logPath}\n\n${formatted}`,
                                },
                            ],
                            details: undefined,
                        };
                    }

                    // Fall back to sidecar for completed jobs (persists across sessions)
                    const sidecarOutput = await readJobOutputFromSidecar(
                        params.jobId
                    );
                    if (sidecarOutput) {
                        const formatted = formatJobOutput({
                            text: sidecarOutput,
                            grepPattern,
                            headCount,
                            tailCount,
                        });
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
                                    }\n\n${formatted}`,
                                },
                            ],
                            details: undefined,
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
                        details: undefined,
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
                            details: undefined,
                        };
                    }

                    // Ensure donePromise exists
                    if (!job.donePromise) createJobDonePromise(job);

                    const POLL_INTERVAL_MS = 5_000;
                    const MAX_ATTACH_MS = (params.timeout ?? 600) * 1_000;
                    const deadline = Date.now() + MAX_ATTACH_MS;

                    // Non-blocking poll loop with progress updates.
                    // Polls periodically; exits promptly when the job completes
                    // (via donePromise race), the signal is aborted, or the
                    // timeout expires.
                    while (job.status === "running") {
                        // Check abort signal
                        if (signal?.aborted) {
                            break;
                        }

                        // Check timeout
                        if (Date.now() >= deadline) {
                            break;
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
                            details: undefined,
                        });

                        // Wait for either the next poll interval or job completion
                        await Promise.race([
                            new Promise<void>((resolve) =>
                                setTimeout(resolve, POLL_INTERVAL_MS)
                            ),
                            job.donePromise,
                        ]);
                    }

                    // Read final output
                    const output = await readOutputTail(
                        job.logPath,
                        MAX_OUTPUT_PREVIEW_CHARS
                    );
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
                            details: undefined,
                        };
                    }

                    if (Date.now() >= deadline) {
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
                            details: undefined,
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
                        details: undefined,
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
        ): Promise<AgentToolResult<undefined>> {
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
                    details: undefined,
                };
            }

            switch (params.decision) {
                case "kill": {
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
                        details: undefined,
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
                        details: undefined,
                    };
                }
                case "check": {
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
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Output of ${job.id}:\n${output}`,
                            },
                        ],
                        details: undefined,
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
    (pi as ExtensionAPI & {
        registerToolPromptGuidelines: (toolName: string, guidelines: string[]) => void;
    }).registerToolPromptGuidelines("remind", [
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
        const result = spawnForegroundTmux(command, ctx.cwd);
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

    // Timeout timer
    const timeoutMs =
        typeof params.timeout === "number"
            ? params.timeout * 1_000
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

    // Completion polling — check the exit-code sentinel
    const completionPromise = new Promise<number | null>((resolve) => {
        const check = setInterval(() => {
            const code = checkExitCode(tmuxCtx.exitCodeFile);
            if (code !== undefined) {
                clearInterval(check);
                resolve(code);
            }
        }, 200);
        check.unref();
    });

    try {
        // Wait for initial output or quick completion (2s threshold)
        const initialResult = await Promise.race([
            completionPromise,
            new Promise<null>((resolve) => {
                const t = setTimeout(
                    resolve,
                    2_000
                ) as unknown as NodeJS.Timeout;
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
            // Clean up tmux window. Keep the session alive so the next
            // spawnInTmux call reuses it via new-window instead of creating
            // a fresh session — avoids tmux server state accumulation across
            // hundreds of create/destroy cycles which causes fork()+waitpid()
            // deadlocks (child exits but parent waitpid never returns).
            killWindow(tmuxCtx.windowId);
            if (initialResult !== 0 && initialResult !== null) {
                throw new Error(
                    output || `Command exited with code ${initialResult}`
                );
            }
            return {
                content: [
                    { type: "text" as const, text: output || "(no output)" },
                ],
                details: undefined,
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
            clearTimeout(timer);
            clearTimeout(hintTimer);
            state.runningProcesses.delete(toolCallId);

            // Mark as backgrounded — the completion poller in bash-tmux will handle notification.
            // Start the background completion poller.
            job.isBackgrounded = true;
            state.currentlyRunningToolCallId = null;

            // Start stall watchdog
            startStallWatchdog(jobId, command, logPath, pi, state, () => {
                killTmuxJob(job);
            });

            // Start background completion poller
            const bgPoller = setInterval(() => {
                const result = pollTmuxCompletion(job);
                if (!result.completed) return;
                clearInterval(bgPoller);
                markJobTerminal(
                    job,
                    result.exitCode === 0 || result.exitCode === null
                        ? "completed"
                        : "failed",
                    result.exitCode ?? 0
                );
                notifyTmuxCompletion(job, state, pi, ctx);
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
                        `Use the job_decide tool with jobId "${jobId}" to decide:\n` +
                        `- decision "check": inspect the output first\n` +
                        `- decision "keep": let it continue running\n` +
                        `- decision "kill": terminate it\n\n` +
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
        killWindow(tmuxCtx.windowId);
        // Session is intentionally kept alive — reuse avoids tmux server
        // state accumulation that causes waitpid deadlocks.

        if (raceResult.code !== 0 && raceResult.code !== null) {
            throw new Error(
                output || `Command exited with code ${raceResult.code}`
            );
        }

        return {
            content: [{ type: "text" as const, text: output || "(no output)" }],
            details: undefined,
        };
    } finally {
        clearInterval(pollTimer);
        clearTimeout(timer);
        clearTimeout(hintTimer);
    }
}

// ─── Helpers used by executeTmuxForeground ──────────────────────────

import { checkExitCode, killWindow } from "../tmux.ts";
