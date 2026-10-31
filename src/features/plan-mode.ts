/**
 * Plan mode feature — toggle and /plan command registration.
 *
 * The permission system's "plan" mode is the single source of truth for
 * plan-mode state. This module provides the user-facing toggles:
 * - /plan command
 * - Ctrl+Alt+P shortcut
 * - --plan CLI flag
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import type { PermissionMode } from "./permissions/types.js";
import { modeStatusText, modeColour } from "./permissions/index.js";
import { planIdFromSession, createPlanFile } from "./plan-file.ts";
import { clearToolsBeforePlanMode } from "./plan-tools.ts";

/**
 * Auto-exit plan mode after 30 minutes of inactivity.
 * Prevents sessions getting stuck in plan mode indefinitely.
 */
export const PLAN_MODE_TIMEOUT_MS = 30 * 60 * 1000;

function updatePlanStatus(state: TauState, ctx: ExtensionContext): void {
    if (state.permissionMode === "plan") {
        ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "⏸ planning"));
    } else {
        ctx.ui.setStatus("plan-mode", undefined);
    }
    ctx.ui.setWidget("plan-todos", undefined);
}

export function togglePlanMode(state: TauState, ctx: ExtensionContext): void {
    if (state.permissionMode === "plan") {
        const previousMode: PermissionMode = state.planPreviousMode ?? "allow";
        state.permissionMode = previousMode;
        state.planSlug = undefined;
        state.planPreviousMode = undefined;
        state.planReviewPending = false;
        state.planEnteredAt = undefined;
        state.planModeExitNoticePending = true;
        clearToolsBeforePlanMode(state);

        if (ctx.hasUI) {
            const colour = modeColour(previousMode);
            ctx.ui.setStatus(
                "tau-perm-mode",
                ctx.ui.theme.fg(colour, modeStatusText(previousMode, false))
            );
        }
        ctx.ui.notify("Plan mode disabled. Full access restored.");
    } else {
        const sessionId = ctx.sessionManager.getSessionId();
        const planId = planIdFromSession(sessionId);
        const planPath = createPlanFile(
            ctx.sessionManager.getSessionDir(),
            planId
        );

        state.planPreviousMode = state.permissionMode;
        state.permissionMode = "plan";
        state.planSlug = planId;
        state.planReviewPending = false;
        state.planEnteredAt = Date.now();
        state.planModeExitNoticePending = false;
        // Plan mode is a permission policy, not a tool-schema change. The
        // provider cache includes the tool block; replacing the active set
        // truncates the cached prefix. The coding-agent docs recommend adding
        // tools instead of replacing the active set (docs/extensions.md:2392-2396);
        // the referenced plan-mode example at docs/extensions.md:2994 uses the
        // cache-hostile replacement pattern.
        clearToolsBeforePlanMode(state);

        if (ctx.hasUI) {
            const colour = modeColour("plan");
            ctx.ui.setStatus(
                "tau-perm-mode",
                ctx.ui.theme.fg(colour, modeStatusText("plan", true))
            );
        }
        ctx.ui.notify(`Plan mode enabled. Plan file: ${planPath}`);
    }
    updatePlanStatus(state, ctx);
}

// ─── Feature registration ───────────────────────────────────────────

export function registerPlanMode(pi: ExtensionAPI, state: TauState): void {
    pi.registerFlag("plan", {
        description: "Start in plan mode (read-only exploration)",
        type: "boolean",
        default: false,
    });

    pi.registerCommand("plan", {
        description: "Toggle plan mode (read-only exploration)",
        handler: async (_args, ctx) => {
            if (!isFeatureEnabled(state, "plan-mode")) {
                ctx.ui.notify(
                    "Plan mode is disabled — run /tau to enable",
                    "info"
                );
                return;
            }
            togglePlanMode(state, ctx);
        },
    });

    pi.registerShortcut(Key.ctrlAlt("p"), {
        description: "Toggle plan mode",
        handler: async (ctx) => {
            if (!isFeatureEnabled(state, "plan-mode")) return;
            togglePlanMode(state, ctx);
        },
    });
}
