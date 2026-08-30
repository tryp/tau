/**
 * Configurable autonomous wake evaluation for actionable background work.
 *
 * The feature is deliberately opt-in. It periodically inspects TauState and
 * queues at most one keyed follow-up so a sleeping session can notice work
 * that needs attention without waking for healthy running jobs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";
import { walkProjectLayers } from "./features-files.ts";

export const WAKEUP_DEFAULT_INTERVAL_MS = 240_000;
export const WAKEUP_MIN_INTERVAL_MS = 10_000;
export const WAKEUP_MAX_INTERVAL_MS = 3_600_000;
export const WAKEUP_QUEUE_KEY = "tau:wakeup";
export const WAKEUP_MESSAGE_MAX_CHARS = 2_000;

export interface WakeupConfig {
    enabled: boolean;
    intervalMs: number;
}

const DEFAULT_CONFIG: WakeupConfig = {
    enabled: false,
    intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInterval(value: number): number {
    return Math.min(
        WAKEUP_MAX_INTERVAL_MS,
        Math.max(WAKEUP_MIN_INTERVAL_MS, Math.round(value))
    );
}

/** Parse a `tau.wakeup` object, returning defaults for omitted fields. */
export function parseWakeupConfig(raw: unknown): WakeupConfig | undefined {
    if (!isRecord(raw)) return undefined;

    // Accept both the namespace block (the settings loader uses this) and a
    // complete settings object (convenient for callers and unit tests).
    let block: Record<string, unknown> = raw;
    if (isRecord(raw.tau)) {
        const tau = raw.tau;
        if (isRecord(tau.wakeup)) block = tau.wakeup;
        else if (isRecord(tau.autonomousWake)) block = tau.autonomousWake;
        else return undefined;
    } else if (isRecord(raw.autonomousWake)) {
        block = raw.autonomousWake;
    }

    const result: WakeupConfig = { ...DEFAULT_CONFIG };
    if (typeof block.enabled === "boolean") result.enabled = block.enabled;
    if (
        typeof block.intervalMs === "number" &&
        Number.isFinite(block.intervalMs)
    ) {
        result.intervalMs = clampInterval(block.intervalMs);
    }
    return result;
}

function readWakeupConfigFromFile(
    path: string
): Partial<WakeupConfig> | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        const parsed = parseWakeupConfig(raw);
        if (!parsed) return undefined;
        let block: Record<string, unknown> | undefined;
        if (isRecord(raw)) {
            if (isRecord(raw.tau)) {
                const tau = raw.tau;
                block = isRecord(tau.wakeup)
                    ? tau.wakeup
                    : isRecord(tau.autonomousWake)
                      ? tau.autonomousWake
                      : undefined;
            } else if (isRecord(raw.autonomousWake)) {
                block = raw.autonomousWake;
            } else {
                block = raw;
            }
        }
        return {
            ...(block && typeof block.enabled === "boolean"
                ? { enabled: parsed.enabled }
                : {}),
            ...(block &&
            typeof block.intervalMs === "number" &&
            Number.isFinite(block.intervalMs)
                ? { intervalMs: parsed.intervalMs }
                : {}),
        };
    } catch {
        return undefined;
    }
}

/** Load global and project `tau.wakeup` settings, with project winning. */
export function loadWakeupConfig(
    cwd: string,
    pathsOverride?: { global?: string; project?: string }
): WakeupConfig {
    const paths = pathsOverride
        ? [
              pathsOverride.global ?? join(getAgentDir(), "settings.json"),
              pathsOverride.project ?? join(cwd, ".pi", "settings.json"),
          ]
        : [
              join(getAgentDir(), "settings.json"),
              ...walkProjectLayers(cwd).reverse(),
          ];
    const config: WakeupConfig = { ...DEFAULT_CONFIG };
    for (const path of paths) {
        const value = readWakeupConfigFromFile(path);
        if (value) Object.assign(config, value);
    }
    config.intervalMs = clampInterval(config.intervalMs);
    return config;
}

export type WakeupAction =
    | { kind: "pending-decision"; id: string }
    | { kind: "pending-agent"; id: string }
    | { kind: "paused" }
    | { kind: "terminal-job"; job: BackgroundJob };

function terminalJobs(state: TauState): BackgroundJob[] {
    const jobs = new Map<string, BackgroundJob>();
    for (const job of state.recentTerminalJobs) jobs.set(job.id, job);
    for (const job of state.backgroundJobs.values()) {
        if (job.status !== "running") jobs.set(job.id, job);
    }
    return Array.from(jobs.values()).filter(
        (job) =>
            (job.status === "failed" || job.status === "completed") &&
            !job.outputConsumed &&
            !job.completionNotified &&
            !job.suppressAutonomousWake
    );
}

/** Return actionable state; ordinary healthy running jobs are excluded. */
export function collectWakeupActions(state: TauState): WakeupAction[] {
    const actions: WakeupAction[] = [];
    const decisionId = state.pendingDecisionJobId;
    if (decisionId !== undefined) {
        const job = state.backgroundJobs.get(decisionId);
        if (job?.status === "running") {
            actions.push({ kind: "pending-decision", id: decisionId });
        }
    }

    for (const pending of state.pendingBackgroundAgents.values()) {
        actions.push({ kind: "pending-agent", id: pending.jobId });
    }
    if (state.agentBackgrounded) actions.push({ kind: "paused" });
    for (const job of terminalJobs(state)) {
        actions.push({ kind: "terminal-job", job });
    }
    return actions;
}

function actionKey(action: WakeupAction): string {
    switch (action.kind) {
        case "pending-decision":
            return `decision:${action.id}`;
        case "pending-agent":
            return `agent:${action.id}`;
        case "paused":
            return "paused";
        case "terminal-job":
            return `terminal:${action.job.id}:${action.job.status}`;
    }
}

function actionText(action: WakeupAction): string {
    switch (action.kind) {
        case "pending-decision":
            return `Background job ${action.id} is awaiting a keep, kill, or check decision.`;
        case "pending-agent":
            return `Background agent ${action.id} is queued until the parent turn settles.`;
        case "paused":
            return "The agent is paused and needs to be resumed or inspected.";
        case "terminal-job":
            return `Background job ${action.job.id} ${action.job.status} and its output has not been acknowledged.`;
    }
}

function sendWakeup(pi: ExtensionAPI, content: string): void {
    (
        pi as ExtensionAPI & {
            sendMessage: (
                message: {
                    customType: string;
                    content: string;
                    display: boolean;
                },
                options: {
                    deliverAs: "followUp";
                    triggerTurn: boolean;
                    queueKey: string;
                }
            ) => void;
        }
    ).sendMessage(
        { customType: "tau-autonomous-wake", content, display: true },
        { deliverAs: "followUp", triggerTurn: true, queueKey: WAKEUP_QUEUE_KEY }
    );
}

function hasWakeupCancellation(pi: ExtensionAPI): boolean {
    return (
        typeof (
            pi as ExtensionAPI & {
                cancelQueuedMessage?: (queueKey: string) => void;
            }
        ).cancelQueuedMessage === "function"
    );
}

export function cancelQueuedWakeup(pi: ExtensionAPI): boolean {
    const cancel = (
        pi as ExtensionAPI & {
            cancelQueuedMessage?: (queueKey: string) => void;
        }
    ).cancelQueuedMessage;
    if (typeof cancel !== "function") return false;
    cancel(WAKEUP_QUEUE_KEY);
    return true;
}

/** Evaluate now. Returns true when a wake follow-up was queued. */
export function evaluateWakeup(pi: ExtensionAPI, state: TauState): boolean {
    // Without deterministic queue cancellation, a changed or resolved snapshot
    // could leave a stale follow-up (or enqueue a duplicate) on older hosts.
    // Disable autonomous delivery rather than pretending replacement worked.
    if (!hasWakeupCancellation(pi)) {
        state.wakeupLastSignature = undefined;
        return false;
    }

    const actions = collectWakeupActions(state);
    const signature = actions.map(actionKey).sort().join("|");
    if (!signature) {
        cancelQueuedWakeup(pi);
        state.wakeupLastSignature = undefined;
        return false;
    }
    if (state.wakeupLastSignature === signature) return false;

    // A changed snapshot replaces the prior queued wake, preventing two
    // autonomous turns from representing successive snapshots.
    if (state.wakeupLastSignature !== undefined) cancelQueuedWakeup(pi);

    const lines = actions.map(actionText).join("\n");
    const content =
        `Autonomous wake: ${actions.length} background item${actions.length === 1 ? "" : "s"} need attention.\n` +
        lines;
    sendWakeup(
        pi,
        content.length <= WAKEUP_MESSAGE_MAX_CHARS
            ? content
            : `${content.slice(0, WAKEUP_MESSAGE_MAX_CHARS - 1)}…`
    );
    state.wakeupLastSignature = signature;
    return true;
}

/** Register the opt-in timer and its session lifecycle cleanup. */
export function registerWakeup(pi: ExtensionAPI, state: TauState): void {
    let timer: ReturnType<typeof setInterval> | undefined;
    let active = false;

    const stop = (): void => {
        if (timer) clearInterval(timer);
        timer = undefined;
        active = false;
        state.wakeupLastSignature = undefined;
        cancelQueuedWakeup(pi);
    };

    // Existing lifecycle handlers can request an immediate re-evaluation after
    // pending-decision/completion cancellation without importing this module.
    state.wakeupEvaluate = () => {
        if (active) evaluateWakeup(pi, state);
    };
    state.wakeupCancel = stop;

    pi.on("session_start", async (_event, ctx) => {
        stop();
        const config = loadWakeupConfig(ctx.cwd);
        if (!config.enabled) return;
        // Autonomous delivery requires queue cancellation. Older hosts do not
        // expose it, so leave the feature inactive rather than delivering wakes
        // that cannot be retracted when their state is acknowledged.
        if (!hasWakeupCancellation(pi)) return;
        active = true;
        timer = setInterval(() => evaluateWakeup(pi, state), config.intervalMs);
        timer.unref();
    });

    pi.on("session_shutdown", async () => {
        stop();
        if (state.wakeupEvaluate) state.wakeupEvaluate = undefined;
        if (state.wakeupCancel) state.wakeupCancel = undefined;
    });
}
