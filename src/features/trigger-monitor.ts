/**
 * Trigger monitor for background jobs.
 *
 * Watches a running job's subscribed triggers and fires a `bg-trigger`
 * custom event (delivered as a follow-up agent turn) when a condition
 * is met. Triggers are one-shot: after firing they are removed from the
 * job, and the monitor stops itself once no triggers remain or the job
 * is no longer running.
 *
 * The monitor is started lazily when triggers are first subscribed via
 * the `remind` tool, so jobs created before any subscription are covered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import type { BackgroundJob, JobTrigger } from "../types.ts";
import { evaluateTrigger, makeTriggerAccum } from "./trigger-check.ts";

const TRIGGER_POLL_MS = 2_000;

/** Render a trigger as `type=value` (or `type=/pattern/` for outputMatch). */
export function triggerLabel(t: JobTrigger): string {
    if (t.type === "outputMatch") {
        const flags = t.caseSensitive ? "" : "i";
        return `${t.type}=/${t.pattern}/${flags}`;
    }
    return `${t.type}=${t.value}`;
}

/** Cosmetic count of other still-running jobs for notification suffixes. */
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
 * Start a periodic poller that watches a background job's triggers and
 * fires a `bg-trigger` custom event when a condition is met (or the
 * trigger cannot be evaluated, e.g. an invalid regex pattern).
 *
 * Returns a cancel function. The monitor also stops itself when the job
 * is no longer running or all triggers have fired, clearing
 * `job.cancelTriggerMonitor` so a later subscription on the same running
 * job starts a fresh monitor.
 */
export function startTriggerMonitor(
    job: BackgroundJob,
    pi: ExtensionAPI,
    state: TauState,
    pollMs: number = TRIGGER_POLL_MS
): () => void {
    let cancelled = false;
    // wallTime counts from the job's spawn time, not from when the
    // monitor started (the monitor is started lazily on subscription).
    const acc = makeTriggerAccum(job.startTime);

    const stop = (): void => {
        cancelled = true;
        clearInterval(timer);
        // Only clear the job's stored stop fn if it still points at this
        // monitor, so a newer monitor is never clobbered.
        if (job.cancelTriggerMonitor === stop) {
            job.cancelTriggerMonitor = undefined;
        }
    };

    const timer = setInterval(() => {
        if (cancelled || job.status !== "running") {
            stop();
            return;
        }

        const remaining: JobTrigger[] = [];
        for (const t of job.triggers ?? []) {
            try {
                const result = evaluateTrigger(t, job.pid, job.logPath, acc);
                if (result.met || result.error) {
                    const suffix = outstandingJobsSuffix(state, job.id);
                    const errorPart = result.error ? ` — ${result.error}` : "";
                    const matchPart = result.matchText
                        ? `\nMatched: ${result.matchText}`
                        : "";
                    pi.sendMessage(
                        {
                            customType: "bg-trigger",
                            content:
                                `\u26a1 ${job.id} trigger: ${triggerLabel(t)} ` +
                                `(current: ${result.current})${errorPart}${suffix}\n` +
                                `Command: ${job.command}\nLog: ${job.logPath}${matchPart}`,
                            display: true,
                            details: {
                                jobId: job.id,
                                triggerType: t.type,
                                threshold:
                                    t.type === "outputMatch"
                                        ? t.pattern
                                        : t.value,
                                current: result.current,
                                matchText: result.matchText,
                                error: result.error,
                            },
                        },
                        { deliverAs: "followUp", triggerTurn: true }
                    );
                    continue; // one-shot: drop the fired trigger
                }
            } catch {
                // Transient read failure (log not ready, /proc race) — retry.
            }
            remaining.push(t);
        }
        job.triggers = remaining.length > 0 ? remaining : undefined;
        if (job.triggers === undefined) {
            stop();
        }
    }, pollMs);
    timer.unref();

    return stop;
}

/**
 * Start a trigger monitor for a job if none is active, and return the
 * active stop function. Jobs may be subscribed to triggers repeatedly
 * over their lifetime; after a monitor self-stops (one-shot fire or job
 * completion) this starts a fresh one for the next subscription.
 *
 * Returns undefined when no monitor should run (e.g. the job is no
 * longer running).
 */
export function ensureTriggerMonitor(
    job: BackgroundJob,
    pi: ExtensionAPI,
    state: TauState,
    pollMs: number = TRIGGER_POLL_MS
): (() => void) | undefined {
    if (job.cancelTriggerMonitor) return job.cancelTriggerMonitor;
    if (job.status !== "running") return undefined;
    job.cancelTriggerMonitor = startTriggerMonitor(job, pi, state, pollMs);
    return job.cancelTriggerMonitor;
}
