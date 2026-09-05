/**
 * Tmux-backed bash execution backend.
 *
 * Spawns commands inside tmux windows instead of direct child processes.
 * This eliminates the foreground→background output race window (tmux owns
 * the process lifecycle) and lets users attach to running commands with
 * `tmux attach`.
 *
 * Used by background.ts when tmux is available. Falls back to direct
 * child-process spawning when tmux is absent.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { BackgroundJob, UiContext } from "../types.ts";
import {
    createJobDonePromise,
    markJobTerminal,
    readOutputTail,
} from "../utils.ts";
import {
    captureOutput,
    checkExitCode,
    getGitRoot,
    killWindow,
    sessionNameForGitRoot,
    spawnInTmux,
} from "../tmux.ts";
import { trackJobOutputIndex } from "./sidecar.ts";

/** Per-run directory for exit-code sentinels and output files. */
function runDirPath(): string {
    const dir = `/tmp/pi-tmux-${process.pid}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/** Clean up the run directory on shutdown. Preserves output files for running jobs. */
export function cleanupTmuxRunDir(): void {
    const dir = `/tmp/pi-tmux-${process.pid}`;
    // Don't remove the run directory if there are still running tmux jobs.
    // The sentinel files and output need to stay alive for the completion poller.
    // Instead, clean up only the script directory.
    const scriptDir = join(dir, "s");
    try {
        rmSync(scriptDir, { recursive: true, force: true });
    } catch {
        /* already gone */
    }
}

/** Clean up run directories from dead pi processes. Called on session startup. */
export function cleanupStaleTmuxRunDirs(): void {
    const entries = readdirSync("/tmp").filter((e) => e.startsWith("pi-tmux-"));
    for (const entry of entries) {
        const pid = parseInt(entry.replace("pi-tmux-", ""), 10);
        // Skip our own process
        if (pid === process.pid) continue;
        // Check if the process is still alive
        try {
            process.kill(pid, 0);
            continue; // alive — don't touch
        } catch {
            // dead — clean up
        }
        const dir = join("/tmp", entry);
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* permission error or concurrent cleanup */
        }
        // Also kill any tmux session that belonged to this dead process.
        // Sessions are named pi-bg-<slug>-<hash>, but we can't derive the name
        // from the PID alone. Instead, kill sessions whose panes are all dead.
    }
    // Kill orphaned pi-bg sessions (all panes dead)
    try {
        const sessions = execSync("tmux list-sessions -F '#{session_name}'", {
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "pipe"],
        })
            .trim()
            .split("\n")
            .filter((s) => s.startsWith("pi-bg-"));
        for (const session of sessions) {
            const panePids = execSync(
                `tmux list-panes -t ${session} -F '#{pane_pid}'`,
                {
                    encoding: "utf-8",
                    timeout: 3000,
                    stdio: ["ignore", "pipe", "pipe"],
                }
            )
                .trim()
                .split("\n")
                .map((p) => parseInt(p, 10));
            const allDead = panePids.every((pid) => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            });
            if (allDead) {
                execSync(`tmux kill-session -t ${session}`, {
                    timeout: 3000,
                    stdio: "ignore",
                });
            }
        }
    } catch {
        /* tmux not available or no sessions */
    }
}

/**
 * Context for a tmux-backed running command.
 * Stored on the BackgroundJob so the tmux backend can manage the window lifecycle.
 */
export interface TmuxJobContext {
    /** The tmux session name. */
    session: string;
    /** The tmux window ID (e.g. "@3"). */
    windowId: string;
    /** The exit-code sentinel file path. */
    exitCodeFile: string;
    /** The output file path (tee'd from the command). */
    outputFile: string;
    /** The git root (used for session scoping). */
    gitRoot: string;
}

/**
 * Attach tmux context to a job so kill/completion can find it later.
 */
export function attachTmuxContext(
    job: BackgroundJob,
    ctx: TmuxJobContext
): void {
    (job as unknown as { tmux: TmuxJobContext }).tmux = ctx;
}

/**
 * Retrieve the tmux context from a job, if any.
 */
export function getTmuxContext(job: BackgroundJob): TmuxJobContext | undefined {
    return (job as unknown as { tmux?: TmuxJobContext }).tmux;
}

/**
 * Poll for exit-code completion of a tmux-backed background job.
 * Called by the stall watchdog tick to detect completed commands.
 */
export function pollTmuxCompletion(job: BackgroundJob): {
    completed: boolean;
    exitCode?: number;
} {
    const ctx = getTmuxContext(job);
    if (!ctx) return { completed: false };

    const code = checkExitCode(ctx.exitCodeFile);
    if (code === undefined) return { completed: false };

    return { completed: true, exitCode: code };
}

/**
 * Spawn/setup-phase failure for the tmux backend (no git root, tmux server
 * error). The foreground bash tool treats these as the only signal to fall
 * through to the direct-spawn path. Errors raised after the command has
 * started executing in tmux (timeout-killed, aborted, stalled, non-zero
 * exit) are terminal and must never be re-run on the direct path.
 */
export class TmuxSpawnError extends Error {}

/**
 * Kill a tmux-backed job by killing its tmux window.
 */
export function killTmuxJob(job: BackgroundJob): void {
    const ctx = getTmuxContext(job);
    if (ctx) killWindow(ctx.windowId);
}

/**
 * Read output from a tmux-backed job.
 */
export function readTmuxOutput(
    job: BackgroundJob,
    maxChars: number
): Promise<string> {
    const ctx = getTmuxContext(job);
    if (ctx) {
        const output = captureOutput(ctx.windowId, 2000, ctx.outputFile);
        if (output.length <= maxChars) return Promise.resolve(output);
        return Promise.resolve(
            `...[truncated, showing last ${maxChars} chars]\n${output.slice(-maxChars)}`
        );
    }
    return readOutputTail(job.logPath, maxChars);
}

/**
 * Spawn a bash command in a tmux window (foreground mode).
 *
 * Returns immediately with the tmux context. The caller is responsible for
 * waiting for completion via the exit-code sentinel file.
 */
export function spawnForegroundTmux(
    command: string,
    cwd: string
): {
    tmuxCtx: TmuxJobContext;
    logPath: string;
    proc?: never; // tmux jobs don't have a Node ChildProcess
} {
    const gitRoot = getGitRoot(cwd);
    // If not in a git repo, fall through to direct spawn.
    // The caller should check for this.
    if (!gitRoot) {
        throw new TmuxSpawnError(
            "Not in a git repository — tmux backend requires a git root for session naming."
        );
    }

    const session = sessionNameForGitRoot(gitRoot);
    const runDir = runDirPath();
    let result;
    try {
        result = spawnInTmux(command, cwd, runDir, session);
    } catch (error) {
        throw new TmuxSpawnError(
            `tmux backend failed to spawn the command window: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    // The log path points to the tee'd output file.
    const logPath = result.outputFile;

    return {
        tmuxCtx: {
            session,
            windowId: result.windowId,
            exitCodeFile: result.exitCodeFile,
            outputFile: result.outputFile,
            gitRoot,
        },
        logPath,
    };
}

/**
 * Spawn a bash command in a tmux window (background mode).
 *
 * Sets up completion detection and returns the job.
 *
 * `onStartStallWatchdog` arms the stall watchdog for this job (returns a
 * cancel function). `onTerminal` (optional) fires once the job has been
 * finalized — after completion detection, sidecar indexing, notification,
 * and cleanup — so callers can refresh UI state that depends on the job map
 * and the completed/failed counters (e.g. the background-jobs footer widget).
 */
export function spawnBackgroundTmux(
    command: string,
    cwd: string,
    toolCallId: string,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext,
    onStartStallWatchdog: (
        jobId: string,
        command: string,
        logPath: string
    ) => () => void,
    onCompletion: (job: BackgroundJob) => void,
    onTerminal?: () => void
): BackgroundJob {
    const { tmuxCtx, logPath } = spawnForegroundTmux(command, cwd);

    const jobId = `tmux-${process.pid}-${++state.jobCounter}`;
    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: -1, // No single PID — tmux owns the process
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: true,
    };
    createJobDonePromise(job);
    attachTmuxContext(job, tmuxCtx);
    state.backgroundJobs.set(jobId, job);

    // Start stall watchdog (reuses Tau's existing interactive-prompt detection).
    const cancelStall = onStartStallWatchdog(jobId, command, logPath);

    // Poll for exit-code completion every 500ms.
    const pollTimer = setInterval(() => {
        const result = pollTmuxCompletion(job);
        if (!result.completed) return;

        clearInterval(pollTimer);
        cancelStall();
        markJobTerminal(
            job,
            result.exitCode === 0 || result.exitCode === null
                ? "completed"
                : "failed",
            result.exitCode ?? 0
        );
        void trackJobOutputIndex(job, ctx, "bash_bg");
        // Finalize through the shared completion machinery (toast, batch
        // suppression, busy-deferral, prune of consumed jobs) plus tmux
        // window cleanup — mirrors the direct-spawn path's notifyCompletion
        // so tmux-backed jobs cannot re-awaken the agent redundantly.
        onCompletion(job);
        // Refresh the footer widget only after the job has been finalized
        // (notification + cleanup + counter updates), so it neither shows the
        // completed job as running nor reports stale completed/failed counts.
        // Mirrors the auto-background poller in background.ts. Without this,
        // the background-jobs widget stays frozen at the spawn-time snapshot.
        onTerminal?.();
    }, 500);
    pollTimer.unref();

    return job;
}
