/**
 * Plan mode tools — enter_plan_mode and exit_plan_mode.
 *
 * These are LLM-callable tools that manage the plan lifecycle.
 * `enter_plan_mode` enters read-only exploration.
 * `exit_plan_mode` routes review through the configured user or agent flow.
 *
 * Also provides the `/plan` command and plan mode system prompt injection.
 */

import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { modeStatusText, modeColour } from "./permissions/index.ts";
import {
    planIdFromTitle,
    planIdFromSession,
    createPlanFile,
    getPlanFilePath,
    readPlanFile,
} from "./plan-file.ts";
import {
    EXECUTION_MODES,
    loadPlanPreferences,
    type ExecutionMode,
} from "./plan-preferences.ts";
import { formatTaskTree, countIndependentBranches } from "./task.ts";
import { captureReload } from "./reload.ts";

// ─── Tool parameter schemas ─────────────────────────────────────────

const EnterPlanModeParams = Type.Object({
    title: Type.Optional(
        Type.String({
            description:
                "Short title for the plan. Defaults to the user's request summary.",
        })
    ),
    reason: Type.Optional(
        Type.String({
            description:
                "Why plan mode is being requested (for review context).",
        })
    ),
});

const ExitPlanModeParams = Type.Object({
    action: Type.Optional(
        StringEnum(["review", "approve", "revise", "cancel"] as const, {
            description:
                "Agent review action. First call review, then call approve, revise, or cancel.",
        })
    ),
    summary: Type.Optional(
        Type.String({
            description:
                "Brief summary of what the plan covers (shown in exit notification).",
        })
    ),
    feedback: Type.Optional(
        Type.String({
            description: "Review notes or the reason the plan needs revision.",
        })
    ),
    executionMode: Type.Optional(
        StringEnum(EXECUTION_MODES, {
            description:
                "Execution mode to use after approval. Overrides the configured default.",
        })
    ),
});

// ─── Execution modes ────────────────────────────────────────────────

const EXECUTION_MODE_LABELS: Record<ExecutionMode, string> = {
    continue: "Continue in this session",
    fresh: "Fresh start (clear context)",
    spawn: "Spawn subagent",
    parallel: "Parallel (dispatch branches)",
    manual: "Manual (read plan when needed)",
};

/** Tools the agent may use while it plans and reviews without user UI. */
export const PLAN_MODE_ACTIVE_TOOLS = [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
    "task",
    "subagent",
    "subagent_wait",
    "write",
    "enter_plan_mode",
    "exit_plan_mode",
];

// ─── Feature registration ───────────────────────────────────────────

export function registerPlanTools(pi: ExtensionAPI, state: TauState): void {
    // ── enter_plan_mode tool ──────────────────────────────────────

    pi.registerTool({
        name: "enter_plan_mode",
        label: "Enter Plan Mode",
        description:
            "Enter plan mode for read-only codebase exploration and planning. " +
            "Creates a plan file at ~/.pi/agent/sessions/{dir}/plans/{timestamp}-{name}.md " +
            "where the plan will be written. " +
            "In plan mode, only read tools and the plan file are accessible — no edits or writes. " +
            "Use this when the task is complex enough to warrant structured planning first.",
        parameters: EnterPlanModeParams,

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<PlanToolDetails>> {
            const sessionId = ctx.sessionManager.getSessionId();
            const sessionDir = ctx.sessionManager.getSessionDir();
            const title = params.title ?? `Plan ${sessionId.slice(0, 8)}`;
            const planId = planIdFromTitle(title);

            // Create plan file
            const planPath = createPlanFile(sessionDir, planId, title);

            // Store previous mode for restoration
            state.planSlug = planId;
            state.planPreviousMode = state.permissionMode;
            state.planReviewPending = false;

            // Switch to plan mode
            state.permissionMode = "plan";
            pi.setActiveTools(PLAN_MODE_ACTIVE_TOOLS);

            // Update status bar
            if (ctx.hasUI) {
                const colour = modeColour("plan");
                ctx.ui.setStatus(
                    "tau-perm-mode",
                    ctx.ui.theme.fg(colour, modeStatusText("plan", true))
                );
            }

            // Persist plan state
            pi.appendEntry("plan-mode", {
                enabled: true,
                planId,
                previousMode: state.planPreviousMode,
                enteredAt: Date.now(),
                reviewPending: false,
            });

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Entered plan mode. Plan file: ${planPath}\n\n` +
                            `You can now explore the codebase with read-only tools. Build the plan:\n` +
                            `1. Explore the codebase using read, bash (read-only), grep, find, lsp tools\n` +
                            `2. Use the subagent tool with planner/reviewer agents when independent planning or review would help\n` +
                            `3. Create tasks with the task tool to structure the implementation\n` +
                            `4. Use the write tool (path-restricted to the plan file) to write the narrative plan to:\n` +
                            `   ${planPath}\n` +
                            `5. Call exit_plan_mode when the plan is ready for review; review and approve it yourself\n\n` +
                            `Write operations are blocked except for the plan file (via the write tool).`,
                    },
                ],
                details: {
                    action: "enter",
                    planPath,
                    planId,
                },
            };
        },

        renderCall(args, theme) {
            return new Text(
                theme.fg("toolTitle", theme.bold("enter_plan_mode ")) +
                    theme.fg("dim", args.title ?? "(no title)"),
                0,
                0
            );
        },

        renderResult(result, _options, theme) {
            const details = result.details as PlanToolDetails | undefined;
            if (!details) return new Text("", 0, 0);
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg("muted", `Plan mode active — ${details.planPath}`),
                0,
                0
            );
        },
    });

    // ── exit_plan_mode tool ───────────────────────────────────────

    pi.registerTool({
        name: "exit_plan_mode",
        label: "Exit Plan Mode",
        description:
            "Exit plan mode and review the plan before execution. " +
            "In agent review mode, the first call returns the review request to you; " +
            "then call this tool again with action approve, revise, or cancel. " +
            "Call this when the plan file is complete and the task tree is ready.",
        parameters: ExitPlanModeParams,

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<PlanToolDetails>> {
            const planId = state.planSlug;
            if (!planId) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: not in plan mode (no active plan).",
                        },
                    ],
                    details: { action: "exit", error: "not in plan mode" },
                };
            }

            const sessionDir = ctx.sessionManager.getSessionDir();
            const planPath = getPlanFilePath(sessionDir, planId);
            const planContent = readPlanFile(sessionDir, planId);

            // Prepare the plan review request.
            const summary = params.summary ?? "Plan is ready for review.";
            const taskTree =
                state.tasks.length > 0
                    ? `\n\nTask tree:\n${formatTaskTree(state.tasks)}`
                    : "\n\n(No tasks created during planning)";
            const planContentForReview = planContent ?? "(empty plan file)";
            const reviewMessage = `**Plan Review**\n\n${summary}\n\nPlan file: \`${planPath}\`${taskTree}`;
            const preferences = loadPlanPreferences(ctx.cwd);
            const action = params.action ?? "review";

            if (preferences.reviewMode === "agent") {
                if (action === "cancel") {
                    cancelPlanMode(pi, state, ctx);
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Plan mode cancelled. Returned to the previous mode.",
                            },
                        ],
                        details: { action: "exit", cancelled: true },
                    };
                }

                if (!state.planReviewPending) {
                    state.planReviewPending = true;
                    pi.appendEntry("plan-mode", {
                        enabled: true,
                        planId,
                        previousMode: state.planPreviousMode,
                        enteredAt: state.planEnteredAt,
                        reviewPending: true,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    "Agent review required before execution. Review the plan yourself; " +
                                    "this is not a user prompt. Check scope, file impact, dependencies, " +
                                    "verification coverage, and whether tasks can safely run in parallel.\n\n" +
                                    `${reviewMessage}\n\nPlan content:\n${planContentForReview}\n\n` +
                                    "After answering those review questions, call exit_plan_mode again " +
                                    "with action=approve to execute, action=revise to continue planning, " +
                                    "or action=cancel to leave plan mode.",
                            },
                        ],
                        details: {
                            action: "exit",
                            reviewRequired: true,
                            planPath,
                            planContent: planContentForReview,
                        },
                    };
                }

                if (action === "revise") {
                    state.planReviewPending = false;
                    pi.appendEntry("plan-mode", {
                        enabled: true,
                        planId,
                        previousMode: state.planPreviousMode,
                        enteredAt: state.planEnteredAt,
                        reviewPending: false,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    "Plan revision requested. Continue planning and update the plan file." +
                                    (params.feedback
                                        ? `\n\nReview notes:\n${params.feedback}`
                                        : ""),
                            },
                        ],
                        details: { action: "exit", revised: true },
                    };
                }

                if (action !== "approve") {
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    "A plan review is pending. Call exit_plan_mode with action=approve, " +
                                    "action=revise, or action=cancel.",
                            },
                        ],
                        details: {
                            action: "exit",
                            reviewRequired: true,
                            planPath,
                            planContent: planContentForReview,
                        },
                    };
                }
            } else {
                // Preserve the interactive review flow for user review mode.
                pi.sendMessage(
                    {
                        customType: "plan-review",
                        content: reviewMessage,
                        display: true,
                    },
                    { triggerTurn: false }
                );

                const approved = preferences.autoApprove
                    ? "Approve"
                    : await ctx.ui.select("Review plan — approve to proceed?", [
                          "Approve",
                          "Reject (continue planning)",
                          "Cancel plan mode",
                      ]);

                if (approved === "Reject (continue planning)") {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Plan rejected. Continue refining the plan in plan mode.",
                            },
                        ],
                        details: { action: "exit", rejected: true },
                    };
                }

                if (approved === "Cancel plan mode") {
                    cancelPlanMode(pi, state, ctx);
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Plan mode cancelled. Returned to previous mode.",
                            },
                        ],
                        details: { action: "exit", cancelled: true },
                    };
                }
            }

            state.planReviewPending = false;

            // The plan file remains on disk for reference, but the active
            // plan state is no longer needed once execution begins.
            // Agent-driven plans must not restore an interactive permission
            // mode: there is no user available to answer those prompts.
            const previousMode =
                preferences.reviewMode === "agent"
                    ? "allow"
                    : (state.planPreviousMode ?? "allow");
            state.planSlug = undefined;
            state.planPreviousMode = undefined;

            // ── Approved: choose execution mode ───────────────────

            const execMode =
                params.executionMode ??
                preferences.defaultExecutionMode ??
                (preferences.reviewMode === "agent"
                    ? "continue"
                    : await chooseExecutionMode(ctx, state));

            // Restore the previous mode for user-reviewed plans, or keep the
            // agent-driven execution path non-interactive.
            state.planExiting = true;
            state.planEnteredAt = undefined;
            state.permissionMode = previousMode;
            pi.setActiveTools(["read", "bash", "edit", "write"]);

            // Update status bar
            if (ctx.hasUI) {
                const colour = modeColour(previousMode);
                ctx.ui.setStatus(
                    "tau-perm-mode",
                    ctx.ui.theme.fg(colour, modeStatusText(previousMode, true))
                );
            }

            // Persist state
            pi.appendEntry("plan-mode", {
                enabled: false,
                planId,
                executing: true,
                executionMode: execMode,
            });

            const modeDescription = EXECUTION_MODE_LABELS[execMode];
            const planContentForInjection = planContent ?? "(empty plan file)";

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Plan approved. Execution mode: ${modeDescription}\n\n` +
                            `Plan file: ${planPath}\n` +
                            `Previous mode restored: ${previousMode}\n\n` +
                            `Begin executing the plan. Mark tasks in-progress before starting ` +
                            `and done when complete.`,
                    },
                ],
                details: {
                    action: "exit",
                    approved: true,
                    executionMode: execMode,
                    planPath,
                    planContent: planContentForInjection,
                },
            };
        },

        renderCall(args, theme) {
            return new Text(
                theme.fg("toolTitle", theme.bold("exit_plan_mode ")) +
                    theme.fg("dim", args.summary ?? ""),
                0,
                0
            );
        },

        renderResult(result, _options, theme) {
            const details = result.details as PlanToolDetails | undefined;
            if (!details) return new Text("", 0, 0);
            if (details.error) {
                return new Text(theme.fg("error", "✗ " + details.error), 0, 0);
            }
            if (details.rejected) {
                return new Text(
                    theme.fg("warning", "⏸ Plan rejected — continue planning"),
                    0,
                    0
                );
            }
            if (details.cancelled) {
                return new Text(theme.fg("dim", "⊘ Plan mode cancelled"), 0, 0);
            }
            if (details.reviewRequired) {
                return new Text(
                    theme.fg(
                        "warning",
                        "↺ Agent review required — awaiting decision"
                    ),
                    0,
                    0
                );
            }
            if (details.revised) {
                return new Text(
                    theme.fg("warning", "↺ Plan revision requested"),
                    0,
                    0
                );
            }
            const mode = details.executionMode ?? "continue";
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg(
                        "muted",
                        `Plan approved — ${EXECUTION_MODE_LABELS[mode]}`
                    ),
                0,
                0
            );
        },
    });

    // ── /plan command (updated to use new plan system) ────────────

    pi.registerCommand("plan", {
        description: "Toggle plan mode or show current plan",
        handler: async (args, ctx: ExtensionCommandContext) => {
            captureReload(state, ctx);
            const subcommand = args.trim().toLowerCase();

            if (subcommand === "show" && state.planSlug) {
                const sessionDir = ctx.sessionManager.getSessionDir();
                const content = readPlanFile(sessionDir, state.planSlug);
                if (content) {
                    ctx.ui.notify(content, "info");
                } else {
                    ctx.ui.notify("Plan file is empty or missing.", "warning");
                }
                return;
            }

            // Toggle plan mode
            if (state.permissionMode === "plan") {
                // Exit plan mode
                cancelPlanMode(pi, state, ctx);
            } else {
                // Enter plan mode
                const sessionId = ctx.sessionManager.getSessionId();
                const sessionDir = ctx.sessionManager.getSessionDir();
                const planId = planIdFromSession(sessionId);
                const planPath = createPlanFile(sessionDir, planId);

                state.planSlug = planId;
                state.planPreviousMode = state.permissionMode;
                state.planReviewPending = false;
                state.planEnteredAt = Date.now();
                state.permissionMode = "plan";
                pi.setActiveTools(PLAN_MODE_ACTIVE_TOOLS);

                if (ctx.hasUI) {
                    const colour = modeColour("plan");
                    ctx.ui.setStatus(
                        "tau-perm-mode",
                        ctx.ui.theme.fg(colour, modeStatusText("plan", true))
                    );
                }

                pi.appendEntry("plan-mode", {
                    enabled: true,
                    planId,
                    previousMode: state.planPreviousMode,
                    enteredAt: Date.now(),
                    reviewPending: false,
                });

                ctx.ui.notify(`Plan mode enabled. Plan file: ${planPath}`);
            }
        },
    });
}

// ─── Execution mode selection ───────────────────────────────────────

async function chooseExecutionMode(
    ctx: ExtensionContext,
    state: TauState
): Promise<ExecutionMode> {
    // Get context usage to inform the "fresh start" decision
    const usage = ctx.getContextUsage();
    const usagePercent = usage?.percent;

    // Count independent task branches for parallel analysis
    const independentCount = countIndependentBranches(state.tasks);

    const options: string[] = [
        `Continue in this session${usagePercent != null && usagePercent > 50 ? ` (context: ${usagePercent}%)` : ""}`,
        `Fresh start (clear context, inject plan)`,
        `Spawn subagent (separate session)`,
        independentCount > 1
            ? `Parallel (${independentCount} independent branches)`
            : `Parallel (dispatch branches)`,
        `Manual (read plan when needed)`,
    ];

    const choice = await ctx.ui.select("Choose execution mode:", options);

    const modeMap: ExecutionMode[] = [
        "continue",
        "fresh",
        "spawn",
        "parallel",
        "manual",
    ];

    for (let i = 0; i < options.length; i++) {
        if (choice === options[i]) return modeMap[i];
    }

    // Default to continue
    return "continue";
}

/**
 * Count the number of independent task branches (root tasks with no
 * blocks/depends-on links between them).
 */
// countIndependentBranches moved to task.ts

// ─── Helpers ────────────────────────────────────────────────────────

export function cancelPlanMode(
    pi: ExtensionAPI,
    state: TauState,
    ctx: ExtensionContext
): void {
    const previousMode = state.planPreviousMode ?? "allow";
    state.permissionMode = previousMode;
    state.planSlug = undefined;
    state.planPreviousMode = undefined;
    state.planExiting = false;
    state.planReviewPending = false;
    state.planEnteredAt = undefined;
    pi.setActiveTools(["read", "bash", "edit", "write"]);

    if (ctx.hasUI) {
        const colour = modeColour(previousMode);
        ctx.ui.setStatus(
            "tau-perm-mode",
            ctx.ui.theme.fg(colour, modeStatusText(previousMode, false))
        );
    }

    ctx.ui.notify("Plan mode disabled. Full access restored.", "info");

    pi.appendEntry("plan-mode", {
        enabled: false,
        planId: undefined,
        executing: false,
    });
}

// ─── Types ──────────────────────────────────────────────────────────

interface PlanToolDetails {
    action: "enter" | "exit";
    planPath?: string;
    planId?: string;
    error?: string;
    rejected?: boolean;
    cancelled?: boolean;
    reviewRequired?: boolean;
    revised?: boolean;
    approved?: boolean;
    executionMode?: ExecutionMode;
    planContent?: string;
}
