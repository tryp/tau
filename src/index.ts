/**
 * Tau (τ) — Quality-of-Life Extension for pi
 *
 * Background tasks, notifications, plan mode, presets, and other enhancements.
 *
 * Tools: bash (overridden), bash_bg, jobs, job_decide, task,
 *        enter_plan_mode, exit_plan_mode
 * Commands: /bg, /fg, /jobs, /tasks, /tools, /plan, /perm, /bookmark,
 *           /unbookmark, /context, /footer, /goal, /notifications, /preset,
 *           /session-name, /summarize
 * Shortcuts: Ctrl+Alt+B (background/resume), Ctrl+Alt+J / Shift+Down (tasks),
 *            Ctrl+Alt+X (kill), Ctrl+Alt+P (plan mode), Ctrl+Shift+U (preset cycle),
 *            Ctrl+Shift+M (permission mode cycle), Ctrl+Shift+T (thinking level)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { TauState } from "./state.ts";
import { cleanupStaleLogs, detectNonInteractive } from "./utils.ts";
import { registerPipeNerf } from "./features/pipe-nerf/index.ts";
import { registerToolHints } from "./features/tool-hints/index.ts";
import { registerTimeoutNerf } from "./features/timeout-nerf/index.ts";
import { isSafeCommand } from "./plan-utils.ts";
import { Text } from "@earendil-works/pi-tui";
import {
    initPermissionState,
    reloadSettingsIfNeeded,
    checkToolPermission,
    modeStatusText,
    modeColour,
} from "./features/permissions/index.js";
import {
    startTitlebarSpinner,
    stopTitlebarSpinner,
    startAgentTimer,
    stopAgentTimer,
    showAgentTurnComplete,
} from "./features/titlebar.ts";

// Existing features
import {
    evaluatePendingDecisionGate,
    registerBackgroundJobs,
    restoreBackgroundJobs,
} from "./features/background.ts";
import { scheduleBackgroundJobRestore } from "./features/startup-maintenance.ts";
import { scheduleSidecarPurge } from "./features/sidecar.ts";
import { registerBackgroundCommands } from "./features/background-commands.ts";
import { registerAgentBackground } from "./features/agent-background.ts";
import {
    registerPlanMode,
    PLAN_MODE_TIMEOUT_MS,
} from "./features/plan-mode.ts";
import { cancelPlanMode } from "./features/plan-tools.ts";
import { getPlanFilePath } from "./features/plan-file.ts";
import {
    registerTask,
    reconstructTaskState,
    formatTaskTree,
} from "./features/task.ts";
import {
    registerToolsSelector,
    restoreToolsFromBranch,
} from "./features/tools-selector.ts";
import {
    registerNotifications,
    shouldNotify,
    sendNotification,
} from "./features/notifications.ts";

// New integrations
import { registerBookmark } from "./features/bookmark.ts";
import { registerContextFiles } from "./features/context-files.ts";
import { registerMemory } from "./features/memory.ts";
import { registerCustomFooter } from "./features/custom-footer.ts";
// Handoff disabled — import { registerHandoff } from "./features/handoff.ts";
import { registerGoal } from "./features/goal.ts";
import { registerWorkflow } from "./features/workflow.ts";
import { registerPreset } from "./features/preset.ts";
import { registerLoop } from "./features/loop.ts";
import { registerSessionName } from "./features/session-name.ts";
import { registerSummarize } from "./features/summarize.ts";
import { registerContext } from "./features/context.ts";
import { registerWebBrowse } from "./features/web-browse/index.ts";
import { registerWebSearch } from "./features/web-search/index.ts";
import { registerAgentSdkProvider } from "./features/agent-sdk/index.ts";
import { registerClaudeResumeCommand } from "./features/claude-resume.ts";
import { buildStatusBars, readUsageSnapshot } from "./features/quota-bars.ts";
import { registerReloadTool } from "./features/reload.ts";
import { registerCallbacks } from "./features/callbacks.ts";
import { registerPermissions } from "./features/permissions/commands.js";
import { registerPlanTools } from "./features/plan-tools.js";
import { registerTauCommand } from "./features/features-register.ts";
import { registerWakeup } from "./features/wakeup.ts";
import { restoreFeaturesState } from "./features/features-state.ts";
import { isTmuxAvailable } from "./tmux.ts";
import {
    cleanupTmuxRunDir,
    schedulePeriodicTmuxRunDirCleanup,
} from "./features/bash-tmux.ts";
import {
    ORPHAN_REAPER_DEFAULT_DELAY_MS,
    ORPHAN_REAPER_DELAY_ENV,
} from "./features/tmux-orphan-reaper.ts";

export default function (pi: ExtensionAPI) {
    const state = new TauState();
    let tmuxRunDirSweepTimer: ReturnType<typeof setInterval> | undefined;

    // ── Compact renderer for job-completion messages ──────────────────

    pi.registerMessageRenderer(
        "job-completion",
        (message, _options, _theme) => {
            const d = message.details as Record<string, unknown>;
            const batch = d?.batch as
                | Array<{
                      jobId: string;
                      status: string;
                      exitCode?: number;
                      duration: string;
                      command: string;
                      logPath: string;
                  }>
                | undefined;

            if (batch && batch.length > 1) {
                // Aggregated batch format
                const completed = batch.filter((b) => b.status === "completed");
                const failed = batch.filter((b) => b.status !== "completed");
                const parts: string[] = [];
                if (completed.length > 0)
                    parts.push(`${completed.length} completed`);
                if (failed.length > 0) parts.push(`${failed.length} failed`);
                const suffix =
                    ((d?.outstandingJobs as number) ?? 0) > 0
                        ? ` (${(d?.outstandingJobs as number) ?? 0} jobs outstanding)`
                        : "";
                const header = `🏁 ${parts.join(", ")}${suffix}`;
                const lines = batch.map(
                    (b) =>
                        `  ${b.status === "completed" ? "✅" : "❌"} ${b.jobId} ${b.status} (${b.duration})${
                            b.exitCode !== undefined
                                ? `, exit ${b.exitCode}`
                                : ""
                        }`
                );
                return new Text(`${header}\n${lines.join("\n")}`, 0, 0);
            }

            // Individual format
            const emoji =
                batch && batch.length === 1
                    ? batch[0].status === "completed"
                        ? "✅"
                        : "❌"
                    : d?.status === "completed"
                      ? "✅"
                      : "❌";
            const jobId = batch?.[0]?.jobId ?? (d?.jobId as string) ?? "";
            const status = batch?.[0]?.status ?? (d?.status as string) ?? "";
            const duration =
                batch?.[0]?.duration ?? (d?.duration as string) ?? "";
            const exitCode =
                batch?.[0]?.exitCode ?? (d?.exitCode as number | undefined);
            const command = batch?.[0]?.command ?? (d?.command as string) ?? "";
            const logPath = batch?.[0]?.logPath ?? (d?.logPath as string) ?? "";
            const suffix =
                ((d?.outstandingJobs as number) ?? 0) > 0
                    ? ` (${(d?.outstandingJobs as number) ?? 0} jobs outstanding)`
                    : "";
            const lines: string[] = [
                `${emoji} ${jobId} ${status} (${duration})${suffix}`,
                `   Command: ${command}`,
                `   Output: ${logPath}`,
            ];
            if (exitCode !== undefined) {
                lines.push(`   Exit code: ${exitCode}`);
            }
            return new Text(lines.join("\n"), 0, 0);
        }
    );

    // ── Register all features ─────────────────────────────────────────

    // Purge sidecar entries after startup so SQLite maintenance cannot delay
    // extension loading or first prompt readiness.
    scheduleSidecarPurge();

    registerBackgroundJobs(pi, state);
    registerBackgroundCommands(pi, state);
    registerAgentBackground(pi, state);
    registerPlanMode(pi, state);
    registerTask(pi, state);
    registerToolsSelector(pi, state);
    registerNotifications(pi, state);
    registerBookmark(pi, state);
    registerContextFiles(pi, state);
    registerMemory(pi, state);
    registerCustomFooter(pi, state);
    // registerHandoff(pi, state); // disabled
    registerPreset(pi, state);
    registerLoop(pi, state);
    registerSessionName(pi, state);
    registerSummarize(pi, state);
    registerContext(pi, state);
    registerWebBrowse(pi, state);
    registerWebSearch(pi, state);
    registerAgentSdkProvider(pi, state);
    registerClaudeResumeCommand(pi, state);
    registerReloadTool(pi, state);
    registerCallbacks(pi, state);
    registerPermissions(pi, state);
    registerPlanTools(pi, state);
    registerGoal(pi, state);
    registerWorkflow(pi, state);
    registerWakeup(pi, state);
    registerTauCommand(pi, state);

    // ── Agent events (cross-cutting) ──────────────────────────────────

    /** Build a status bar string for web tool calls showing URL or query. */
    function getWebToolStatus(
        toolName: string,
        input: Record<string, unknown>,
        theme: { fg(colour: string, text: string): string }
    ): string | undefined {
        const webTools = new Set([
            "web_browse",
            "web_screenshot",
            "web_interact",
            "web_search",
        ]);
        if (!webTools.has(toolName)) return undefined;

        if (toolName === "web_search") {
            const query = input.query;
            if (typeof query === "string" && query) {
                return theme.fg(
                    "dim",
                    `🔍 ${query.length > 60 ? query.slice(0, 57) + "…" : query}`
                );
            }
        }

        const url = input.url;
        if (typeof url === "string" && url) {
            return theme.fg(
                "dim",
                `🌐 ${url.length > 60 ? url.slice(0, 57) + "…" : url}`
            );
        }

        return undefined;
    }

    pi.on("agent_start", async (_event, ctx) => {
        startTitlebarSpinner(pi, state, ctx);
        state.agentStartTime = Date.now();
        if (ctx.hasUI) startAgentTimer(state, ctx);
    });

    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
        // Show URL/query in status bar for web tools
        if (ctx.hasUI) {
            const webStatus = getWebToolStatus(
                event.toolName,
                event.input,
                ctx.ui.theme
            );
            if (webStatus) {
                ctx.ui.setStatus("tau-web", webStatus);
            }
        }

        // Agent backgrounding
        if (state.agentBackgrounded) {
            // Auto-resume on bash: the agent trying to run a command is a clear signal
            // it should be working. This breaks the deadlock where all tools are blocked
            // and the agent can never recover on its own.
            if (event.toolName === "bash") {
                state.agentBackgrounded = false;
                return {};
            }
            // Allow jobs for inspection; block everything else with a clear reason.
            if (event.toolName === "jobs") {
                return {};
            }
            return {
                block: true,
                reason:
                    "Agent is backgrounded. Run any bash command to auto-resume, " +
                    "or use Ctrl+Alt+B or /bg to resume.",
            };
        }

        // Pending job decision: unrelated tools proceed and the model is
        // steered once per decision (see evaluatePendingDecisionGate). Only
        // the no-control-tools case still blocks.
        const pendingDecisionGate = evaluatePendingDecisionGate(
            state,
            pi,
            event.toolName
        );
        if (pendingDecisionGate.block) {
            return pendingDecisionGate;
        }

        // ── Permission system ──────────────────────────────────────

        // Reload settings if stale
        const permState = await reloadSettingsIfNeeded(
            {
                mode: state.permissionMode,
                rules: state.permissionRules,
                additionalDirectories: state.permissionAdditionalDirectories,
                disableBypass: state.permissionDisableBypass,
                lastLoadedAt: state.permissionLastLoadedAt,
                sessionRules: state.permissionSessionRules,
                askedCommands: state.permissionAskedCommands,
                planSlug: state.planSlug,
                planSessionDir: ctx.sessionManager.getSessionDir(),
            },
            ctx.cwd
        );
        state.permissionMode = permState.mode;
        state.permissionRules = permState.rules;
        state.permissionAdditionalDirectories = permState.additionalDirectories;
        state.permissionDisableBypass = permState.disableBypass;
        state.permissionLastLoadedAt = permState.lastLoadedAt;
        state.permissionSessionRules = permState.sessionRules;
        state.permissionAskedCommands = permState.askedCommands;

        // Run the permission pipeline
        const permResult = await checkToolPermission(
            event,
            permState,
            ctx.cwd,
            ctx
        );
        if (permResult.block) {
            return permResult;
        }

        // The permission system's plan mode handles bash filtering.
        // This legacy guard is kept only for the --plan CLI flag path.
        if (state.permissionMode === "plan" && event.toolName === "bash") {
            const command = event.input.command as string;
            if (!isSafeCommand(command)) {
                return {
                    block: true,
                    reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
                };
            }
        }

        return {};
    });

    // Shell `timeout` wrappers pre-empt pi's own budget: they kill a command
    // before it can be detached, or kill it after detach. Registered after the
    // handler above so a `block` decision still short-circuits first.
    registerTimeoutNerf(pi, state);
    registerPipeNerf(pi, state);
    // Annotations on other tools' results, after they ran. Registered last so a
    // hint cannot reorder a rewrite receipt that pipe-nerf or timeout-nerf put
    // in front of the payload.
    registerToolHints(pi, state);

    // Handoff disabled — file path tracking removed
    // pi.on("tool_result", async (event) => {
    //     if (
    //         (event.toolName === "read" ||
    //             event.toolName === "edit" ||
    //             event.toolName === "write") &&
    //         typeof event.input.path === "string"
    //     ) {
    //         state.accessedFilePaths.push(event.input.path);
    //     }
    // });

    pi.on("turn_start", async (_event, ctx) => {
        if (state.agentStartTime !== undefined && !state.agentTimer)
            if (ctx.hasUI) startAgentTimer(state, ctx);

        // First user interaction — clear the shortcut hint from status bar
        if (!state.hasInteracted) {
            state.hasInteracted = true;
            state.permissionModeHintUntil = 0;
            if (ctx.hasUI) {
                const colour = modeColour(state.permissionMode);
                ctx.ui.setStatus(
                    "tau-perm-mode",
                    ctx.ui.theme.fg(
                        colour,
                        modeStatusText(state.permissionMode, false)
                    )
                );
            }
        }
    });

    pi.on("turn_end", async (_event, ctx) => {
        // Stop the elapsed timer between turns
        if (state.agentTimer) {
            clearInterval(state.agentTimer);
            state.agentTimer = null;
        }

        // Clear web tool status after each turn
        if (ctx.hasUI) {
            ctx.ui.setStatus("tau-web", undefined);
        }

        // Render context / 5h / 7d bars in the status line, matching Claude
        // Code's own layout. Prefer claude-hud's snapshot (both windows);
        // fall back to the agent-sdk rate-limit events (binding window only).
        if (ctx.hasUI) {
            // Prefer the raw statusline capture (both windows, freshest);
            // fall back to claude-hud's snapshot, then SDK rate_limit events.
            const snapshot = readUsageSnapshot();
            const rl = state.agentSdkRateLimits;
            const cu = ctx.getContextUsage();
            const bars = buildStatusBars(
                {
                    contextPct: cu?.percent ?? null,
                    sessionPct: null,
                    sessionLabel: null,
                    fiveHourPct:
                        snapshot?.fiveHourPct ??
                        rl.fiveHour?.utilization ??
                        null,
                    sevenDayPct:
                        snapshot?.sevenDayPct ??
                        rl.sevenDay?.utilization ??
                        null,
                },
                ctx.ui.theme
            );
            ctx.ui.setStatus("tau-quota", bars);
        }
    });

    // Plan-mode: inject context before agent starts
    pi.on("before_agent_start", async (_event, ctx) => {
        // Auto-exit if plan mode has been active beyond the inactivity timeout
        if (
            state.permissionMode === "plan" &&
            state.planEnteredAt &&
            Date.now() - state.planEnteredAt > PLAN_MODE_TIMEOUT_MS
        ) {
            const planSlug = state.planSlug;
            cancelPlanMode(pi, state, ctx);
            // The auto-exit message below already supplies the one-shot nudge.
            state.planModeExitNoticePending = false;
            return {
                message: {
                    customType: "plan-mode-context",
                    content: `[PLAN MODE AUTO-EXIT]
Plan mode was automatically disabled after 30 minutes of inactivity.

If you need to continue planning, call enter_plan_mode again.
Previous plan ID: ${planSlug ?? "(none)"}`,
                    display: true,
                },
            };
        }

        if (state.planModeExitNoticePending) {
            state.planModeExitNoticePending = false;
            return {
                message: {
                    customType: "plan-mode-ended-context",
                    content:
                        "[PLAN MODE ENDED] The earlier plan-mode restrictions applied only while plan mode was active. Follow the current permission mode and task instructions now.",
                    display: false,
                },
            };
        }

        if (state.permissionMode === "plan" && state.planSlug) {
            const sessionDir = ctx.sessionManager.getSessionDir();
            const planPath = getPlanFilePath(sessionDir, state.planSlug);
            const taskTree =
                state.tasks.length > 0
                    ? `\n\nCurrent task tree:\n${formatTaskTree(state.tasks)}`
                    : "";
            return {
                message: {
                    customType: "plan-mode-context",
                    content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for structured planning.

Restrictions:
- The active tool set remains unchanged to preserve the provider's cached prompt prefix
- Permission checks block Edit/Write except for the plan file at: ${planPath}
- Bash is restricted to an allowlist of read-only commands
- Read access outside permitted working directories is blocked
- Use available read-only exploration tools; use task/subagent tools if active
- If the write tool is active, use it only for the plan file at: ${planPath}

Your job is to:
1. Explore the codebase using read-only tools
2. Build a structured task tree using the task tool:
   - Create a root task for the overall goal
   - Decompose into subtasks with child-of links
   - Add blocks/depends-on links for ordering constraints
   - Tasks without dependency links between them are parallel candidates
3. Use the write tool with path=${planPath} to write the narrative plan
4. Call exit_plan_mode when the plan is ready for review; follow its review-mode instructions

The plan file should include: Context, Approach, Files to modify,
Existing code to reuse (with paths), and Verification steps.${taskTree}`,
                    display: false,
                },
            };
        }
    });

    // Keep this extension from rewriting history when plan mode ends. Removing
    // earlier plan-mode-context messages changes the provider's cached prefix,
    // just as replacing the active tool set does. In the measured 2026-10-31
    // session, entering and exiting plan mode each dropped cacheRead from about
    // 143k/137k tokens to 11k, re-billing about 256k tokens across one round trip.
    // The messages are display:false and remain as stable historical context.

    pi.on("session_tree", async (_event, ctx) => {
        restoreFeaturesState(state, ctx);
        reconstructTaskState(state, ctx);
        restoreToolsFromBranch(pi, state, ctx);
    });

    // ── Session lifecycle ─────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setStatus("tau-turn", ctx.ui.theme.fg("dim", "Ready"));

        // ── Feature toggle state restoration ───────────────────────
        restoreFeaturesState(state, ctx);

        // ── Tmux detection ───────────────────────────────────────────
        state.tmuxAvailable = isTmuxAvailable();
        if (!state.tmuxAvailable && !state.tmuxWarningShown) {
            state.tmuxWarningShown = true;
            ctx.ui.notify(
                "⚠️ tmux not found — using direct process management",
                "warning"
            );
        }

        // ── Print/non-interactive detection ──────────────────────────
        // Mirror pi's own mode decision (print || !stdin.isTTY). When
        // non-interactive there is no agent loop to answer the bash tool's
        // auto-background job_decide prompt, so the tool must run commands to
        // completion instead of backgrounding on timeout.
        state.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // Background maintenance runs after readiness, never inside the
        // synchronous session_start path. The initial reaper/sweep pass is
        // timer-scheduled; subsequent passes remain hourly.
        if (state.tmuxAvailable && !tmuxRunDirSweepTimer) {
            const configuredDelay = Number(process.env[ORPHAN_REAPER_DELAY_ENV]);
            const firstRunDelayMs = Number.isFinite(configuredDelay) && configuredDelay >= 5_000
                ? configuredDelay
                : ORPHAN_REAPER_DEFAULT_DELAY_MS;
            tmuxRunDirSweepTimer = schedulePeriodicTmuxRunDirCleanup({
                firstRunDelayMs,
            });
        }

        // Get entries for synchronous lightweight UI-state restoration below;
        // the background-job snapshot/poller restore itself is deferred.
        const entries = ctx.sessionManager.getEntries();
        scheduleBackgroundJobRestore(
            () => restoreBackgroundJobs(entries, state, pi, ctx)
        );

        // Restore plan-mode state from CLI flag
        if (pi.getFlag("plan") === true) {
            state.permissionMode = "plan";
        }

        // Restore plan-mode state from session entries
        const planModeEntry = entries
            .filter(
                (e: { type: string; customType?: string }) =>
                    e.type === "custom" && e.customType === "plan-mode"
            )
            .pop() as
            | {
                  data?: {
                      enabled?: boolean;
                      planId?: string;
                      slug?: string;
                      previousMode?: import("./features/permissions/types.js").PermissionMode;
                      enteredAt?: number;
                      reviewPending?: boolean;
                  };
              }
            | undefined;

        if (planModeEntry?.data) {
            const restoredPlanId =
                planModeEntry.data.planId ?? planModeEntry.data.slug;
            if (planModeEntry.data.enabled) {
                state.permissionMode = "plan";
                state.planSlug = restoredPlanId;
                state.planPreviousMode = planModeEntry.data.previousMode;
                state.planReviewPending =
                    planModeEntry.data.reviewPending ?? false;
                state.planEnteredAt = planModeEntry.data.enteredAt;
            } else {
                state.planSlug = undefined;
                state.planPreviousMode = undefined;
                state.planReviewPending = false;
                state.planEnteredAt = undefined;
                state.toolsBeforePlanMode = undefined;
            }
        }

        // Restore task state
        reconstructTaskState(state, ctx);

        // Restore the user's selected tools from the branch, but do not replace
        // them when restoring plan mode. Per coding-agent docs/extensions.md
        // (2392-2396), replacing the active set truncates the cached prompt prefix;
        // plan mode enforces read-only access through the permission pipeline.
        restoreToolsFromBranch(pi, state, ctx);
        if (state.permissionMode === "plan") {
            state.toolsBeforePlanMode = undefined;
        }

        // ── Permission state initialisation ────────────────────────
        const permState = await initPermissionState(ctx.cwd);
        // Plan state restored from the CLI flag/session entry is authoritative
        // for this startup. Do not let the permission-settings default reset
        // the session back to allow mode after we restored it above.
        const planModeWasRestored = state.permissionMode === "plan";
        if (!planModeWasRestored) state.permissionMode = permState.mode;
        state.permissionRules = permState.rules;
        state.permissionAdditionalDirectories = permState.additionalDirectories;
        state.permissionDisableBypass = permState.disableBypass;
        state.permissionLastLoadedAt = permState.lastLoadedAt;
        state.permissionSessionRules = permState.sessionRules;
        state.permissionAskedCommands = permState.askedCommands;

        // ── Mode indicator in status bar (with shortcut hint at startup) ──
        if (ctx.hasUI) {
            const colour = modeColour(state.permissionMode);
            ctx.ui.setStatus(
                "tau-perm-mode",
                ctx.ui.theme.fg(
                    colour,
                    modeStatusText(state.permissionMode, true)
                )
            );
            state.permissionModeHintUntil = Date.now() + 10000;
            setTimeout(() => {
                if (Date.now() >= state.permissionModeHintUntil) {
                    ctx.ui.setStatus(
                        "tau-perm-mode",
                        ctx.ui.theme.fg(
                            modeColour(state.permissionMode),
                            modeStatusText(state.permissionMode, false)
                        )
                    );
                }
            }, 10000);
        }

        // Restore notification config
        for (const entry of ctx.sessionManager.getBranch()) {
            if (
                entry.type === "custom" &&
                entry.customType === "notifications-config"
            ) {
                const data = entry.data as
                    | {
                          persistent?: boolean;
                          respectDnd?: boolean;
                          enabledProviders?: string[];
                          providerConfigs?: Record<
                              string,
                              Record<string, string>
                          >;
                      }
                    | undefined;
                if (data) {
                    state.notificationPersistent = data.persistent ?? false;
                    state.notificationRespectDnd = data.respectDnd ?? true;
                    if (data.enabledProviders) {
                        state.enabledNotificationProviders = new Set(
                            data.enabledProviders
                        );
                    }
                    if (data.providerConfigs) {
                        state.notificationProviderConfigs =
                            data.providerConfigs;
                    }
                }
                break;
            }
        }

        cleanupStaleLogs();
    });

    pi.on("agent_end", async (event, ctx) => {
        // Stop timers and clear start time — guaranteed cleanup before
        // any fallible logic below. The interval's self-terminating guard
        // will also catch a surviving interval on its next tick.
        stopTitlebarSpinner(pi, state, ctx);
        showAgentTurnComplete(state, ctx);
        state.agentStartTime = undefined;

        // ── Notification ──────────────────────────────────────────────
        const doNotify = await shouldNotify(state);
        if (doNotify) {
            const sessionName = pi.getSessionName();
            const cwdBasename = ctx.cwd.split("/").pop() ?? "";
            const title = sessionName
                ? `Pi · ${sessionName}`
                : `Pi · ${cwdBasename}`;
            sendNotification(state, event.messages, title);
        }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stopTitlebarSpinner(pi, state, ctx);
        stopAgentTimer(state);
        state.agentStartTime = undefined;

        cleanupTmuxRunDir();

        pi.appendEntry("background-tasks-state", {
            jobs: Array.from(state.backgroundJobs.entries()).map(
                ([id, job]) => [
                    id,
                    {
                        ...job,
                        proc: undefined,
                        donePromise: undefined,
                        resolveDone: undefined,
                    },
                ]
            ),
            jobCounter: state.jobCounter,
        });
    });
}
