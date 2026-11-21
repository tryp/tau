/**
 * Configurable autonomous wake evaluation for background work.
 *
 * One timer and one queue key drive two rules:
 *
 * - attention: pending decisions, queued agents, paused state, unacknowledged
 *   terminal output, or a provider-reported attention item. Signature-deduped,
 *   so one snapshot cannot wake the session twice.
 * - heartbeat: work that is still running while the parent has been idle for a
 *   full interval. The wake carries a status summary so the parent can decide
 *   whether to check in or steer, and it keeps the parent's prompt cache warm
 *   under a long-running child. The default interval (4 min) sits below the
 *   provider cache TTL (pi-mono `CACHE_TTL_MS`, 5 min). One wake per interval,
 *   replacing the queued wake rather than stacking on it.
 *
 * Both rules share `WAKEUP_QUEUE_KEY`, so a heartbeat and an attention wake can
 * never both be waiting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";
import { formatDuration } from "../utils.ts";
import { walkProjectLayers } from "./features-files.ts";

export const WAKEUP_DEFAULT_INTERVAL_MS = 240_000;
export const WAKEUP_MIN_INTERVAL_MS = 10_000;
export const WAKEUP_MAX_INTERVAL_MS = 3_600_000;
export const WAKEUP_QUEUE_KEY = "tau:wakeup";
export const WAKEUP_MESSAGE_MAX_CHARS = 2_000;
/** Items listed in one heartbeat before the remainder is counted. */
export const WAKEUP_HEARTBEAT_MAX_ITEMS = 8;
/** Per-item summary budget inside a heartbeat message. */
export const WAKEUP_WORK_SUMMARY_MAX_CHARS = 400;
/** Delay before re-sampling the idle event while the parent is mid-turn. */
export const WAKEUP_IDLE_RECHECK_MS = 30_000;
/** Per-job command budget inside a heartbeat message. */
const WAKEUP_JOB_COMMAND_MAX_CHARS = 90;

export interface WakeupConfig {
    enabled: boolean;
    intervalMs: number;
}

/**
 * Both rules are on by default: a parent that launched background work and then
 * idled is the case this feature exists for, and a wake it never receives is
 * indistinguishable from a feature that is switched off. `tau.wakeup.enabled:
 * false` opts out of both.
 */
const DEFAULT_CONFIG: WakeupConfig = {
    enabled: true,
    intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
/**
 * Registry protocol versions this reader understands. v2 adds an optional
 * per-item `summary`; v1 remains readable so a provider that has not been
 * redeployed keeps contributing attention and active work.
 */
const BACKGROUND_WORK_PROTOCOL_VERSIONS: readonly number[] = [1, 2];
const BACKGROUND_WORK_SUMMARY_SINCE_VERSION = 2;
const BACKGROUND_WORK_MAX_PROVIDERS = 100;
const BACKGROUND_WORK_MAX_ITEMS_PER_PROVIDER = 10_000;
const BACKGROUND_WORK_MAX_NAME_CHARS = 128;
const BACKGROUND_WORK_MAX_ID_CHARS = 256;

type ProviderWorkKind = "attention" | "active";

export interface ProviderWorkEntry {
    provider: string;
    id: string;
    summary?: string;
}

type ProviderWorkFailure =
    | "unsupported-version"
    | "malformed-registry"
    | "malformed-provider"
    | "malformed-item";

interface ProviderWork {
    entries: ProviderWorkEntry[];
    failure?: ProviderWorkFailure;
}

type ProviderAttentionAction = {
    kind: "provider-attention";
    provider: string;
    id: string;
};

function isBoundedString(value: unknown, maxChars: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= maxChars &&
        value.trim() === value &&
        !value.includes("\0")
    );
}

const INVALID_SUMMARY = Symbol("invalid-summary");

function readItemSummary(
    item: Record<string, unknown>,
    version: number
): string | undefined | typeof INVALID_SUMMARY {
    if (!Object.hasOwn(item, "summary") || item.summary === undefined) {
        return undefined;
    }
    // A provider that declares v1 has no summary field in its contract, so a
    // summary there means the registry was written from a different shape than
    // it declares.
    if (version < BACKGROUND_WORK_SUMMARY_SINCE_VERSION) return INVALID_SUMMARY;
    const summary = item.summary;
    if (!isBoundedString(summary, WAKEUP_WORK_SUMMARY_MAX_CHARS)) {
        return INVALID_SUMMARY;
    }
    // One line per item keeps the wake message predictable; a multi-line
    // summary would let a provider restructure the message.
    if (summary.includes("\n")) return INVALID_SUMMARY;
    return summary;
}

/**
 * Read the optional background-work registry without importing its owning
 * extension. `attention` is the subset that needs a decision; `active` is work
 * in progress, which feeds the heartbeat. Any malformed registry, provider, or
 * item disables this integration for the current evaluation while preserving
 * local Tau wakes.
 */
function collectProviderWork(
    kind: ProviderWorkKind,
    sessionId: string | undefined
): ProviderWork {
    if (!sessionId) return { entries: [] };

    try {
        const globalObject = globalThis as Record<PropertyKey, unknown>;
        const registry = globalObject[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)];
        if (registry === undefined) return { entries: [] };
        if (!isRecord(registry)) {
            return { entries: [], failure: "malformed-registry" };
        }
        const version = registry.version;
        if (
            typeof version !== "number" ||
            !BACKGROUND_WORK_PROTOCOL_VERSIONS.includes(version)
        ) {
            return { entries: [], failure: "unsupported-version" };
        }
        if (
            !(registry.providers instanceof Map) ||
            registry.providers.size > BACKGROUND_WORK_MAX_PROVIDERS
        ) {
            return { entries: [], failure: "malformed-registry" };
        }

        const entries: ProviderWorkEntry[] = [];
        const keys = new Set<string>();
        for (const [registryKey, candidate] of registry.providers) {
            if (
                typeof registryKey !== "string" ||
                !isRecord(candidate) ||
                !isBoundedString(
                    candidate.name,
                    BACKGROUND_WORK_MAX_NAME_CHARS
                ) ||
                candidate.name !== registryKey ||
                typeof candidate.listActiveWork !== "function"
            ) {
                return { entries: [], failure: "malformed-provider" };
            }
            const listWork =
                kind === "attention"
                    ? candidate.listAttentionWork
                    : candidate.listActiveWork;
            if (listWork === undefined) continue;
            if (typeof listWork !== "function") {
                return { entries: [], failure: "malformed-provider" };
            }

            const items = (
                listWork as (this: Record<string, unknown>) => unknown
            ).call(candidate);
            if (
                !Array.isArray(items) ||
                items.length > BACKGROUND_WORK_MAX_ITEMS_PER_PROVIDER
            ) {
                return { entries: [], failure: "malformed-provider" };
            }
            for (const item of items) {
                if (
                    !isRecord(item) ||
                    !isBoundedString(item.id, BACKGROUND_WORK_MAX_ID_CHARS) ||
                    !isBoundedString(
                        item.sessionId,
                        BACKGROUND_WORK_MAX_ID_CHARS
                    )
                ) {
                    return { entries: [], failure: "malformed-item" };
                }
                const summary = readItemSummary(item, version);
                if (summary === INVALID_SUMMARY) {
                    return { entries: [], failure: "malformed-item" };
                }
                if (item.sessionId !== sessionId) continue;
                const key = JSON.stringify([candidate.name, item.id]);
                if (keys.has(key)) continue;
                keys.add(key);
                entries.push({
                    provider: candidate.name,
                    id: item.id,
                    ...(summary === undefined ? {} : { summary }),
                });
            }
        }
        return { entries };
    } catch {
        return { entries: [], failure: "malformed-registry" };
    }
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
    | { kind: "terminal-job"; job: BackgroundJob }
    | ProviderAttentionAction;

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

/** Return actionable state; ordinary healthy running work is handled by the heartbeat instead. */
export function collectWakeupActions(
    state: TauState,
    providerAttention: readonly ProviderWorkEntry[] = []
): WakeupAction[] {
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
    for (const entry of providerAttention) {
        actions.push({
            kind: "provider-attention",
            provider: entry.provider,
            id: entry.id,
        });
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
        case "provider-attention":
            return `provider:${JSON.stringify([action.provider, action.id])}`;
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
        case "provider-attention":
            return `Background work ${action.provider}/${action.id} needs attention.`;
    }
}

function sendWakeup(pi: ExtensionAPI, content: string): void {
    // A key identifies a queued message; the host's queue appends rather than
    // replacing by key, so retract the superseded wake before enqueuing the new
    // snapshot. Without this a heartbeat queued during settlement and the
    // attention wake that follows it are both delivered, spending two
    // autonomous turns on one state.
    cancelQueuedWakeup(pi);
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

export type WakeupTelemetryEvent =
    | "attention-sent"
    | "heartbeat-sent"
    | "heartbeat-resampled"
    | "skipped-no-cancellation"
    | "registry-failure";

/**
 * Persist one wake decision so a later query can tell a quiet engine from a
 * broken one. Delivery never depends on this: an unavailable append must not
 * cost the wake.
 */
function recordWakeupTelemetry(
    pi: ExtensionAPI,
    event: WakeupTelemetryEvent,
    details: Record<string, unknown> = {}
): void {
    try {
        pi.appendEntry("tau_wakeup_telemetry", {
            version: 1,
            event,
            at: Date.now(),
            ...details,
        });
    } catch {
        // Telemetry is diagnostic only.
    }
}

/**
 * Record a registry failure once per distinct failure instead of once per tick.
 * The counter is the point: a rejected registry disables provider wakes, and
 * without this entry that looks exactly like a session with no background work.
 */
function reportProviderFailure(
    pi: ExtensionAPI,
    state: TauState,
    failure: ProviderWorkFailure | undefined
): void {
    if (!failure) {
        state.wakeupLastRegistryFailure = undefined;
        return;
    }
    if (state.wakeupLastRegistryFailure === failure) return;
    state.wakeupLastRegistryFailure = failure;
    recordWakeupTelemetry(pi, "registry-failure", { failure });
}

export interface WakeupHeartbeatSource {
    kind: "job" | "provider";
    label: string;
    summary: string;
}

function singleLine(value: string, maxChars: number): string {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return collapsed.length <= maxChars
        ? collapsed
        : `${collapsed.slice(0, maxChars - 1)}…`;
}

function jobHeartbeatSummary(job: BackgroundJob, now: number): string {
    const elapsed = formatDuration(Math.max(0, now - job.startTime));
    return `${singleLine(job.command, WAKEUP_JOB_COMMAND_MAX_CHARS)} | running ${elapsed}`;
}

/**
 * Running background work, local jobs first. This is the heartbeat's input and
 * deliberately excludes anything already reported as attention: work that needs
 * a decision wakes under its own rule.
 */
export function collectHeartbeatSources(
    state: TauState,
    providerActive: readonly ProviderWorkEntry[] = [],
    now = Date.now()
): WakeupHeartbeatSource[] {
    const sources: WakeupHeartbeatSource[] = [];
    const jobs = [...state.backgroundJobs.values()]
        .filter((job) => job.status === "running" && job.isBackgrounded)
        .sort((left, right) => left.startTime - right.startTime);
    for (const job of jobs) {
        sources.push({
            kind: "job",
            label: `job ${job.id}`,
            summary: jobHeartbeatSummary(job, now),
        });
    }
    for (const entry of providerActive) {
        sources.push({
            kind: "provider",
            label: `${entry.provider}/${entry.id}`,
            summary: singleLine(
                entry.summary ?? "running",
                WAKEUP_WORK_SUMMARY_MAX_CHARS
            ),
        });
    }
    return sources;
}

export function formatHeartbeatMessage(
    sources: readonly WakeupHeartbeatSource[],
    intervalMs: number
): string {
    const shown = sources.slice(0, WAKEUP_HEARTBEAT_MAX_ITEMS);
    const hidden = sources.length - shown.length;
    const lines = shown.map((source) => `- ${source.label}: ${source.summary}`);
    if (hidden > 0) lines.push(`- and ${hidden} more`);
    const content = [
        `Autonomous heartbeat: ${sources.length} background item${sources.length === 1 ? "" : "s"} still running; nothing needs a decision.`,
        ...lines,
        "",
        `No action needed unless one looks stuck. Reply briefly to keep the context warm, or check with jobs / subagent status and steer if it does. Next heartbeat in ${formatDuration(intervalMs)}.`,
    ].join("\n");
    return content.length <= WAKEUP_MESSAGE_MAX_CHARS
        ? content
        : `${content.slice(0, WAKEUP_MESSAGE_MAX_CHARS - 1)}…`;
}

export interface WakeupEvaluationOptions {
    now?: () => number;
    /** Heartbeat interval; without it no heartbeat is evaluated. */
    intervalMs?: number;
    /** Epoch ms at which the parent's last model request started. */
    parentRequestStartedAt?: number;
}

/**
 * Queue one heartbeat when work is in flight and the parent has been idle for a
 * full interval. Returns true when a wake was queued.
 */
function evaluateHeartbeat(
    pi: ExtensionAPI,
    state: TauState,
    sessionId: string | undefined,
    options: WakeupEvaluationOptions
): boolean {
    const intervalMs = options.intervalMs;
    const parentRequestStartedAt = options.parentRequestStartedAt;
    // A call site that cannot say how long the parent has been idle cannot
    // heartbeat: the wake exists to close a long idle gap, and without the
    // anchor every evaluation would look like one.
    if (intervalMs === undefined || parentRequestStartedAt === undefined) {
        return false;
    }
    const now = options.now ? options.now() : Date.now();
    const idleMs = Math.max(0, now - parentRequestStartedAt);
    if (idleMs < intervalMs) return false;

    const providerActive = collectProviderWork("active", sessionId);
    reportProviderFailure(pi, state, providerActive.failure);
    const sources = collectHeartbeatSources(state, providerActive.entries, now);
    if (sources.length === 0) return false;

    sendWakeup(pi, formatHeartbeatMessage(sources, intervalMs));
    state.wakeupQueuedKind = "heartbeat";
    state.wakeupLastHeartbeatAt = now;
    recordWakeupTelemetry(pi, "heartbeat-sent", {
        items: sources.length,
        jobs: sources.filter((source) => source.kind === "job").length,
        providers: sources.filter((source) => source.kind === "provider")
            .length,
        intervalMs,
        idleMs,
    });
    return true;
}

/** Evaluate now. Returns true when a wake follow-up was queued. */
export function evaluateWakeup(
    pi: ExtensionAPI,
    state: TauState,
    sessionId?: string,
    options: WakeupEvaluationOptions = {}
): boolean {
    if (state.wakeupShutdownBegun) return false;
    // Without deterministic queue cancellation, a changed or resolved snapshot
    // could leave a stale follow-up (or enqueue a duplicate) on older hosts.
    // Disable autonomous delivery rather than pretending replacement worked.
    if (!hasWakeupCancellation(pi)) {
        state.wakeupLastSignature = undefined;
        recordWakeupTelemetry(pi, "skipped-no-cancellation");
        return false;
    }

    const providerAttention = collectProviderWork("attention", sessionId);
    reportProviderFailure(pi, state, providerAttention.failure);
    const actions = collectWakeupActions(state, providerAttention.entries);
    const signature = actions.map(actionKey).sort().join("|");
    if (!signature) {
        cancelQueuedWakeup(pi);
        state.wakeupLastSignature = undefined;
        return evaluateHeartbeat(pi, state, sessionId, options);
    }
    if (state.wakeupLastSignature === signature) return false;

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
    state.wakeupQueuedKind = "attention";
    recordWakeupTelemetry(pi, "attention-sent", {
        items: actions.length,
        kinds: [...new Set(actions.map((action) => action.kind))],
    });
    state.wakeupLastSignature = signature;
    return true;
}

/**
 * Register the timer and its session lifecycle cleanup.
 *
 * The timer is a self-rescheduling timeout anchored to the parent's last model
 * request, not a fixed interval. The prompt cache is written at request start,
 * so `last request start + interval` is the gap the heartbeat exists to close;
 * a fixed tick would measure the wrong thing and could skip a wake whenever the
 * parent happened to be busy at the tick.
 *
 * A busy parent is re-sampled every WAKEUP_IDLE_RECHECK_MS: the idle event is
 * the condition and the re-sample is the backstop, so a wake never interrupts a
 * turn that is already keeping the cache warm. A re-sample is one `isIdle()`
 * call: no registry read, no directory scan.
 */
export function registerWakeup(pi: ExtensionAPI, state: TauState): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    let sessionId: string | undefined;
    let intervalMs = WAKEUP_DEFAULT_INTERVAL_MS;
    let lastRequestStartedAt = Date.now();
    let sawRequestStart = false;
    let idleRechecks = 0;
    let latestContext: ExtensionContext | undefined;

    const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };

    const schedule = (delayMs: number): void => {
        if (!active) return;
        clearTimer();
        timer = setTimeout(
            tick,
            Math.max(0, Math.min(intervalMs, Math.round(delayMs)))
        );
        timer.unref?.();
    };

    /**
     * True when nothing is running on the parent side. Hosts without the probe
     * fall through to the idle-duration check, which still bounds the wake.
     * A stale context answers false: a throw here must not wake a session whose
     * turn state cannot be read.
     */
    const isParentIdle = (): boolean => {
        const ctx = latestContext;
        if (!ctx || typeof ctx.isIdle !== "function") return true;
        try {
            return ctx.isIdle() !== false;
        } catch {
            return false;
        }
    };

    const stop = (): void => {
        clearTimer();
        active = false;
        sessionId = undefined;
        idleRechecks = 0;
        state.wakeupLastSignature = undefined;
        state.wakeupQueuedKind = undefined;
        cancelQueuedWakeup(pi);
    };

    function tick(): void {
        timer = undefined;
        if (!active || state.wakeupShutdownBegun) return;
        const now = Date.now();
        const idleMs = now - lastRequestStartedAt;
        if (idleMs < intervalMs) {
            schedule(intervalMs - idleMs);
            return;
        }
        if (!isParentIdle()) {
            idleRechecks += 1;
            if (idleRechecks === 1) {
                recordWakeupTelemetry(pi, "heartbeat-resampled", {
                    recheckMs: WAKEUP_IDLE_RECHECK_MS,
                    intervalMs,
                });
            }
            schedule(WAKEUP_IDLE_RECHECK_MS);
            return;
        }
        const sent = evaluateWakeup(pi, state, sessionId, {
            now: () => now,
            intervalMs,
            parentRequestStartedAt: lastRequestStartedAt,
        });
        if (sent) idleRechecks = 0;
        schedule(intervalMs);
    }

    const noteRequestStart = (): void => {
        lastRequestStartedAt = Date.now();
        sawRequestStart = true;
        if (!active) return;
        // A queued heartbeat describes a session that was waiting a full
        // interval for news. The request starting now is that news, and the
        // prompt cache is being written again, so the queued heartbeat is stale
        // by definition: retract it rather than let it spend a second turn.
        // Retracting an already-delivered wake returns false and changes
        // nothing.
        if (state.wakeupQueuedKind === "heartbeat") {
            cancelQueuedWakeup(pi);
            state.wakeupQueuedKind = undefined;
        }
        // Re-anchor to this request so the next wake is due one interval after
        // the cache was last written, not one interval after the last tick.
        schedule(intervalMs);
    };

    // Existing lifecycle handlers can request an immediate re-evaluation after
    // pending-decision/completion cancellation without importing this module.
    state.wakeupEvaluate = () => {
        if (!active) return;
        evaluateWakeup(pi, state, sessionId, {
            now: () => Date.now(),
            intervalMs,
            parentRequestStartedAt: lastRequestStartedAt,
        });
    };
    state.wakeupCancel = stop;

    pi.on("message_start", (event, ctx) => {
        if (ctx) latestContext = ctx;
        if (event.message?.role === "assistant") noteRequestStart();
    });

    // Hosts that do not emit `message_start` still anchor the deadline, one
    // response late; the flag records which signal actually landed.
    pi.on("message_end", (event, ctx) => {
        if (ctx) latestContext = ctx;
        if (event.message?.role !== "assistant") return;
        if (!sawRequestStart) noteRequestStart();
        sawRequestStart = false;
    });

    pi.on("session_start", async (_event, ctx) => {
        state.wakeupShutdownBegun = false;
        stop();
        latestContext = ctx;
        const config = loadWakeupConfig(ctx.cwd);
        intervalMs = config.intervalMs;
        lastRequestStartedAt = Date.now();
        sawRequestStart = false;
        if (!config.enabled) return;
        // Autonomous delivery requires queue cancellation. Older hosts do not
        // expose it, so leave the feature inactive rather than delivering wakes
        // that cannot be retracted when their state is acknowledged.
        if (!hasWakeupCancellation(pi)) {
            recordWakeupTelemetry(pi, "skipped-no-cancellation", {
                reason: "session-start",
            });
            return;
        }
        sessionId = ctx.sessionManager.getSessionId();
        active = true;
        schedule(intervalMs);
    });

    pi.on("session_shutdown", async () => {
        stop();
        latestContext = undefined;
        if (state.wakeupEvaluate) state.wakeupEvaluate = undefined;
        if (state.wakeupCancel) state.wakeupCancel = undefined;
    });
}
