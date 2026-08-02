/**
 * Scheduled and external callbacks for pi.
 *
 * The agent often says "I'll check on it in a couple of minutes" but has no
 * native mechanism to follow through. This feature adds:
 *
 * 1. **Scheduled callbacks** — one-shot timers that deliver a message to the
 *    agent at a future time. Created by the `remind` tool (agent) or
 *    `/remind` command (user). Persisted to the session for restore on resume.
 *
 * 2. **External callbacks** — file-based IPC for external processes to
 *    deliver messages into an active pi session. External processes write
 *    JSON files to `~/.pi/callbacks/<session-id>/`. A filesystem watcher
 *    detects new files and delivers the message.
 *
 * Lifecycle:
 * - On session_start: restore pending callbacks from session entries
 * - On session_shutdown: persist pending callbacks, clean up watcher
 * - Timers fire via pi.sendUserMessage()
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ms from "ms";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import type { JobTrigger } from "../types.ts";
import { isFeatureEnabled } from "./features-helpers.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface ScheduledCallback {
    id: string;
    message: string;
    /** ISO timestamp when this callback should fire. */
    fireAt: string;
    /** ISO timestamp when this callback was created. */
    createdAt: string;
    /** Who created this callback. */
    source: "agent" | "user" | "external";
    /** Whether this callback has been delivered. */
    fired: boolean;
    /** Timer handle (not persisted). */
    timer?: ReturnType<typeof setTimeout>;
    /** Optional job ID to link this callback to. When the job completes
     *  or is killed, the callback is automatically cancelled. */
    linkedJobId?: string;
    /** Optional group label for bulk cancel operations. */
    group?: string;
}

// ─── Duration parsing ───────────────────────────────────────────────

const SINGLE_DURATION_RE = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;
const COMPOUND_DURATION_RE = /^\d+[smhd](?:\d+[smhd])*$/;
const PURE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

const unitMs: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

/**
 * Parse a human-readable duration string to milliseconds.
 *
 * Supported formats:
 *   - Simple compact: "30s", "5m", "2h", "1d", "1.5m"
 *   - Compound compact: "3m30s", "1h30m15s"
 *   - Compound with spaces: "1h 30m", "3m 30s"
 *   - Full words: "30 seconds", "5 minutes", "1 hour", "2 days", "1 week"
 *   - Abbreviated words: "30sec", "5min", "2hrs", "2d"
 *
 * Ambiguous inputs like pure numbers ("90") or mm:ss ("1:30") are rejected.
 */
export function parseDurationToMs(input: string): number | null {
    input = input.trim();
    if (!input) return null;

    // Reject pure numbers — too ambiguous (90s? 90m?)
    if (PURE_NUMBER_RE.test(input)) return null;

    // 1) Single-unit compact with optional decimal (e.g. "1.5m", "30s")
    const single = input.match(SINGLE_DURATION_RE);
    if (single) {
        return parseFloat(single[1]) * unitMs[single[2]];
    }

    // 2) Compound with or without spaces (e.g. "3m30s", "1h 30m")
    const spaceless = input.replace(/\s+/g, "");
    if (COMPOUND_DURATION_RE.test(spaceless)) {
        let total = 0;
        const parts = spaceless.match(/(\d+)([smhd])/g);
        if (parts) {
            for (const part of parts) {
                const val = parseInt(part, 10);
                const u = part[part.length - 1];
                if (val < 0 || !unitMs[u]) return null;
                total += val * unitMs[u];
            }
        }
        return total;
    }

    // 3) Full words / shorthand via ms (e.g. "30 seconds", "5min", "2hrs", "1 week")
    // ms treats lone numbers as milliseconds, but we already rejected those above.
    const parsed = ms(input);
    if (typeof parsed === "number" && parsed > 0) {
        return parsed;
    }

    return null;
}

export function formatDuration(ms: number): string {
    const abs = Math.abs(ms);
    if (abs < 60_000) return `${Math.round(abs / 1_000)}s`;
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
    return `${Math.round(abs / 86_400_000)}d`;
}

export function formatRelative(isoDate: string): string {
    const ms = new Date(isoDate).getTime() - Date.now();
    if (ms <= 0) return "overdue";
    return `in ${formatDuration(ms)}`;
}

// ─── Callback directory (external IPC) ──────────────────────────────

function callbacksDir(sessionId: string): string {
    return join(homedir(), ".pi", "callbacks", sessionId);
}

// ─── Module-level state ────────────────────────────────────────────
//
// Kept at module level so exported functions like cancelCallbacksForJob()
// can access the live callback map without complex wiring.
//
// Assumption: pi-tau is loaded once per process, so module-level state is
// safe from cross-session corruption. If that changes, this state should
// be migrated to a class instance managed by registerCallbacks().

const callbacks = new Map<string, ScheduledCallback>();
let cbNextId = 1;
let _pi: ExtensionAPI | null = null;
let _sessionId = "";
let _watcher: ReturnType<typeof watch> | null = null;
let _tauState: TauState | null = null;
let _agentBusy = false;
let _readyFlushTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Tracks the set of other pending non-linked callbacks to annotate in the
 * next delivery message. The agent sees these listed and can proactively
 * cancel any that are stale.
 */
let _pendingCallbacksForMessage: Set<string> | null = null;


/**
 * Cancel all pending callbacks linked to a given job ID.
 * Called by the background jobs feature when a job completes or is killed.
 */
export function cancelCallbacksForJob(jobId: string): number {
    let count = 0;
    for (const [id, cb] of callbacks) {
        if (cb.linkedJobId === jobId) {
            if (cb.timer) {
                clearTimeout(cb.timer);
                cb.timer = undefined;
            }
            callbacks.delete(id);
            count++;
        }
    }
    if (count > 0) persistState();
    // Also clear any pending completion notification for this job
    _tauState?.cancelCompletionBatchForJob?.(jobId);
    return count;
}

/**
 * Check whether any non-fired callbacks are linked to the given job.
 */
export function hasLinkedCallbacksForJob(jobId: string): boolean {
    for (const cb of callbacks.values()) {
        if (cb.linkedJobId === jobId && !cb.fired) return true;
    }
    return false;
}

/**
 * Cancel all pending callbacks in a given group.
 */
export function cancelCallbacksForGroup(group: string): number {
    let count = 0;
    for (const [id, cb] of callbacks) {
        if (cb.group === group) {
            if (cb.timer) {
                clearTimeout(cb.timer);
                cb.timer = undefined;
            }
            callbacks.delete(id);
            count++;
        }
    }
    if (count > 0) persistState();
    return count;
}

/**
 * Schedule a callback linked to a background job.
 * Auto-cancelled when the job completes via cancelCallbacksForJob().
 * Returns the callback ID, or null if remindIn is invalid.
 */
export function scheduleJobReminder(
    jobId: string,
    remindIn: string,
    message?: string
): string | null {
    const delayMs = parseDurationToMs(remindIn);
    if (delayMs === null) return null;

    const now = new Date();
    const fireAt = new Date(now.getTime() + delayMs);
    const id = generateId();

    const cb: ScheduledCallback = {
        id,
        message: message ?? `check on job ${jobId}`,
        fireAt: fireAt.toISOString(),
        createdAt: now.toISOString(),
        source: "agent",
        fired: false,
        linkedJobId: jobId,
    };

    scheduleCallback(cb);
    persistState();
    return id;
}

// ─── Core operations (module-level) ────────────────────────────────

function generateId(): string {
    return `cb-${cbNextId++}`;
}

function scheduleCallback(cb: ScheduledCallback): void {
        callbacks.set(cb.id, cb);
        const delay = new Date(cb.fireAt).getTime() - Date.now();

        if (delay <= 0) {
            // Already due — fire immediately
            fireCallback(cb.id);
            return;
        }

        cb.timer = setTimeout(() => {
            fireCallback(cb.id);
        }, delay);

        // Don't let the timer prevent process exit
        if (cb.timer && typeof cb.timer === "object") {
            cb.timer.unref();
        }
    }

/**
 * Read /proc/<pid>/stat and return a one-line resource snapshot.
 * Returns null if /proc is unavailable or the process has exited.
 */
function readProcSnapshot(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen === -1) return null;
		const parts = stat.slice(closeParen + 2).split(" ");
		if (parts.length < 22) return null;

		const utime = parseInt(parts[11], 10) || 0;
		const stime = parseInt(parts[12], 10) || 0;
		const cutime = parseInt(parts[13], 10) || 0;
		const cstime = parseInt(parts[14], 10) || 0;
		const cpuSec = ((utime + stime + cutime + cstime) / 100) * 1000;
		const rssKb = (parseInt(parts[21], 10) || 0) * 4;

		// Prefer VmRSS from /proc/status
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf-8");
			const vmRss = status.match(/^VmRSS:\s+(\d+)/m);
			if (vmRss) {
				const vmRssKb = parseInt(vmRss[1], 10);
				return `pid=${pid} cpu=${cpuSec.toFixed(2)}ms rss=${Math.round((vmRssKb || rssKb) / 1024)}MB state=${parts[0]}`;
			}
		} catch {}
		return `pid=${pid} cpu=${cpuSec.toFixed(2)}ms rss=${Math.round(rssKb / 1024)}MB state=${parts[0]}`;
	} catch {
		return null;
	}
}

/**
 * Read GPU utilization from sysfs (one line per GPU).
 * Returns null if no GPU data is available.
 */
function readGpuSnapshot(): string | null {
	try {
		const entries = readdirSync("/sys/class/drm");
		const lines: string[] = [];
		for (const entry of entries) {
			if (!entry.startsWith("card") || entry.includes("-")) continue;
			const deviceDir = `/sys/class/drm/${entry}/device`;
			try {
				const busy = parseInt(
					readFileSync(`${deviceDir}/gpu_busy_percent`, "utf-8").trim(),
					10
				);
				// Try temp
				let temp = "";
				try {
					const hwmons = readdirSync("/sys/class/hwmon");
					for (const hw of hwmons) {
						const hwmonDevice = readFileSync(`/sys/class/hwmon/${hw}/name`, "utf-8").trim();
						if (hwmonDevice === "amdgpu" || hwmonDevice === "i915") {
							const t = parseInt(readFileSync(`/sys/class/hwmon/${hw}/temp1_input`, "utf-8").trim(), 10);
							temp = ` ${(t / 1000).toFixed(0)}C`;
							break;
						}
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

function buildCallbackMessage(cb: ScheduledCallback): string {
    const elapsed = formatDuration(
        Date.now() - new Date(cb.createdAt).getTime()
    );

    // If linked to a running job, include a resource snapshot
    let resourceLine = "";
    if (cb.linkedJobId && _tauState) {
        const job = _tauState.backgroundJobs.get(cb.linkedJobId);
        if (job && job.status === "running" && job.pid) {
            const procInfo = readProcSnapshot(job.pid);
            if (procInfo) {
                resourceLine = `\nJob resource data: ${procInfo}`;
            }
            const gpuInfo = readGpuSnapshot();
            if (gpuInfo) {
                resourceLine += `\nGPU data: ${gpuInfo}`;
            }
        }
    }

    // Collect other pending callbacks and append as structured XML so the
    // model can extract IDs and cancel all stale callbacks in one turn.
    const others = Array.from(callbacks.values())
        .filter((other) => other.id !== cb.id && !other.fired)
        .filter((other) => {
            // Skip callbacks linked to jobs that are no longer running.
            // The linked job may have completed between when the callback
            // was scheduled and when this timer fires, making it stale.
            if (other.linkedJobId && _tauState) {
                const job = _tauState.backgroundJobs.get(other.linkedJobId);
                if (!job || job.status !== "running") return false;
            }
            return true;
        });

    let message = cb.message;

    // If there are other pending non-linked callbacks, prepend a note so
    // the agent can decide if any are stale and cancel them proactively.
    if (_pendingCallbacksForMessage && _pendingCallbacksForMessage.size > 0) {
        const ids = Array.from(_pendingCallbacksForMessage);
        message =
            `${ids.length} other non-linked callback(s) pending. ` +
            `Use \`remind action="list"\` to see all, or ` +
            `\`remind action="cancel" id=${ids[0]}\` to cancel if stale.\n\n${message}`;
        _pendingCallbacksForMessage = null;
    }

    if (others.length > 0) {
        const items = others.map((other) => {
            const remainingMs = Date.parse(other.fireAt) - Date.now();
            const fireIn =
                remainingMs > 0 ? formatDuration(remainingMs) : "overdue";
            const linkedAttr = other.linkedJobId
                ? ` linkedTo="${other.linkedJobId}"`
                : "";
            const noStalenessAttr = other.linkedJobId
                ? ""
                : ' noStalenessCheck="true"';
            const itemElapsed = formatDuration(
                Date.now() - Date.parse(other.createdAt)
            );
            return `  <item id="${other.id}" source="${other.source}" elapsed="${itemElapsed}" fireIn="${fireIn}"${linkedAttr}${noStalenessAttr}>${other.message}</item>`;
        });
        message += `\n\n<other_callbacks_pending count="${others.length}">\n`;
        message += items.join("\n");
        message += "\n</other_callbacks_pending>";
    }

    if (resourceLine) {
        message += resourceLine;
    }

    return `<callback id="${cb.id}" source="${cb.source}" elapsed="${elapsed}">\n${message}\n</callback>`;
}

function flushReadyCallbacks(): void {
    if (_agentBusy || !_pi) return;

    const ready = Array.from(callbacks.values())
        .filter((cb) => cb.fired)
        .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
    const cb = ready[0];
    if (!cb) return;

    const message = buildCallbackMessage(cb);

    // Try to start a new agent turn with the callback message.
    _pi.sendUserMessage(message, {
        deliverAs: "followUp",
    });

    // Also persist the callback as a custom entry in the session
    // transcript. This ensures the callback data survives compaction
    // and session restores. appendEntry is used here instead of
    // sendMessage+deliverAs:followUp to avoid delivering the same
    // callback content to the LLM twice (sendUserMessage above
    // already handles agent notification).
    _pi.appendEntry("callback", {
        cbId: cb.id,
        linkedJobId: cb.linkedJobId,
        message,
    });

    callbacks.delete(cb.id);
    persistState();
}

function scheduleReadyCallbackFlush(): void {
    if (_readyFlushTimer) return;
    _readyFlushTimer = setTimeout(() => {
        _readyFlushTimer = null;
        flushReadyCallbacks();
    }, 0);
}

function fireCallback(id: string): void {
    const cb = callbacks.get(id);
    if (!cb || cb.fired) return;

    // If linked to a background job, skip delivery if the job is no longer
    // running. The job may have completed between when the timer was set and
    // when it fired, making this callback stale.
    // If the job is still running, mark it so the completion notification
    // is delivered when it eventually finishes (the linked callback has now
    // been consumed, so flushCompletionBatch would otherwise suppress it).
    if (cb.linkedJobId && _tauState) {
        const job = _tauState.backgroundJobs.get(cb.linkedJobId);
        if (!job || job.status !== "running") {
            // Job is gone or done — cancel this callback silently
            if (cb.timer) {
                clearTimeout(cb.timer);
                cb.timer = undefined;
            }
            callbacks.delete(id);
            persistState();
            return;
        }
        // Job is still running — ensure completion notification fires later
        job.wantsCompletionNotification = true;
    }

    // Collect other pending non-linked callbacks for the message annotation,
    // so the agent has awareness of all pending reminders at once.
    // Unlike linked callbacks (which are auto-cancelled when the job completes),
    // non-linked callbacks have no staleness detection — they always fire.
    // Rather than deleting them here (which would silently drop reminders the
    // agent may still need), we annotate the delivery message so the agent can
    // proactively cancel any that are stale.
    if (!cb.linkedJobId && cb.source === "agent") {
        const pending = new Set<string>();
        for (const [otherId, other] of callbacks) {
            if (
                otherId !== id &&
                !other.linkedJobId &&
                other.source === "agent" &&
                !other.fired
            ) {
                pending.add(otherId);
            }
        }
        if (pending.size > 0) {
            _pendingCallbacksForMessage = pending;
            // Note: _pendingCallbacksForMessage is read by buildCallbackMessage to
            // annotate the delivery. We do NOT delete these callbacks — they
            // continue to fire on schedule. The agent sees them in the message
            // and can cancel via remind action=cancel if they are stale.
        }
    }

    cb.fired = true;
    if (cb.timer) {
        clearTimeout(cb.timer);
        cb.timer = undefined;
    }

    // Keep fired callbacks in-memory until they are actually delivered so
    // cancel/cancel-all can still suppress them if the agent stays busy.
    // Persisted state omits fired callbacks, so they will not be restored
    // across sessions.
    persistState();
    scheduleReadyCallbackFlush();
}

function cancelCallback(id: string): boolean {
    const cb = callbacks.get(id);
    if (!cb) return false;

    const linkedJobId = cb.linkedJobId;
    if (cb.timer) {
        clearTimeout(cb.timer);
        cb.timer = undefined;
    }
    callbacks.delete(id);
    persistState();
    // Also clear any pending completion notification for the linked job
    if (linkedJobId) {
        _tauState?.cancelCompletionBatchForJob?.(linkedJobId);
    }
    return true;
}

function cancelAll(): number {
    let count = 0;
    for (const cb of callbacks.values()) {
        if (cb.timer) {
            clearTimeout(cb.timer);
            cb.timer = undefined;
        }
        count++;
    }
    callbacks.clear();
    persistState();
    // Also clear all pending completion notifications
    _tauState?.cancelAllCompletionBatches?.();
    return count;
}

function persistState(): void {
    if (!_pi) return;
    const pending = Array.from(callbacks.values())
        .filter((cb) => !cb.fired)
        .map((cb) => ({
            id: cb.id,
            message: cb.message,
            fireAt: cb.fireAt,
            createdAt: cb.createdAt,
            source: cb.source,
            linkedJobId: cb.linkedJobId,
            group: cb.group,
        }));

    _pi.appendEntry("callbacks-state", {
        callbacks: pending,
        nextId: cbNextId,
    });
}

// ── External callback watcher (module-level) ──────────────────────

function startExternalWatcher(sid: string): void {
    const dir = callbacksDir(sid);
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        // Directory may already exist
    }

    try {
        _watcher = watch(dir, (eventType, filename) => {
            if (!filename) return;
            if (eventType !== "rename" && eventType !== "change") return;
            if (!filename.endsWith(".json")) return;

            const filepath = join(dir, filename);
            try {
                const raw = readFileSync(filepath, "utf-8");
                const payload = JSON.parse(raw) as {
                    message: string;
                    source?: string;
                };

                if (payload.message) {
                    const cb: ScheduledCallback = {
                        id: generateId(),
                        message: payload.message,
                        fireAt: new Date().toISOString(),
                        createdAt: new Date().toISOString(),
                        source: "external",
                        fired: false,
                    };

                    // Fire immediately for external callbacks
                    callbacks.set(cb.id, cb);
                    fireCallback(cb.id);
                }

                // Clean up the file
                try {
                    rmSync(filepath);
                } catch {
                    // Already removed
                }
            } catch {
                // File might not be fully written yet — ignore
            }
        });
    } catch {
        // watch() may fail on some platforms — degrade gracefully
    }

    // Also process any files that already exist (from before pi started)
    processExistingCallbacks(sid);
}

function stopExternalWatcher(): void {
    if (_watcher) {
        _watcher.close();
        _watcher = null;
    }
}

function processExistingCallbacks(sid: string): void {
    const dir = callbacksDir(sid);
    try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        for (const filename of files) {
            const filepath = join(dir, filename);
            try {
                const raw = readFileSync(filepath, "utf-8");
                const payload = JSON.parse(raw) as {
                    message: string;
                    source?: string;
                };

                if (payload.message) {
                    const cb: ScheduledCallback = {
                        id: generateId(),
                        message: payload.message,
                        fireAt: new Date().toISOString(),
                        createdAt: new Date().toISOString(),
                        source: "external",
                        fired: false,
                    };
                    callbacks.set(cb.id, cb);
                    fireCallback(cb.id);
                }
                try {
                    rmSync(filepath);
                } catch {
                    // Already removed
                }
            } catch {
                // Skip unreadable files
            }
        }
    } catch {
        // Directory doesn't exist yet — that's fine
    }
}

// ─── Feature registration ───────────────────────────────────────────

export function registerCallbacks(pi: ExtensionAPI, state: TauState): void {
    _tauState = state;

    // ── Session lifecycle ──────────────────────────────────────────

    pi.on("session_start", async (event, ctx) => {
        _sessionId = ctx.sessionManager.getSessionId();
        _pi = pi;
        _agentBusy = false;
        cbNextId = 1;

        // Restore pending callbacks from the latest session entry.
        // Iterate in reverse to find the most recent callbacks-state
        // entry, which reflects the latest state (fired callbacks removed).
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "custom" &&
                entry.customType === "callbacks-state"
            ) {
                const data = entry.data as {
                    callbacks?: Array<{
                        id: string;
                        message: string;
                        fireAt: string;
                        createdAt: string;
                        source: "agent" | "user" | "external";
                        linkedJobId?: string;
                        group?: string;
                    }>;
                    nextId?: number;
                };

                if (data.callbacks) {
                    for (const cb of data.callbacks) {
                        const restored: ScheduledCallback = {
                            ...cb,
                            fired: false,
                        };
                        scheduleCallback(restored);
                    }
                }
                if (typeof data.nextId === "number") {
                    cbNextId = Math.max(cbNextId, data.nextId);
                }
                break;
            }
        }

        // Clean up restored callbacks whose linked jobs no longer exist
        // (orphaned from a previous process that tracked the job).
        let orphanCount = 0;
        const tauState = _tauState;
        if (tauState) {
            for (const [id, cb] of callbacks) {
                if (cb.linkedJobId && !tauState.backgroundJobs.has(cb.linkedJobId)) {
                    if (cb.timer) {
                        clearTimeout(cb.timer);
                        cb.timer = undefined;
                    }
                    callbacks.delete(id);
                    orphanCount++;
                }
            }
        }
        if (orphanCount > 0) {
            persistState();
        }

        // Start watching for external callbacks
        startExternalWatcher(_sessionId);
    });

    pi.on("agent_start", async () => {
        _agentBusy = true;
    });

    pi.on("agent_end", async () => {
        _agentBusy = false;
        scheduleReadyCallbackFlush();
    });

    pi.on("session_shutdown", async () => {
        // Persist any pending callbacks
        persistState();

        // Stop watcher
        stopExternalWatcher();

        if (_readyFlushTimer) {
            clearTimeout(_readyFlushTimer);
            _readyFlushTimer = null;
        }

        // Cancel all in-memory timers
        for (const cb of callbacks.values()) {
            if (cb.timer) {
                clearTimeout(cb.timer);
                cb.timer = undefined;
            }
        }
        callbacks.clear();
        _agentBusy = false;
        _pi = null;
    });

    // ── Agent tool: remind ──────────────────────────────────────────

    pi.registerTool({
        name: "remind",
        label: "Remind / Manage Callbacks",
        description:
            "Schedule, list, or cancel callbacks. " +
            "Use when you say 'I'll check on it later' or 'let me come back to this'. " +
            "The callback delivers a message to you at the specified time, " +
            "prompting you to follow up. " +
            "Examples: remind in 2m to check the deploy, remind in 30s to review test results. " +
            "Use remind action=list to see pending callbacks, " +
            "remind action=cancel id=cb-3 to cancel one, " +
            "remind action=cancel-all to cancel all. " +
            "Use jobId to link a callback to a background job — it auto-cancels when the job finishes. " +
            "WARNING: manual remind() without jobId creates a standalone callback that persists " +
            "until it fires or is explicitly cancelled. It will NOT auto-cancel when a job completes. " +
            "For job monitoring, prefer bash_bg with remindDelay which auto-links the callback. " +
            "When used with jobId, triggers can be subscribed on the running job to fire async events " +
            'when conditions like outputLines, rssKb, cpuTime, or wallTime are met.',
        promptSnippet: "Schedule, list, or cancel callbacks",
        promptGuidelines: [
            "Use remind when you promise to check on something later.",
            "Prefer shorter intervals (30s-5m) for monitoring tasks.",
            "The callback message should be specific about what to check.",
            "Do NOT use remind for things you can verify now.",
            "When you set a remind callback with jobId, you can work on other things. " +
                "The callback will fire when the time comes or the job completes — no need to poll.",
            "Use remind action=list to see pending callbacks with their IDs.",
            "Use remind action=cancel id=cb-3 to cancel a specific callback.",
            "Use remind action=cancel-all to cancel all pending callbacks.",
            "When a callback fires, other pending callbacks are listed in the message so the model can cancel them all in one turn.",
            "For job monitoring, ALWAYS use bash_bg with remindDelay instead of manual remind(). " +
                "remindDelay auto-links to the jobId, so the callback is cancelled on job completion. " +
                "Manual remind() without jobId creates a standalone callback that fires even after " +
                "the job finishes — you must cancel it explicitly.",
            "Pass jobId when you must use manual remind() for a job-related check — " +
                "this links the callback to the job so it auto-cancels on completion.",
            "Use triggers on remind to subscribe conditions on a running job — " +
                "e.g., triggers: [{type:\"outputLines\", value: 200}] fires when the log has 200+ lines.",
        ],
        parameters: Type.Object({
            action: Type.Optional(
                StringEnum(
                    ["schedule", "list", "cancel", "cancel-all"] as const,
                    {
                        description:
                            "What to do: schedule (default), list pending, cancel one, or cancel all.",
                    }
                )
            ),
            message: Type.Optional(
                Type.String({
                    description:
                        "What to follow up on when the callback fires. Be specific. Required when action=schedule.",
                })
            ),
            delay: Type.Optional(
                Type.String({
                    description:
                        'How long until the callback fires. Required when action=schedule. Formats: "30s", "5m", "1h", "2d", or compound like "3m30s".',
                })
            ),
            id: Type.Optional(
                Type.String({
                    description:
                        "Callback ID to cancel (e.g. cb-3). Required when action=cancel.",
                })
            ),
            jobId: Type.Optional(
                Type.String({
                    description:
                        "Optional job ID to link this callback to. When set, the callback auto-cancels if the background job completes or is killed before the timer fires. " +
                        "Without a jobId, this is a standalone callback that persists until it fires " +
                        "or is explicitly cancelled — it will NOT auto-cancel when a job finishes. " +
                        "For job monitoring, prefer bash_bg with remindDelay which auto-links.",
                })
            ),
            triggers: Type.Optional(
                Type.Array(
                    Type.Object({
                        type: Type.String({
                            description:
                                'Trigger type: "outputLines", "rssKb", "ioReadBytes", "ioWriteBytes", ' +
                                '"cpuTime", "ioBlock", or "wallTime".',
                        }),
                        value: Type.Number({
                            description: "Threshold value.",
                        }),
                        label: Type.Optional(
                            Type.String({
                                description: "Optional label for the callback message.",
                            })
                        ),
                    }),
                    {
                        description:
                            "Optional triggers to subscribe on the linked job. " +
                            "Requires jobId. Monitored alongside any triggers already set on the job. " +
                            'Example: [{type:"outputLines",value:200}] notifies when log has 200+ lines.',
                    }
                )
            ),
        }),

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            if (!isFeatureEnabled(state, "callbacks")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Callbacks are disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }

            const action = params.action ?? "schedule";

            switch (action) {
                case "list": {
                    const pending = Array.from(callbacks.values()).filter(
                        (cb) => !cb.fired
                    );
                    if (pending.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: "No pending callbacks.",
                                },
                            ],
                            details: undefined,
                        };
                    }
                    const lines = pending.map((cb) => {
                        const relative = formatRelative(cb.fireAt);
                        const jobTag = cb.linkedJobId
                            ? ` [linked to ${cb.linkedJobId}]`
                            : "";
                        return `  ${cb.id}: "${cb.message}" — ${relative} (${cb.source})${jobTag}`;
                    });
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Pending callbacks (${pending.length}):\n${lines.join("\n")}`,
                            },
                        ],
                        details: undefined,
                    };
                }

                case "cancel": {
                    if (!params.id) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: "id parameter is required for action=cancel.",
                                },
                            ],
                            details: undefined,
                        };
                    }
                    if (cancelCallback(params.id)) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Callback ${params.id} cancelled.`,
                                },
                            ],
                            details: undefined,
                        };
                    } else {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Callback ${params.id} not found or already fired.`,
                                },
                            ],
                            details: undefined,
                        };
                    }
                }

                case "cancel-all": {
                    const count = cancelAll();
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Cancelled ${count} pending callback(s).`,
                            },
                        ],
                        details: undefined,
                    };
                }

                default: {
                    // action == "schedule"
                    if (!params.message || !params.delay) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: "message and delay parameters are required for action=schedule.",
                                },
                            ],
                            details: undefined,
                        };
                    }

                    const delayMs = parseDurationToMs(params.delay);
                    if (delayMs === null) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: `Invalid delay "${params.delay}". Use formats like "30s", "5m", "1h", "2d", or compound like "3m30s".`,
                                },
                            ],
                            details: undefined,
                        };
                    }

                    const now = new Date();
                    const fireAt = new Date(now.getTime() + delayMs);
                    const id = generateId();

                    const cb: ScheduledCallback = {
                        id,
                        message: params.message,
                        fireAt: fireAt.toISOString(),
                        createdAt: now.toISOString(),
                        source: "agent",
                        fired: false,
                        linkedJobId: params.jobId || undefined,
                    };

                    scheduleCallback(cb);
                    persistState();

                    let result =
                        `Callback ${id} scheduled.\n` +
                        `Message: ${params.message}\n` +
                        `Fires: ${fireAt.toISOString()} (${formatDuration(delayMs)} from now)`;

                    if (params.jobId) {
                        result += `\nLinked to job: ${params.jobId} (auto-cancels on job completion)`;

                        // Let the agent know it can work on other things — the system delivers the callback
                        result += "\n\nA callback has been registered on this job. You will be notified when it fires or the job completes — no need to poll. In the meantime, you can work on other things.";

                        // Subscribe triggers on the existing job
                        const triggersRaw = params.triggers;
                        if (triggersRaw && Array.isArray(triggersRaw) && triggersRaw.length > 0) {
                            const job = state.backgroundJobs.get(params.jobId);
                            if (job && job.status === "running") {
                                const newTriggers = triggersRaw as JobTrigger[];
                                job.triggers = [...(job.triggers ?? []), ...newTriggers];
                                result += `\nSubscribed ${newTriggers.length} trigger(s): ` +
                                    newTriggers.map((t) => `${t.type}=${t.value}`).join(", ");
                            } else {
                                result += `\nWarning: job ${params.jobId} not found or not running — triggers not subscribed`;
                            }
                        }
                    }

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: result,
                            },
                        ],
                        details: undefined,
                    };
                }

            }
        },
    });

    // ── User command: /remind ───────────────────────────────────────

    pi.registerCommand("remind", {
        description:
            "Schedule a callback: /remind 2m check the deploy | /remind list | /remind cancel <id> | /remind cancel-all",
        handler: async (args, ctx: ExtensionCommandContext) => {
            if (!isFeatureEnabled(state, "callbacks")) {
                ctx.ui.notify(
                    "Callbacks are disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            const trimmed = args.trim();

            if (trimmed === "list") {
                if (callbacks.size === 0) {
                    ctx.ui.notify("No pending callbacks.", "info");
                } else {
                    const lines = Array.from(callbacks.values())
                        .filter((cb) => !cb.fired)
                        .map((cb) => {
                            const relative = formatRelative(cb.fireAt);
                            return `  ${cb.id}: "${cb.message}" — ${relative} (${cb.source})`;
                        });
                    ctx.ui.notify(
                        `Pending callbacks:\n${lines.join("\n")}`,
                        "info"
                    );
                }
                return;
            }

            if (trimmed === "cancel-all" || trimmed === "clear") {
                const count = cancelAll();
                ctx.ui.notify(`Cancelled ${count} callback(s).`, "info");
                return;
            }

            const cancelMatch = trimmed.match(/^cancel\s+(\S+)$/);
            if (cancelMatch) {
                const id = cancelMatch[1];
                if (cancelCallback(id)) {
                    ctx.ui.notify(`Callback ${id} cancelled.`, "info");
                } else {
                    ctx.ui.notify(`Callback ${id} not found.`, "warning");
                }
                return;
            }

            // Parse: /remind <duration> <message>
            const parts = trimmed.split(/\s+/);
            if (parts.length < 2) {
                ctx.ui.notify(
                    "Usage: /remind <duration> <message> | /remind list | /remind cancel <id>",
                    "warning"
                );
                return;
            }

            const delayMs = parseDurationToMs(parts[0]);
            if (delayMs === null) {
                ctx.ui.notify(
                    `Invalid duration "${parts[0]}". Use 30s, 5m, 1h, 2d, or compound like 3m30s.`,
                    "warning"
                );
                return;
            }

            const message = parts.slice(1).join(" ");
            const now = new Date();
            const fireAt = new Date(now.getTime() + delayMs);
            const id = generateId();

            const cb: ScheduledCallback = {
                id,
                message,
                fireAt: fireAt.toISOString(),
                createdAt: now.toISOString(),
                source: "user",
                fired: false,
            };

            scheduleCallback(cb);
            persistState();

            ctx.ui.notify(
                `Callback ${id} scheduled: "${message}" — fires ${formatDuration(delayMs)} from now.`,
                "info"
            );
        },
    });

    // ── External callback helper: /callback-dir ────────────────────

    pi.registerCommand("callback-dir", {
        description:
            "Print the directory where external processes can write callback files",
        handler: async (_args, ctx) => {
            if (!isFeatureEnabled(state, "callbacks")) {
                ctx.ui.notify(
                    "Callbacks are disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            const dir = callbacksDir(ctx.sessionManager.getSessionId());
            ctx.ui.notify(
                `External callbacks: write JSON files to ${dir}\n` +
                    `Format: { "message": "your message" }`,
                "info"
            );
        },
    });
}
