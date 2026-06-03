/**
 * Background jobs feature — bash override, bash_bg, jobs, job_decide tools.
 *
 * Handles background process management, auto-timeout, stall detection,
 * and the pill-bar status widget.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ─── Context sidecar integration ────────────────────────────────────

/**
 * Minimum output size (bytes or lines) required before we bother indexing.
 * Matches the sidecar's DEFAULT_CONTEXT_MAX_BYTES / MAX_LINES thresholds
 * so we only store output that the sidecar considers worth indexing.
 */
const SIDECAR_MIN_BYTES = 24 * 1024;
const SIDECAR_MIN_LINES = 300;

/**
 * Hard cap on stored output per job (bytes).
 */
const SIDECAR_MAX_BYTES = 512 * 1024;

/**
 * Build the path to the context sidecar's SQLite database.
 */
function sidecarDbPath(): string {
    const agentDir =
        process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return join(agentDir, "context.db");
}

/**
 * Split text into ~4 KiB chunks, matching the sidecar's chunk_text().
 */
function chunkText(
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
async function indexJobOutputInSidecar(
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

        // Match the sidecar's should_index_text check: only store output that
        // exceeds the minimum thresholds.
        const bytes = Buffer.byteLength(text, "utf8");
        const lines = text.split("\n").length;
        if (bytes < SIDECAR_MIN_BYTES && lines < SIDECAR_MIN_LINES) return;
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
                db.close();
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
                db.close();
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
import { cancelCallbacksForJob, scheduleJobReminder } from "./callbacks.ts";
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
                pi.sendMessage(
                    {
                        customType: "bg-stall",
                        content: `⚠️ Background job ${jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.`,
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

            pi.sendMessage(
                {
                    customType: "bg-stall",
                    content: `⚠️ ${summary}`,
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
const MAX_RECENT_TERMINAL = 20;

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

/** Send a structured completion notification to the agent. */
export function notifyCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    // Auto-cancel any callbacks linked to this job
    cancelCallbacksForJob(job.id);

    if (job.outputConsumed) {
        removeJob(state, job);
        return;
    }
    const duration = formatDuration(Date.now() - job.startTime);
    const emoji = job.status === "completed" ? "✅" : "❌";
    const statusText = `Background ${job.id} ${job.status} (${duration})`;
    const exitCodeText =
        job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

    ctx.ui.notify(statusText, job.status === "completed" ? "success" : "error");

    pi.sendMessage(
        {
            customType: "job-completion",
            content:
                `${emoji} ${statusText}\n` +
                `Command: ${job.command}\n` +
                `Output: ${job.logPath}${exitCodeText}`,
            display: true,
            details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exitCode,
                duration,
                command: job.command,
                logPath: job.logPath,
            },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );

    removeJob(state, job);
}

// ── Background a running foreground process (signal-based) ─────────

/**
 * Register a foreground process as a background job, start stall watchdog,
 * and set up completion handlers. Called when the background signal wins
 * the Promise.race (timeout or Ctrl+B).
 */
function registerBackgroundJob(
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

    const cancelStall = startStallWatchdog(jobId, command, logPath, pi, () => {
        if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
        silenceJobAfterKill(job);
    });

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
    });

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
        if (state.currentlyRunningToolCallId !== toolCallId) return;

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

            // Prepare log file — output goes here from the start
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

                    state.pendingDecisionJobId = job.id;

                    const duration = formatDuration(
                        typeof params.backgroundAfter === "number"
                            ? params.backgroundAfter * 1_000
                            : DEFAULT_TIMEOUT_MS
                    );
                    pi.sendMessage(
                        {
                            customType: "bg-timeout",
                            content:
                                `⏰ Command timed out after ${duration} and has been backgrounded as ${job.id}.\n` +
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
            "Run a bash command in background immediately. Output is written to a per-session log file. " +
            "Use the jobs tool to check status and read output. " +
            "Large output (~24 KiB+) is automatically indexed in the context sidecar SQLite database " +
            "and is searchable via context_search, context_list, and context_get. " +
            "Optionally set a kill deadline (timeout), schedule an inline reminder (remindIn), or both.",
        promptSnippet:
            "Run bash command in background immediately" +
            " (supports kill deadline and inline reminder)",
        promptGuidelines: [
            "Use bash_bg when you want to start a long-running command in background immediately.",
            "This is different from regular bash + Ctrl+Shift+B — bash_bg backgrounds from the start.",
            "Use timeout to set a kill deadline: the job is terminated if it runs longer than N seconds.",
            "Use remindIn to schedule a reminder callback (auto-cancels if the job finishes first).",
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
            remindIn: Type.Optional(
                Type.String({
                    description:
                        "Schedule a reminder callback after this duration (e.g. \"5m\", \"30s\", \"2h\"). " +
                        "The reminder auto-cancels if the job completes before it fires.",
                })
            ),
            remindMessage: Type.Optional(
                Type.String({
                    description:
                        "Message for the reminder callback (default: \"check on <command>\"). " +
                        "Only used when remindIn is set.",
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
            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);
            const shouldNotify = params.notify !== false;

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
            if (params.remindIn) {
                const msg =
                    params.remindMessage ??
                    `check on: ${params.command.slice(0, 80)}`;
                const rid = scheduleJobReminder(jobId, params.remindIn, msg);
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
            "(default 10 min) prevents indefinite blocking.",
        promptSnippet: "Manage background jobs (list/output/kill/attach)",
        promptGuidelines: [
            "Use jobs with action 'list' to see all background jobs.",
            "Use jobs with action 'output' to read a job's output from its log file.",
            "Use jobs with action 'kill' to terminate a running background job (also cancels linked reminders).",
            "Use jobs with action 'attach' to monitor a running job with progress polling; " +
                "attach is safe to use — it will not block indefinitely (has a timeout).",
            "Use the optional 'timeout' parameter (seconds) to control how long to wait; " +
                "default is 600 (10 minutes).",
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
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);
                    const output = await readOutputTail(
                        job.logPath,
                        MAX_OUTPUT_PREVIEW_CHARS
                    );
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Output for ${job.id} (${job.status})\nLog: ${job.logPath}\n\n${output}`,
                            },
                        ],
                        details: undefined,
                    };
                }

                case "kill": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=kill");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);
                    if (job.status !== "running" || !job.proc) {
                        throw new Error(`Job is not running: ${job.id}`);
                    }
                    killProcessGroup(job.proc.pid!, "SIGTERM");
                    silenceJobAfterKill(job);
                    clearPendingDecision(state, job);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Sent SIGTERM to ${job.id} (process group)`,
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
                    if (job.proc && job.status === "running") {
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
}
