import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    PLAN_MODE_ACTIVE_TOOLS,
    registerPlanTools,
} from "../features/plan-tools.ts";
import { createPlanFile } from "../features/plan-file.ts";
import { TauState } from "../state.ts";

type RegisteredTool = {
    execute: (...args: unknown[]) => Promise<unknown>;
};

type ToolResult = {
    details?: {
        approved?: boolean;
        executionMode?: string;
        reviewRequired?: boolean;
        revised?: boolean;
    };
};

function makeAgentReviewHarness() {
    const cwd = mkdtempSync(join(tmpdir(), "pi-tau-plan-review-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
            tau: {
                plan: {
                    reviewMode: "agent",
                    defaultExecutionMode: "parallel",
                },
            },
        })
    );

    const sessionDir = join(cwd, "session");
    const state = new TauState();
    state.permissionMode = "plan";
    state.planPreviousMode = "allow";
    state.planSlug = "test-plan";
    createPlanFile(sessionDir, state.planSlug, "Test plan");

    const tools = new Map<string, RegisteredTool>();
    const sentMessages: unknown[] = [];
    let selectCalls = 0;
    const pi = {
        registerTool(definition: {
            name: string;
            execute: RegisteredTool["execute"];
        }) {
            tools.set(definition.name, definition);
        },
        registerCommand() {},
        setActiveTools() {},
        appendEntry() {},
        sendMessage(message: unknown) {
            sentMessages.push(message);
        },
    } as unknown as ExtensionAPI;
    const ctx = {
        cwd,
        hasUI: false,
        sessionManager: {
            getSessionDir: () => sessionDir,
        },
        ui: {
            select: async () => {
                selectCalls++;
                throw new Error("agent review must not open a UI selector");
            },
        },
    };

    registerPlanTools(pi, state);

    return {
        cwd,
        state,
        tools,
        sentMessages,
        get selectCalls() {
            return selectCalls;
        },
        ctx,
        cleanup: () => rmSync(cwd, { recursive: true, force: true }),
    };
}

async function callExit(
    harness: ReturnType<typeof makeAgentReviewHarness>,
    params: Record<string, string>
): Promise<ToolResult> {
    const tool = harness.tools.get("exit_plan_mode");
    assert.ok(tool);
    return (await tool.execute(
        "test-call",
        params,
        undefined,
        undefined,
        harness.ctx
    )) as ToolResult;
}

void describe("agent-driven plan review", () => {
    void it("keeps subagent planning and review tools available", () => {
        assert.deepEqual(
            PLAN_MODE_ACTIVE_TOOLS.filter((tool) =>
                ["subagent", "subagent_wait", "enter_plan_mode", "exit_plan_mode"].includes(tool)
            ),
            ["subagent", "subagent_wait", "enter_plan_mode", "exit_plan_mode"]
        );
    });

    void it("returns review to the agent, then approves without UI prompts", async () => {
        const harness = makeAgentReviewHarness();
        try {
            const review = await callExit(harness, { action: "review" });
            assert.equal(review.details?.reviewRequired, true);
            assert.equal(harness.state.planReviewPending, true);
            assert.equal(harness.sentMessages.length, 0);
            assert.equal(harness.selectCalls, 0);

            const approved = await callExit(harness, { action: "approve" });
            assert.equal(approved.details?.approved, true);
            assert.equal(approved.details?.executionMode, "parallel");
            assert.equal(harness.state.planReviewPending, false);
            assert.equal(harness.state.planSlug, undefined);
            assert.equal(harness.selectCalls, 0);
        } finally {
            harness.cleanup();
        }
    });

    void it("restores allow mode after agent approval", async () => {
        const harness = makeAgentReviewHarness();
        try {
            harness.state.planPreviousMode = "ask";
            await callExit(harness, { action: "review" });
            const approved = await callExit(harness, { action: "approve" });
            assert.equal(approved.details?.approved, true);
            assert.equal(harness.state.permissionMode, "allow");
            assert.equal(harness.selectCalls, 0);
        } finally {
            harness.cleanup();
        }
    });

    void it("returns revision feedback to the agent and keeps plan mode active", async () => {
        const harness = makeAgentReviewHarness();
        try {
            await callExit(harness, { action: "review" });
            const revised = await callExit(harness, {
                action: "revise",
                feedback: "Add a rollback verification step.",
            });
            assert.equal(revised.details?.revised, true);
            assert.equal(harness.state.planReviewPending, false);
            assert.equal(harness.state.permissionMode, "plan");
            assert.equal(harness.selectCalls, 0);
        } finally {
            harness.cleanup();
        }
    });
});
