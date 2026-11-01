/**
 * Tmux utilities for the tmux-backed bash backend.
 *
 * Provides session management, window creation, output capture,
 * shell quoting, and tmux availability detection.
 *
 * Adapted from @richardgill/pi-tmux-bash (tmux-utils.ts, runtime.ts)
 * with simplifications for Tau's needs: no configurable session scoping,
 * no polling subsystem, no window option tagging.
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    captureOwnerIdentity,
    ORPHAN_REAPER_METADATA_SUFFIX,
} from "./features/tmux-orphan-reaper.ts";

// ─── Availability ───────────────────────────────────────────────────

let cachedAvailable: boolean | undefined;

/**
 * Detect whether tmux is available on the system.
 * Result is cached for the process lifetime.
 */
export function isTmuxAvailable(): boolean {
    if (cachedAvailable !== undefined) return cachedAvailable;
    try {
        execSync("which tmux 2>/dev/null", {
            encoding: "utf-8",
            timeout: 3000,
            stdio: "pipe",
        });
        cachedAvailable = true;
    } catch {
        cachedAvailable = false;
    }
    return cachedAvailable;
}

// ─── Shell quoting ──────────────────────────────────────────────────

/** Single-quote a value for shell embedding. Handles embedded single quotes. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reduce a tmux identifier to one bounded, parser-safe token. */
export function sanitizeTmuxToken(
    value: string,
    maxLength = 30,
    fallback = "shell"
): string {
    if (!value.trim()) return fallback;
    const safe = value.replace(/[^A-Za-z0-9._@:-]/g, "_").slice(0, maxLength);
    return safe || fallback;
}

/** Quote a value for tmux's command parser and the surrounding shell. */
export function tmuxCommandArg(value: string): string {
    const tmuxQuoted = `"${value.replace(/[\\"$#]/g, "\\$&")}"`;
    return shellQuote(tmuxQuoted);
}

// ─── Session management ─────────────────────────────────────────────

/** Determine the background tmux session name for a given git root. */
export function sessionNameForGitRoot(gitRoot: string): string {
    const slug = sanitizeTmuxToken(
        gitRoot.split("/").pop()?.slice(0, 16).toLowerCase() ?? "project",
        16,
        "project"
    );
    // Include a short hash to avoid collisions between same-named directories.
    const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
    return `pi-bg-${slug}-${hash}`;
}

/** Check whether a tmux session with the given name exists. */
export function sessionExists(name: string): boolean {
    return (
        execSafe(
            `tmux has-session -t ${shellQuote(
                sanitizeTmuxToken(name, 64, "bg")
            )} 2>/dev/null && echo yes`
        ) === "yes"
    );
}

// ─── Window management ──────────────────────────────────────────────

export interface TmuxWindow {
    id: string;
    index: number;
    title: string;
}

/**
 * List windows in a tmux session.
 * Returns empty array if the session does not exist.
 */
export function listWindows(session: string): TmuxWindow[] {
    return queryWindows(session) ?? [];
}

/** Default timeout for a tmux window query (fast local command). */
export const TMUX_QUERY_TIMEOUT_MS = 10_000;

/**
 * List windows, distinguishing "no such session" from "the query could not
 * run". `listWindows` collapses both into an empty array, which is fine for
 * display but not for deciding that a window has *vanished*: a transient tmux
 * failure (spawn error, timeout, resource exhaustion) would look identical to
 * a killed window and finalize a live job. Returns undefined when the query
 * itself failed, so callers can retry instead of concluding anything.
 *
 * `spawnSync` blocks the event loop, so callers running inside a poller should
 * pass a short timeout.
 */
export function queryWindows(
    session: string,
    timeoutMs = TMUX_QUERY_TIMEOUT_MS
): TmuxWindow[] | undefined {
    const result = spawnSync(
        "tmux",
        [
            "list-windows",
            "-t",
            sanitizeTmuxToken(session, 64, "bg"),
            "-F",
            "#{window_id}|||#{window_index}|||#{window_name}",
        ],
        { encoding: "utf-8", timeout: timeoutMs }
    );
    // `error` means tmux itself could not be run (ENOENT/EAGAIN/timeout). A
    // non-zero status is a real answer: tmux ran and reported no such session
    // or no server.
    if (result.error) return undefined;
    const raw = (result.stdout ?? "").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => {
        const [id, index, title] = line.split("|||");
        return {
            id: id ?? "",
            index: parseInt(index ?? "0"),
            title: title ?? "",
        };
    });
}

// ─── Process execution ──────────────────────────────────────────────

/** Execute a command synchronously, returning trimmed stdout. Returns null on failure. */
export function execSafe(cmd: string): string | null {
    try {
        return execSync(cmd, {
            encoding: "utf-8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

/** Execute a command synchronously. Throws on failure. */
export function exec(cmd: string): string {
    return execSync(cmd, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

// ─── Script generation ──────────────────────────────────────────────

/**
 * Create a bash wrapper script that:
 * 1. Tees output to a file
 * 2. Writes an exit-code sentinel on completion
 * 3. Stays alive as a login shell (so the tmux window doesn't close)
 *
 * Returns the script path and a unique run ID.
 */
export function createBashScript(
    runDir: string,
    session: string,
    command: string,
    paths: {
        id: string;
        outputFile: string;
        exitCodeFile: string;
        owner?: ReturnType<typeof captureOwnerIdentity>;
    }
): { scriptPath: string } {
    const scriptDir = join(runDir, "s");
    mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    chmodSync(scriptDir, 0o700);

    const scriptPath = join(scriptDir, `${session}.${paths.id}.sh`);

    const { exitCodeFile, outputFile } = paths;
    const ownershipPath = join(
        runDir,
        `${session}.${paths.id}${ORPHAN_REAPER_METADATA_SUFFIX}`
    );
    const ownerJson = JSON.stringify(paths.owner ?? captureOwnerIdentity());
    const metadataFormat =
        '{"schemaVersion":1,"owner":%s,"wrapper":{"pid":%s,"bootId":"%s","startTicks":"%s","ppid":%s},"outputFile":%s,"exitCodeFile":%s}';

    writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash
__output_file=${shellQuote(outputFile)}
__exit_code_file=${shellQuote(exitCodeFile)}
__owner_json=${shellQuote(ownerJson)}
__metadata_path=${shellQuote(ownershipPath)}
__wrapper_boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
__wrapper_start_ticks=$(sed 's/^.*) //' /proc/$$/stat 2>/dev/null | awk '{print $20}')
printf ${shellQuote(metadataFormat)} "$__owner_json" "$$" "$__wrapper_boot_id" "$__wrapper_start_ticks" "$PPID" ${shellQuote(JSON.stringify(outputFile))} ${shellQuote(JSON.stringify(exitCodeFile))} > "$__metadata_path.tmp"
mv "$__metadata_path.tmp" "$__metadata_path"
(
${command}
) >> "$__output_file" 2>&1
printf '%s\\n' "$?" > "$__exit_code_file"
`,
        { mode: 0o755 }
    );

    return { scriptPath };
}

/**
 * Spawn a command in a new tmux window.
 *
 * Returns the window ID, run ID, and output file path.
 * The exit-code sentinel file path is derived from these.
 */
export function spawnInTmux(
    command: string,
    cwd: string,
    runDir: string,
    session: string
): { windowId: string; id: string; outputFile: string; exitCodeFile: string } {
    const exists = sessionExists(session);

    // Pre-compute paths before creating the script.
    // Paths use only session + unique ID — no window ID dependency.
    // This avoids a mismatch when tmux display-message fails
    // inside detached sessions (the script used to derive paths
    // from the window ID independently, leading to empty reads).
    const id = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const exitCodeFile = join(runDir, `${session}.${id}.exit`);
    const outputFile = join(runDir, `${session}.${id}.out`);

    const script = createBashScript(runDir, session, command, {
        id,
        outputFile,
        exitCodeFile,
        owner: captureOwnerIdentity(),
    });

    const windowId = exec(
        buildSpawnCommand(command, cwd, script.scriptPath, session, exists)
    );

    return { windowId, id, outputFile, exitCodeFile };
}

/** Build the command used to ask tmux to create a session/window. */
export function buildSpawnCommand(
    command: string,
    cwd: string,
    scriptPath: string,
    session: string,
    sessionAlreadyExists: boolean
): string {
    const safeSession = sanitizeTmuxToken(session, 64, "bg");
    const createCmd = sessionAlreadyExists
        ? `new-window -d -t ${shellQuote(safeSession)}`
        : `new-session -d -s ${shellQuote(safeSession)}`;
    const windowName = sanitizeTmuxToken(
        command.split(/\s/)[0] ?? "",
        30,
        "shell"
    );
    return `tmux ${createCmd} -n ${shellQuote(windowName)} -c ${shellQuote(cwd)} -P -F '#{window_id}' ${tmuxCommandArg(scriptPath)}`;
}

// ─── Output capture ─────────────────────────────────────────────────

/**
 * Capture the last N lines of a tmux window's pane output.
 * Falls back to tmux capture-pane when the output file is empty or missing.
 */
export function captureOutput(
    windowId: string,
    lines: number,
    outputFile?: string
): string {
    // Prefer the output file written by the wrapper script — it has the exact
    // content without tmux framing. Fall back to tmux capture-pane when the file
    // is missing or empty.
    if (outputFile && existsSync(outputFile)) {
        const content = readFileSync(outputFile, "utf-8");
        if (content.length > 0) return content;
    }
    // Fallback: capture from tmux pane.
    const raw = execSafe(
        `tmux capture-pane -t ${shellQuote(
            sanitizeTmuxToken(windowId, 64, "bg")
        )} -p -S -${lines}`
    );
    return raw ?? "(no output)";
}

// ─── Exit code detection ────────────────────────────────────────────

/**
 * Check whether a command has completed by looking for the exit-code sentinel file.
 * Returns the exit code if found, or undefined if still running.
 */
export function checkExitCode(exitCodeFile: string): number | undefined {
    if (!existsSync(exitCodeFile)) return undefined;
    const content = readFileSync(exitCodeFile, "utf-8").trim();
    const code = parseInt(content);
    if (!Number.isFinite(code)) return undefined;
    // Clean up the sentinel file.
    try {
        unlinkSync(exitCodeFile);
    } catch {
        /* already gone */
    }
    return code;
}

// ─── Kill ────────────────────────────────────────────────────────────

/** Kill a tmux window by its ID. */
export function killWindow(windowId: string): void {
    execSafe(
        `tmux kill-window -t ${shellQuote(
            sanitizeTmuxToken(windowId, 64, "bg")
        )}`
    );
}

/** Get the git root for a directory, or null if not in a git repo. */
export function getGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
    } catch {
        return null;
    }
}
