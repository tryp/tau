/**
 * Background agent — spawn a detached pi process for autonomous task execution.
 *
 * Extracts the original prompt and last assistant message from the session,
 * constructs a continuation prompt, and spawns a detached pi process.
 *
 * Small persisted sessions can be forked after the parent agent has settled;
 * in-memory sessions and large sessions use the summary-only fallback.
 */

import { spawn } from "node:child_process";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import type {
    BackgroundJob,
    JobResultDetails,
    PendingBackgroundAgent,
} from "../types.ts";
import {
    createJobDonePromise,
    generateJobId,
    killProcessGroup,
    logPathForJob,
    markJobTerminal,
} from "../utils.ts";
import {
    silenceJobAfterKill,
    startStallWatchdog,
    clearPendingDecision,
    notifyCompletion,
    updateWidget,
    installSpawnErrorHandler,
    resolveExecutionCwd,
    validateWorkingDirectory,
    jobDetails,
} from "./background.ts";
import { trackJobOutputIndex } from "./sidecar.ts";

interface AgentProcessOptions {
    mode: "fork" | "summary";
    promptFile: string;
    execCwd: string;
    sessionFile?: string;
    modelArg?: string;
    thinkingLevel?: string;
}

// ─── Context continuity ─────────────────────────────────────────────

/** Maximum fraction of context window that a forked session can consume. */
const MAX_CONTEXT_FRACTION = 0.4;

/** Cap on the original user prompt inherited by a background agent. */
export const ORIGINAL_PROMPT_MAX_CHARS = 6000;
/** Cap on the last assistant summary inherited by a background agent. */
export const LAST_SUMMARY_MAX_CHARS = 6000;

/**
 * Choose between fork-and-resume and summary-only.
 * Below MAX_CONTEXT_FRACTION, fork would be safe — the agent has room to continue.
 * Above, summary-only gives it more context headroom.
 *
 * A fork is only valid when the current session is persisted. The caller
 * defers the actual fork until the parent is idle after `agent_end`.
 */
export function chooseBackgroundPath(
    conversationBytes: number,
    contextWindowTokens: number,
    hasSessionFile = true
): "fork" | "summary" {
    if (!hasSessionFile || contextWindowTokens <= 0) return "summary";
    const estimatedTokens = conversationBytes / 4;
    const fraction = estimatedTokens / contextWindowTokens;
    return fraction < MAX_CONTEXT_FRACTION ? "fork" : "summary";
}

/** Build CLI arguments for the selected background-agent execution mode. */
export function buildBackgroundSpawnArgs(options: {
    mode: "fork" | "summary";
    sessionFile?: string;
    modelArg?: string;
    thinkingLevel?: string;
    promptFile: string;
}): string[] {
    if (options.mode === "fork" && !options.sessionFile) {
        throw new Error("Fork mode requires a persisted session file");
    }

    return [
        ...(options.mode === "fork" ? ["--fork", options.sessionFile!] : []),
        "-p",
        "--mode",
        "text",
        ...(options.modelArg ? ["--model", options.modelArg] : []),
        ...(options.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
        `@${options.promptFile}`,
    ];
}

/** Messages that carry a content field (user/assistant/toolResult). */
export interface ContentMessage {
    role: string;
    content: string | { type: string; text?: string }[];
}

/** Type guard: does this session entry carry a message with a content field? */
function isContentMessageEntry(
    entry: SessionEntry
): entry is SessionEntry & { message: ContentMessage } {
    if (entry.type !== "message") return false;
    if (!("message" in entry)) return false;
    const msg = (entry as { message: unknown }).message;
    if (typeof msg !== "object" || msg === null) return false;
    return "content" in msg;
}

/** Extract text from a content field (string or array of content blocks). */
export function extractTextFromContent(
    content: string | { type: string; text?: string }[]
): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (b): b is { type: string; text: string } =>
                typeof b === "object" &&
                b !== null &&
                b.type === "text" &&
                typeof b.text === "string"
        )
        .map((b) => b.text)
        .join("\n");
}

/**
 * Extract the last assistant message text from session entries.
 */
export function extractLastAssistantSummary(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (
            isContentMessageEntry(entry) &&
            entry.message.role === "assistant"
        ) {
            return extractTextFromContent(entry.message.content).slice(
                -LAST_SUMMARY_MAX_CHARS
            );
        }
    }
    return "";
}

/**
 * Extract the original user prompt from session entries.
 */
export function extractOriginalPrompt(entries: SessionEntry[]): string {
    for (const entry of entries) {
        if (isContentMessageEntry(entry) && entry.message.role === "user") {
            return extractTextFromContent(entry.message.content).slice(
                0,
                ORIGINAL_PROMPT_MAX_CHARS
            );
        }
    }
    return "";
}

/**
 * Estimate the byte size of the conversation from session entries.
 */
export function estimateConversationBytes(entries: SessionEntry[]): number {
    let bytes = 0;
    for (const entry of entries) {
        if (isContentMessageEntry(entry)) {
            bytes += Buffer.byteLength(
                extractTextFromContent(entry.message.content),
                "utf8"
            );
        }
    }
    return bytes;
}

// ─── Feature registration ───────────────────────────────────────────

export function registerAgentBackground(
    pi: ExtensionAPI,
    state: TauState
): void {
    const failAgentStart = (
        job: BackgroundJob,
        promptFile: string,
        ctx: ExtensionContext,
        error: unknown
    ): void => {
        const message = error instanceof Error ? error.message : String(error);
        try {
            writeFileSync(
                job.logPath,
                `Failed to start background agent: ${message}\n`
            );
        } catch {
            /* preserve the original lifecycle result if logging fails */
        }
        markJobTerminal(job, "failed", 1);
        void trackJobOutputIndex(job, ctx, "agent_bg");
        clearPendingDecision(state, job);
        notifyCompletion(job, state, pi, ctx);
        updateWidget(state, ctx);
        try {
            unlinkSync(promptFile);
        } catch {
            /* already gone */
        }
    };

    const startAgentProcess = (
        job: BackgroundJob,
        options: AgentProcessOptions,
        ctx: ExtensionContext
    ): void => {
        if (job.status !== "running") return;

        const mode =
            options.mode === "fork" &&
            options.sessionFile &&
            existsSync(options.sessionFile)
                ? "fork"
                : "summary";
        const spawnArgs = buildBackgroundSpawnArgs({
            mode,
            sessionFile: options.sessionFile,
            modelArg: options.modelArg,
            thinkingLevel: options.thinkingLevel,
            promptFile: options.promptFile,
        });

        let proc: ReturnType<typeof spawn>;
        try {
            validateWorkingDirectory(options.execCwd);
            proc = spawn("pi", spawnArgs, {
                cwd: options.execCwd,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
            installSpawnErrorHandler(proc);
        } catch (error) {
            failAgentStart(job, options.promptFile, ctx, error);
            return;
        }

        if (!proc.pid) {
            failAgentStart(
                job,
                options.promptFile,
                ctx,
                new Error("Failed to spawn background agent process")
            );
            return;
        }

        job.pid = proc.pid;
        job.proc = proc;

        const logStream = createWriteStream(job.logPath, { flags: "w" });
        let logStreamFinish: Promise<void> | undefined;
        const finishLogStream = (): Promise<void> => {
            if (!logStreamFinish) {
                logStreamFinish = new Promise((resolve) => {
                    logStream.once("finish", resolve);
                    logStream.end();
                });
            }
            return logStreamFinish;
        };
        proc.stdout?.pipe(logStream, { end: false });
        proc.stderr?.pipe(logStream, { end: false });

        const cancelStall = startStallWatchdog(
            job.id,
            job.command,
            job.logPath,
            pi,
            state,
            () => {
                if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                silenceJobAfterKill(job);
            }
        );

        let finalized = false;
        const finalizeAgentJob = (code: number | null, failed = false) => {
            if (finalized) return;
            finalized = true;
            markJobTerminal(
                job,
                failed || (code !== 0 && code !== null)
                    ? "failed"
                    : "completed",
                code ?? undefined
            );
            void trackJobOutputIndex(job, ctx, "agent_bg", finishLogStream());
            clearPendingDecision(state, job);
            notifyCompletion(job, state, pi, ctx);
            updateWidget(state, ctx);
            try {
                unlinkSync(options.promptFile);
            } catch {
                /* already gone */
            }
        };

        proc.on("close", (code) => {
            cancelStall();
            finalizeAgentJob(code);
        });

        proc.on("error", () => {
            cancelStall();
            finalizeAgentJob(1, true);
        });
    };

    let settlementScheduled = false;
    const startPendingAgents = (ctx: ExtensionContext, attempt = 0): void => {
        settlementScheduled = false;
        if (state.pendingBackgroundAgents.size === 0) return;

        // pi 0.74 exposes agent_end but not agent_settled. Wait until the
        // event loop reports idle so the current tool result and any queued
        // continuation have finished writing the session JSONL.
        const settled = ctx.isIdle();
        if (!settled && attempt < 100) {
            settlementScheduled = true;
            const timer = setTimeout(
                () => startPendingAgents(ctx, attempt + 1),
                10
            );
            timer.unref();
            return;
        }

        const pending = Array.from(state.pendingBackgroundAgents.values());
        state.pendingBackgroundAgents.clear();
        for (const request of pending) {
            const job = state.backgroundJobs.get(request.jobId);
            if (!job) {
                try {
                    unlinkSync(request.promptFile);
                } catch {
                    /* already gone */
                }
                continue;
            }
            if (job.status !== "running") {
                try {
                    unlinkSync(request.promptFile);
                } catch {
                    /* already gone */
                }
                continue;
            }

            // Re-read after settlement. This guarantees --fork sees a complete
            // JSONL session, including the agent_bg tool result.
            const sessionFile = ctx.sessionManager.getSessionFile();
            startAgentProcess(
                job,
                {
                    // If the compatibility idle check never settled within
                    // the bounded wait, summary mode is safe; raw forking is
                    // not safe against an active JSONL writer.
                    mode: settled && sessionFile ? "fork" : "summary",
                    promptFile: request.promptFile,
                    execCwd: request.execCwd,
                    sessionFile: sessionFile ?? undefined,
                    modelArg: request.modelArg,
                    thinkingLevel: request.thinkingLevel,
                },
                ctx
            );
            updateWidget(state, ctx);
        }
    };

    pi.on("agent_end", async (_event, ctx) => {
        if (settlementScheduled || state.pendingBackgroundAgents.size === 0) {
            return;
        }
        settlementScheduled = true;
        const timer = setTimeout(() => startPendingAgents(ctx), 0);
        timer.unref();
    });

    pi.on("session_shutdown", async () => {
        for (const request of state.pendingBackgroundAgents.values()) {
            const job = state.backgroundJobs.get(request.jobId);
            if (job) silenceJobAfterKill(job);
            try {
                unlinkSync(request.promptFile);
            } catch {
                /* already gone */
            }
        }
        state.pendingBackgroundAgents.clear();
    });

    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description:
            "Spawn a separate pi process to handle a task in the background. " +
            "Constructs a continuation prompt from the current conversation " +
            "context and the specified task. " +
            "Use the jobs tool to check status and read output.",
        promptSnippet:
            "Delegate a task to a background pi process with context continuity",
        promptGuidelines: [
            "Use agent_bg for tasks that can run independently without the current conversation.",
            "The background agent gets a summary of the original task and where you left off.",
            "Use the jobs tool to check on progress. You will be notified when it finishes.",
            "The result details include jobId, status, and logPath; completed output is indexed with sourceId/chunkIds for context-sidecar retrieval when available.",
        ],
        parameters: Type.Object({
            prompt: Type.String({
                description: "Task for the background agent",
            }),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "Working directory (defaults to current directory)",
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
            if (!isFeatureEnabled(state, "agent-background")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Agent background is disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }

            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);
            mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });

            const entries = ctx.sessionManager.getEntries();
            const conversationBytes = estimateConversationBytes(entries);
            const contextUsage = ctx.getContextUsage();
            const contextWindowTokens =
                contextUsage?.contextWindow ??
                ctx.model?.contextWindow ??
                state.contextWindowTokens ??
                32_768;
            const sessionFile = ctx.sessionManager.getSessionFile();
            const measuredBytes =
                contextUsage?.tokens !== null &&
                contextUsage?.tokens !== undefined
                    ? contextUsage.tokens * 4
                    : conversationBytes;
            const path = chooseBackgroundPath(
                measuredBytes,
                contextWindowTokens,
                Boolean(sessionFile)
            );

            const summary = extractLastAssistantSummary(entries);
            const originalPrompt = extractOriginalPrompt(entries);
            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "",
                "## Original task",
                params.prompt,
                ...(originalPrompt
                    ? ["", "## Previous user context", originalPrompt]
                    : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "",
                "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${tmpdir()}/pi-bg-prompt-${jobId}.md`;
            writeFileSync(promptFile, promptContent);

            const model = ctx.model;
            const modelArg = model
                ? `${model.provider}/${model.id}`
                : undefined;
            const thinkingLevel = (
                ctx as ExtensionContext & { thinkingLevel?: string }
            ).thinkingLevel;
            const execCwd = resolveExecutionCwd(params.cwd, ctx.cwd);
            validateWorkingDirectory(execCwd);

            const job: BackgroundJob = {
                id: jobId,
                command: `pi -p (background agent)`,
                // A fork is queued until the parent settles and receives its real
                // PID then. Zero is intentionally omitted from jobDetails().
                pid: 0,
                startTime: Date.now(),
                status: "running",
                logPath,
                toolCallId,
                isBackgrounded: true,
            };
            createJobDonePromise(job);
            state.backgroundJobs.set(jobId, job);

            if (path === "fork") {
                const pending: PendingBackgroundAgent = {
                    jobId,
                    promptFile,
                    execCwd,
                    modelArg,
                    thinkingLevel,
                    sessionFile: sessionFile ?? undefined,
                    conversationBytes,
                    contextWindowTokens,
                };
                state.pendingBackgroundAgents.set(jobId, pending);
            } else {
                startAgentProcess(
                    job,
                    {
                        mode: "summary",
                        promptFile,
                        execCwd,
                        modelArg,
                        thinkingLevel,
                    },
                    ctx
                );
            }
            updateWidget(state, ctx);

            const pathLabel =
                path === "fork" ? "fork-and-resume (queued)" : "summary-only";
            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Started background agent ${jobId} (${pathLabel})\n` +
                            `Prompt: ${params.prompt.slice(0, 100)}${params.prompt.length > 100 ? "…" : ""}\n` +
                            `PID: ${job.pid > 0 ? job.pid : "pending"}\n` +
                            `Output: ${logPath}\n` +
                            `Context: ${(conversationBytes / 1024).toFixed(0)} KB / ${contextWindowTokens} tokens`,
                    },
                ],
                details: jobDetails(job),
            };
        },
    });
}
