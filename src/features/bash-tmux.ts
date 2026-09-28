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

import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
    queryWindows,
    sessionNameForGitRoot,
    spawnInTmux,
} from "../tmux.ts";
import { staleSafe } from "./ctx-guard.ts";
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

/**
 * How long the run directory of a dead pi process is kept before it is reaped.
 *
 * The run directory holds every background job's output for that session — the
 * only record of what those jobs did. Removing it the moment the owning process
 * disappears destroys that record exactly when it is most needed (a crashed,
 * killed, or stalled session), so dead run directories are retained for a day.
 */
export const RUN_DIR_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling for the override (30 days). Nothing reads job logs from a month-dead
 * session, so beyond this the directory is pure garbage.
 */
export const MAX_RUN_DIR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the dead-run-directory retention window from the environment.
 *
 * Digit-only, like the other numeric env overrides. Unlike the liveness
 * cadence, `0` is meaningful here and accepted: it restores the previous
 * delete-immediately behavior for hosts with a small /tmp. Values above
 * MAX_RUN_DIR_RETENTION_MS are clamped.
 */
export function resolveRunDirRetentionMs(
    env: NodeJS.ProcessEnv = process.env
): number {
    const raw = env.PI_TAU_TMUX_RUN_DIR_RETENTION_MS;
    if (raw === undefined) return RUN_DIR_RETENTION_MS;
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) return RUN_DIR_RETENTION_MS;
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) return RUN_DIR_RETENTION_MS;
    return Math.min(parsed, MAX_RUN_DIR_RETENTION_MS);
}

/** Injectable seams for {@link cleanupStaleTmuxRunDirs}. */
export interface StaleRunDirCleanupOptions {
    /** Directory holding the `pi-tmux-<pid>` run directories. */
    rootDir?: string;
    /** Clock used for the retention comparison. */
    now?: () => number;
    /** Process-liveness probe, also used for tmux pane pids. */
    isAlive?: (pid: number) => boolean;
    /** Retention window in ms; defaults to the env-resolved value. */
    retentionMs?: number;
    /** tmux command runner; returns stdout, throws on failure. */
    runTmux?: (command: string) => string;
}

/** Process-liveness probe: `process.kill(pid, 0)` without the throw. */
function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Run a tmux command in the same shape the cleanup path always used. */
function execTmux(command: string): string {
    return execSync(command, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/**
 * Whether a run directory may be deleted now: it must be datable and older
 * than the retention window. A directory whose mtime cannot be read is kept —
 * deleting what cannot be inspected is what destroyed the forensic record this
 * retention window exists to preserve.
 */
function newestMtimeMs(path: string): number | undefined {
    let info;
    try {
        // lstat avoids following symlinks out of the run directory or looping
        // through a symlink cycle. Run dirs are small, so this startup walk is
        // bounded by the number of job artifacts they contain.
        info = lstatSync(path);
    } catch {
        // An unreadable or concurrently removed entry makes age unknown.
        return undefined;
    }

    let newest = info.mtimeMs;
    if (!info.isDirectory()) return newest;

    let entries: string[];
    try {
        entries = readdirSync(path);
    } catch {
        return undefined;
    }
    for (const entry of entries) {
        const childMtimeMs = newestMtimeMs(join(path, entry));
        if (childMtimeMs === undefined) return undefined;
        newest = Math.max(newest, childMtimeMs);
    }
    return newest;
}

function isReapable(dir: string, nowMs: number, retentionMs: number): boolean {
    const newest = newestMtimeMs(dir);
    if (newest === undefined) return false;
    return nowMs - newest >= retentionMs;
}

/**
 * Kill `pi-bg-<slug>-<hash>` tmux sessions whose panes are all dead.
 *
 * Session names cannot be derived from a pid, so ownership is inferred from
 * the panes: a session left with no live pane is an orphan that would
 * otherwise accumulate forever. Job output lives in the run directory, which
 * this path never touches, so reaping a session does not discard job logs.
 */
function reapOrphanedTmuxSessions(
    runTmux: (command: string) => string,
    isAlive: (pid: number) => boolean
): void {
    try {
        const sessions = runTmux("tmux list-sessions -F '#{session_name}'")
            .trim()
            .split("\n")
            .filter((s) => s.startsWith("pi-bg-"));
        for (const session of sessions) {
            const paneOutput = runTmux(
                `tmux list-panes -t ${session} -F '#{pane_pid}'`
            ).trim();
            if (!paneOutput) continue;
            const panePids = paneOutput.split("\n").map((rawPid) => {
                const value = rawPid.trim();
                if (!/^\d+$/.test(value)) return undefined;
                const pid = Number(value);
                return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
            });
            // Missing or malformed pane data is unknown, not proof that the
            // session is orphaned. Never kill a session on an uncertain parse.
            if (panePids.some((pid) => pid === undefined)) continue;
            const allDead =
                panePids.length > 0 &&
                panePids.every((pid) => pid !== undefined && !isAlive(pid));
            if (allDead) {
                runTmux(`tmux kill-session -t ${session}`);
            }
        }
    } catch {
        /* tmux not available or no sessions */
    }
}

/**
 * Clean up run directories left behind by dead pi processes. Called on session
 * startup.
 *
 * A directory is removed only when its owning process is gone AND it has not
 * been written for the retention window (24h by default). The eager version of
 * this deleted a dead session's logs on the next pi startup — before anyone
 * could read them. Live processes are never touched, our own directory is
 * skipped, and entries that are not pid-stamped run directories are ignored.
 *
 * Pass `retentionMs: 0` (or set `PI_TAU_TMUX_RUN_DIR_RETENTION_MS=0`) for the
 * previous delete-immediately behavior.
 */
export function cleanupStaleTmuxRunDirs(
    options: StaleRunDirCleanupOptions = {}
): void {
    const rootDir = options.rootDir ?? "/tmp";
    const now = options.now ?? Date.now;
    const isAlive = options.isAlive ?? processAlive;
    const retentionMs = options.retentionMs ?? resolveRunDirRetentionMs();
    const runTmux = options.runTmux ?? execTmux;

    let entries: string[];
    try {
        entries = readdirSync(rootDir);
    } catch {
        // Unreadable root (missing, or not a directory): nothing to reap.
        return;
    }
    const nowMs = now();

    for (const entry of entries) {
        if (!entry.startsWith("pi-tmux-")) continue;
        const suffix = entry.slice("pi-tmux-".length);
        // Skip our own process, and anything that is not a pid-stamped run
        // directory: an entry we cannot attribute is not ours to delete.
        if (!/^\d+$/.test(suffix)) continue;
        const pid = Number(suffix);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (pid === process.pid) continue;
        if (isAlive(pid)) continue; // still running — never touch
        const dir = join(rootDir, entry);
        if (!isReapable(dir, nowMs, retentionMs)) continue;
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* permission error or concurrent cleanup */
        }
    }

    reapOrphanedTmuxSessions(runTmux, isAlive);
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
 * Polls between tmux window-liveness checks. The exit-code sentinel is a
 * single `stat()`; an `exec` per 500ms poll per job would be wasteful, so
 * liveness is sampled on a slower cadence (~10s). Overridable so tests do not
 * have to wait a full cadence.
 */
export const TMUX_LIVENESS_POLL_EVERY = 20;

/**
 * Ceiling for the override (~8 min at the 500ms poll cadence). An arbitrarily
 * large value would push the liveness check past any realistic job lifetime and
 * silently disable the vanished-window recovery this exists to provide.
 */
export const MAX_TMUX_LIVENESS_POLL_EVERY = 1_000;

function livenessPollEvery(): number {
    return resolveLivenessPollEvery(process.env);
}

/**
 * Resolve the liveness cadence (in polls) from the environment.
 *
 * Digit-only, like the other numeric env overrides: rejects "1e9", "-5",
 * "20.5", and padded junk rather than coercing them. Values above
 * MAX_TMUX_LIVENESS_POLL_EVERY are clamped, because an arbitrarily large
 * cadence would outlive any realistic job and silently disable the
 * vanished-window recovery this exists to provide.
 */
export function resolveLivenessPollEvery(
    env: NodeJS.ProcessEnv = process.env
): number {
    const raw = env.PI_TAU_TMUX_LIVENESS_POLL_EVERY;
    if (raw === undefined) return TMUX_LIVENESS_POLL_EVERY;
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) return TMUX_LIVENESS_POLL_EVERY;
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return TMUX_LIVENESS_POLL_EVERY;
    }
    return Math.min(parsed, MAX_TMUX_LIVENESS_POLL_EVERY);
}

/** Consecutive sentinel-absent polls observed per job. */
const livenessPollCounts = new WeakMap<BackgroundJob, number>();

/**
 * Timeout for the liveness probe. It runs inside a 500ms completion poller and
 * `queryWindows` is synchronous, so a hung tmux must not be able to block the
 * event loop for the default 10s. A timeout reports "unknown", which the caller
 * treats as "still running, retry next cadence".
 */
export const TMUX_LIVENESS_QUERY_TIMEOUT_MS = 2_000;

/**
 * Whether the tmux window still exists in its session. `undefined` means the
 * query itself failed (tmux could not be run) — not evidence of death.
 */
function tmuxWindowAlive(
    session: string,
    windowId: string
): boolean | undefined {
    const windows = queryWindows(session, TMUX_LIVENESS_QUERY_TIMEOUT_MS);
    if (windows === undefined) return undefined;
    return windows.some((window) => window.id === windowId);
}

/**
 * Poll for exit-code completion of a tmux-backed background job.
 * Called by the stall watchdog tick to detect completed commands.
 *
 * A tmux window can also die *without* writing the sentinel: `tmux
 * kill-window`/`kill-session`/`kill-server`, an OOM SIGKILL of the pane, or a
 * host reboot. Waiting only on the sentinel left such a job `running` forever,
 * and `jobs attach` would await a donePromise that never resolves. When the
 * sentinel is absent but the window is gone, report the job as vanished so the
 * caller can finalize it. The wrapper script writes the sentinel before it
 * exits, so a normally-finished window always has its sentinel present —
 * sentinel-absent plus window-gone means the window died abnormally.
 */
export function pollTmuxCompletion(job: BackgroundJob): {
    completed: boolean;
    exitCode?: number;
    /** The window disappeared without reporting an exit code. */
    vanished?: boolean;
} {
    const ctx = getTmuxContext(job);
    if (!ctx) return { completed: false };

    const code = checkExitCode(ctx.exitCodeFile);
    if (code !== undefined) return { completed: true, exitCode: code };

    const every = livenessPollEvery();
    const count = (livenessPollCounts.get(job) ?? 0) + 1;
    if (count < every) {
        livenessPollCounts.set(job, count);
        return { completed: false };
    }
    livenessPollCounts.set(job, 0);
    const alive = tmuxWindowAlive(ctx.session, ctx.windowId);
    // A failed query is not evidence of death: keep the job running and retry
    // on the next cadence rather than finalizing a live job.
    if (alive !== false) return { completed: false };

    return { completed: true, vanished: true };
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
 * Finalize a tmux-backed job once its exit-code sentinel is present.
 *
 * This is the body of the completion poll timer (see spawnBackgroundTmux),
 * extracted so the stale-ctx fallback can be unit-tested without a live
 * tmux server. `onCompletion` carries the caller's completion machinery
 * (notification, cleanup), which is the path that can touch a stale ctx.
 */
export function finalizeTmuxCompletion(
    job: BackgroundJob,
    exitCode: number | undefined,
    ctx: UiContext,
    onCompletion: (job: BackgroundJob) => void,
    onTerminal?: () => void
): void {
    markJobTerminal(
        job,
        exitCode === 0 || exitCode === null ? "completed" : "failed",
        exitCode
    );
    void trackJobOutputIndex(job, ctx, "bash_bg");
    onCompletion(job);
    onTerminal?.();
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
        // A vanished window reports no exit code; passing undefined marks the
        // job failed (not completed) with no fabricated status code.
        const exitCode = result.vanished ? undefined : (result.exitCode ?? 0);
        if (
            staleSafe(() =>
                finalizeTmuxCompletion(
                    job,
                    exitCode,
                    ctx,
                    onCompletion,
                    onTerminal
                )
            ) === "stale"
        ) {
            // The captured pi/ctx were invalidated by a session replacement
            // or reload while this job was running. Every access would throw
            // the stale-ctx assertion; inside a timer callback that is an
            // uncaughtException that kills pi, so fall back to cleanup that
            // needs no pi: keep the output log, kill the tmux window so it
            // does not outlive the session.
            killTmuxJob(job);
        }
    }, 500);
    pollTimer.unref();

    return job;
}
