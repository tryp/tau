/**
 * Plan-mode preferences loaded from tau settings.
 *
 * Settings are merged from the global file, then project files from the
 * repository root down to the current working directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { walkProjectLayers } from "./features-files.ts";

export const EXECUTION_MODES = [
    "continue",
    "fresh",
    "spawn",
    "parallel",
    "manual",
] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type PlanReviewMode = "user" | "agent";

export interface PlanPreferences {
    /** Route review decisions back to the invoking agent or the UI. */
    reviewMode: PlanReviewMode;
    /** Legacy shortcut that skips the user approval selector. */
    autoApprove: boolean;
    /** Skip the execution-mode selector and use this mode. */
    defaultExecutionMode?: ExecutionMode;
}

const PLAN_REVIEW_MODES = new Set<PlanReviewMode>(["user", "agent"]);
const EXECUTION_MODE_SET = new Set<string>(EXECUTION_MODES);

const DEFAULT_PLAN_PREFERENCES: PlanPreferences = {
    reviewMode: "user",
    autoApprove: false,
};

/** Parse the tau.plan object from a settings-file value. */
export function parsePlanPreferences(value: unknown): Partial<PlanPreferences> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }

    const root = value as Record<string, unknown>;
    const tau = root.tau;
    if (typeof tau !== "object" || tau === null || Array.isArray(tau)) {
        return {};
    }

    const plan = (tau as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
        return {};
    }

    const preferences: Partial<PlanPreferences> = {};
    const planObject = plan as Record<string, unknown>;
    if (
        typeof planObject.reviewMode === "string" &&
        PLAN_REVIEW_MODES.has(planObject.reviewMode as PlanReviewMode)
    ) {
        preferences.reviewMode = planObject.reviewMode as PlanReviewMode;
    }
    if (typeof planObject.autoApprove === "boolean") {
        preferences.autoApprove = planObject.autoApprove;
    }
    if (
        typeof planObject.defaultExecutionMode === "string" &&
        EXECUTION_MODE_SET.has(planObject.defaultExecutionMode)
    ) {
        preferences.defaultExecutionMode =
            planObject.defaultExecutionMode as ExecutionMode;
    }
    return preferences;
}

function readPlanPreferences(path: string): Partial<PlanPreferences> {
    if (!existsSync(path)) return {};
    try {
        return parsePlanPreferences(JSON.parse(readFileSync(path, "utf8")));
    } catch {
        return {};
    }
}

/** Load effective plan preferences for a working directory. */
export function loadPlanPreferences(cwd: string): PlanPreferences {
    const paths = [
        join(getAgentDir(), "settings.json"),
        ...walkProjectLayers(cwd).reverse(),
    ];
    const preferences: PlanPreferences = { ...DEFAULT_PLAN_PREFERENCES };

    for (const path of paths) {
        Object.assign(preferences, readPlanPreferences(path));
    }

    return preferences;
}
