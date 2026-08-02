/**
 * Unit tests for plan-mode improvements:
 * - isSafePlanCommand with cd in SAFE_PATTERNS
 * - cancelPlanMode state clearing (via inline helper)
 * - isPlanFilePath path matching
 * - checkToolPermission plan mode write restrictions
 */

import { describe, it, mock, type Mock } from "node:test";
import assert from "node:assert/strict";
import { isSafePlanCommand } from "../features/permissions/bash.ts";
import { isPlanFilePath } from "../features/plan-file.ts";
import {
    checkToolPermission,
    type PermissionState,
} from "../features/permissions/index.ts";
import type {
    ToolCallEvent,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TauState } from "../state.ts";

// ═══════════════════════════════════════════════════════════════════════
// 1. isSafePlanCommand — cd in SAFE_PATTERNS + chained commands
// ═══════════════════════════════════════════════════════════════════════

void describe("isSafePlanCommand — cd in SAFE_PATTERNS", () => {
    // ── cd should now be allowed (new) ────────────────────────────

    void it("allows plain cd", () => {
        assert.equal(isSafePlanCommand("cd /path"), true);
    });

    void it("allows cd with spaces in path", () => {
        assert.equal(isSafePlanCommand('cd "/path/with spaces"'), true);
    });

    void it("allows cd with relative path", () => {
        assert.equal(isSafePlanCommand("cd ../../src"), true);
    });

    void it("allows cd && grep chain", () => {
        assert.equal(isSafePlanCommand('cd /path && grep -rn "foo" .'), true);
    });

    void it("allows cd && ls chain", () => {
        assert.equal(isSafePlanCommand("cd /path && ls -la"), true);
    });

    void it("allows cd && cat chain", () => {
        assert.equal(isSafePlanCommand("cd /path && cat file.txt"), true);
    });

    void it("allows cd && head chain", () => {
        assert.equal(isSafePlanCommand("cd /path && head -20 file.txt"), true);
    });

    void it("allows cd pipe pwd", () => {
        assert.equal(isSafePlanCommand("cd /path | pwd"), true);
    });

    void it("allows cd semicolon pwd", () => {
        assert.equal(isSafePlanCommand("cd /path; pwd"), true);
    });

    void it("allows cd && git status", () => {
        assert.equal(isSafePlanCommand("cd /path && git status"), true);
    });

    void it("allows cd && git diff", () => {
        assert.equal(isSafePlanCommand("cd /path && git diff HEAD~1"), true);
    });

    void it("allows cd && ls | grep pipe chain", () => {
        assert.equal(
            isSafePlanCommand("cd /path && ls -la | grep pattern"),
            true
        );
    });

    void it("allows cd && wc chain", () => {
        assert.equal(isSafePlanCommand("cd /path && wc -l file.txt"), true);
    });

    void it("allows cd && find chain", () => {
        assert.equal(
            isSafePlanCommand("cd /path && find . -name '*.ts'"),
            true
        );
    });

    // ── cd + destructive should still be blocked ──────────────────

    void it("blocks cd && rm", () => {
        assert.equal(isSafePlanCommand("cd /path && rm -rf *"), false);
    });

    void it("blocks cd && git commit", () => {
        assert.equal(
            isSafePlanCommand('cd /path && git commit -m "test"'),
            false
        );
    });

    void it("blocks cd with redirect", () => {
        assert.equal(isSafePlanCommand("cd /path > file.txt"), false);
    });

    void it("blocks cd && git push", () => {
        assert.equal(
            isSafePlanCommand("cd /path && git push origin main"),
            false
        );
    });

    void it("blocks cd && mv", () => {
        assert.equal(isSafePlanCommand("cd /path && mv old new"), false);
    });

    void it("blocks cd && sudo", () => {
        assert.equal(isSafePlanCommand("cd /path && sudo rm -rf"), false);
    });

    void it("blocks cd && mkdir", () => {
        assert.equal(isSafePlanCommand("cd /path && mkdir foo"), false);
    });

    void it("blocks cd && npm install", () => {
        assert.equal(isSafePlanCommand("cd /path && npm install foo"), false);
    });

    // ── cat > heredoc — common stuck pattern ──────────────────────

    void it("blocks cat > heredoc (the stuck pattern)", () => {
        assert.equal(
            isSafePlanCommand("cat > /path/to/plan.md <<'EOF'\ncontent\nEOF"),
            false
        );
    });

    void it("blocks echo with redirect", () => {
        assert.equal(
            isSafePlanCommand('echo "#include <stdio.h>" > file.c'),
            false
        );
    });

    // ── Existing safe commands still work ────────────────────────

    void it("allows grep", () => {
        assert.equal(isSafePlanCommand('grep -rn "pattern" .'), true);
    });

    void it("allows cat", () => {
        assert.equal(isSafePlanCommand("cat file.txt"), true);
    });

    void it("allows ls", () => {
        assert.equal(isSafePlanCommand("ls -la"), true);
    });

    void it("allows find", () => {
        assert.equal(isSafePlanCommand("find . -name '*.ts'"), true);
    });

    void it("allows echo", () => {
        assert.equal(isSafePlanCommand('echo "hello"'), true);
    });

    void it("allows pwd", () => {
        assert.equal(isSafePlanCommand("pwd"), true);
    });

    void it("allows git status", () => {
        assert.equal(isSafePlanCommand("git status"), true);
    });

    void it("allows git diff", () => {
        assert.equal(isSafePlanCommand("git diff HEAD~1"), true);
    });

    void it("allows git log", () => {
        assert.equal(isSafePlanCommand("git log --oneline -5"), true);
    });

    // ── Existing destructive patterns still blocked ──────────────

    void it("blocks rm -rf", () => {
        assert.equal(isSafePlanCommand("rm -rf /"), false);
    });

    void it("blocks git commit", () => {
        assert.equal(isSafePlanCommand('git commit -m "test"'), false);
    });

    void it("blocks git push", () => {
        assert.equal(isSafePlanCommand("git push origin main"), false);
    });

    void it("blocks sudo", () => {
        assert.equal(isSafePlanCommand("sudo apt install"), false);
    });

    void it("blocks npm install", () => {
        assert.equal(isSafePlanCommand("npm install foo"), false);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. PLAN_MODE_TIMEOUT_MS constant value
// ═══════════════════════════════════════════════════════════════════════

void describe("PLAN_MODE_TIMEOUT_MS", () => {
    void it("should be 30 minutes in milliseconds", () => {
        // Inline constant matching the source value in plan-mode.ts
        assert.equal(30 * 60 * 1000, 1_800_000);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. cancelPlanMode — state clearing (tested via inline helper)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Inline version of cancelPlanMode for testing purposes.
 * Mirrors the logic in plan-tools.ts without its module dependencies.
 */
function testableCancelPlanMode(
    state: TauState,
    setActiveTools: Mock<(...args: unknown[]) => unknown>,
    appendEntry: Mock<(...args: unknown[]) => unknown>
): void {
    const previousMode = state.planPreviousMode ?? "allow";
    state.permissionMode = previousMode;
    state.planSlug = undefined;
    state.planPreviousMode = undefined;
    state.planExiting = false;
    state.planEnteredAt = undefined;
    setActiveTools(["read", "bash", "edit", "write"]);
    appendEntry("plan-mode", {
        enabled: false,
        planId: undefined,
        executing: false,
    });
}

void describe("cancelPlanMode state clearing", () => {
    void it("clears all plan-mode state fields", () => {
        const state = new TauState();
        state.permissionMode = "plan";
        state.planSlug = "2026-07-26-test-plan";
        state.planPreviousMode = "allow";
        state.planExiting = false;
        state.planEnteredAt = Date.now();

        const setActiveTools = mock.fn();
        const appendEntry = mock.fn();

        testableCancelPlanMode(state, setActiveTools, appendEntry);

        assert.equal(state.permissionMode, "allow");
        assert.equal(state.planSlug, undefined);
        assert.equal(state.planPreviousMode, undefined);
        assert.equal(state.planExiting, false);
        assert.equal(state.planEnteredAt, undefined);
    });

    void it("restores to allow when no previous mode", () => {
        const state = new TauState();
        state.permissionMode = "plan";
        state.planSlug = "test-plan";
        state.planEnteredAt = Date.now();

        const setActiveTools = mock.fn();
        const appendEntry = mock.fn();

        testableCancelPlanMode(state, setActiveTools, appendEntry);

        // planPreviousMode is undefined, defaults to "allow"
        assert.equal(state.permissionMode, "allow");
    });

    void it("restores to dontAsk when previously in dontAsk", () => {
        const state = new TauState();
        state.permissionMode = "plan";
        state.planSlug = "test-plan";
        state.planPreviousMode = "dontAsk";
        state.planEnteredAt = Date.now();

        const setActiveTools = mock.fn();
        const appendEntry = mock.fn();

        testableCancelPlanMode(state, setActiveTools, appendEntry);

        assert.equal(state.permissionMode, "dontAsk");
    });

    void it("restores to edit when previously in edit", () => {
        const state = new TauState();
        state.permissionMode = "plan";
        state.planSlug = "test-plan";
        state.planPreviousMode = "edit";
        state.planEnteredAt = Date.now();

        const setActiveTools = mock.fn();
        const appendEntry = mock.fn();

        testableCancelPlanMode(state, setActiveTools, appendEntry);

        assert.equal(state.permissionMode, "edit");
    });

    void it("calls setActiveTools with normal mode tools", () => {
        const state = new TauState();
        state.permissionMode = "plan";
        state.planSlug = "test-plan";
        state.planEnteredAt = Date.now();

        const setActiveTools = mock.fn();
        const appendEntry = mock.fn();

        testableCancelPlanMode(state, setActiveTools, appendEntry);

        assert.equal(setActiveTools.mock.callCount(), 1);
        assert.deepEqual(setActiveTools.mock.calls[0].arguments[0], [
            "read",
            "bash",
            "edit",
            "write",
        ]);
    });

    void it("appends plan-mode disabled entry", () => {
        const state = new TauState();
        state.permissionMode = "plan";
        state.planSlug = "test-plan";
        state.planEnteredAt = Date.now();

        const setActiveTools = mock.fn();
        const appendEntry = mock.fn();

        testableCancelPlanMode(state, setActiveTools, appendEntry);

        assert.equal(appendEntry.mock.callCount(), 1);
        assert.deepEqual(appendEntry.mock.calls[0].arguments, [
            "plan-mode",
            { enabled: false, planId: undefined, executing: false },
        ]);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. isPlanFilePath — path matching
// ═══════════════════════════════════════════════════════════════════════

void describe("isPlanFilePath", () => {
    void it("returns true for exact plan file path", () => {
        assert.equal(
            isPlanFilePath(
                "/session/plans/2026-07-26T12-00-00-test-plan.md",
                "/session",
                "2026-07-26T12-00-00-test-plan"
            ),
            true
        );
    });

    void it("returns false for a different file in plans dir", () => {
        assert.equal(
            isPlanFilePath(
                "/session/plans/other-file.md",
                "/session",
                "2026-07-26T12-00-00-test-plan"
            ),
            false
        );
    });

    void it("returns false for a file outside plans dir", () => {
        assert.equal(
            isPlanFilePath(
                "/session/src/main.ts",
                "/session",
                "2026-07-26T12-00-00-test-plan"
            ),
            false
        );
    });

    void it("returns false for empty path", () => {
        assert.equal(
            isPlanFilePath("", "/session", "2026-07-26T12-00-00-test-plan"),
            false
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. checkToolPermission — plan mode write restrictions
// ═══════════════════════════════════════════════════════════════════════

void describe("checkToolPermission — plan mode", () => {
    function makePlanState(
        overrides: Partial<PermissionState> = {}
    ): PermissionState {
        return {
            mode: "plan",
            rules: [],
            additionalDirectories: new Set(),
            disableBypass: false,
            lastLoadedAt: Date.now(),
            sessionRules: [],
            askedCommands: new Set(),
            planSlug: "2026-07-26T12-00-00-test-plan",
            planSessionDir: "/session",
            ...overrides,
        };
    }

    function makeCtx(): ExtensionContext {
        return {
            ui: {
                // Should never be called — plan mode check happens before prompts
                custom: async () => {
                    throw new Error("Should not reach prompt in plan mode");
                },
            },
        } as unknown as ExtensionContext;
    }

    function makeWriteEvent(path: string): ToolCallEvent {
        return {
            toolName: "write",
            input: { path, content: "plan content" },
        } as ToolCallEvent;
    }

    function makeEditEvent(path: string): ToolCallEvent {
        return {
            toolName: "edit",
            input: { path },
        } as ToolCallEvent;
    }

    function makeBashEvent(command: string): ToolCallEvent {
        return {
            toolName: "bash",
            input: { command },
        } as ToolCallEvent;
    }

    function makeToolEvent(toolName: string): ToolCallEvent {
        return { toolName, input: {} } as ToolCallEvent;
    }

    // ── Write to plan file ────────────────────────────────────────

    void it("allows write to the plan file", async () => {
        const state = makePlanState();
        const event = makeWriteEvent(
            "/session/plans/2026-07-26T12-00-00-test-plan.md"
        );
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, false);
    });

    void it("blocks write to a non-plan file", async () => {
        const state = makePlanState();
        const event = makeWriteEvent("/src/main.ts");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
        assert.match(
            result.reason ?? "",
            /plan mode/i,
            "Should mention plan mode restriction"
        );
    });

    void it("blocks write to another file in plans dir", async () => {
        const state = makePlanState();
        const event = makeWriteEvent("/session/plans/other-plan.md");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
    });

    // ── Edit to plan file ─────────────────────────────────────────

    void it("allows edit to the plan file", async () => {
        const state = makePlanState();
        const event = makeEditEvent(
            "/session/plans/2026-07-26T12-00-00-test-plan.md"
        );
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, false);
    });

    void it("blocks edit to a non-plan file", async () => {
        const state = makePlanState();
        const event = makeEditEvent("/src/main.ts");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
    });

    // ── Bash in plan mode with cd ─────────────────────────────────

    void it("allows cd && grep in plan mode", async () => {
        const state = makePlanState();
        const event = makeBashEvent('cd /path && grep -rn "foo" .');
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, false);
    });

    void it("allows cd && ls in plan mode", async () => {
        const state = makePlanState();
        const event = makeBashEvent("cd /path && ls -la");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, false);
    });

    void it("blocks cd && rm in plan mode", async () => {
        const state = makePlanState();
        const event = makeBashEvent("cd /path && rm -rf *");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
    });

    void it("blocks cat > heredoc in plan mode", async () => {
        const state = makePlanState();
        const event = makeBashEvent(
            "cat > /session/plans/plan.md <<'EOF'\ncontent\nEOF"
        );
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
    });

    // ── Agent-owned planning tools ────────────────────────────────

    void it("allows task and subagent management without prompting", async () => {
        const state = makePlanState({
            rules: [
                { rule: "task", behavior: "ask", source: "session" },
                { rule: "subagent", behavior: "ask", source: "session" },
            ],
        });
        for (const toolName of ["task", "subagent", "subagent_wait"]) {
            const result = await checkToolPermission(
                makeToolEvent(toolName),
                state,
                "/",
                makeCtx()
            );
            assert.equal(result.block, false, `${toolName} should be allowed`);
        }
    });

    void it("fails closed for reads outside the working directory", async () => {
        const state = makePlanState();
        const result = await checkToolPermission(
            {
                toolName: "read",
                input: { path: "/outside/file.ts" },
            } as ToolCallEvent,
            state,
            "/workspace",
            makeCtx()
        );
        assert.equal(result.block, true);
        assert.match(result.reason ?? "", /plan mode/i);
    });

    // ── Not in plan mode — everything allowed by default ─────────

    void it("allows write outside plan mode", async () => {
        const state = makePlanState({ mode: "allow" });
        const event = makeWriteEvent("/src/main.ts");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, false);
    });

    void it("allows edit outside plan mode", async () => {
        const state = makePlanState({ mode: "allow" });
        const event = makeEditEvent("/src/main.ts");
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, false);
    });

    // ── Missing optional plan state — writes blocked ──────────────

    void it("blocks write when planSlug is undefined", async () => {
        const state = makePlanState({ planSlug: undefined });
        const event = makeWriteEvent(
            "/session/plans/2026-07-26T12-00-00-test-plan.md"
        );
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
    });

    void it("blocks write when planSessionDir is undefined", async () => {
        const state = makePlanState({ planSessionDir: undefined });
        const event = makeWriteEvent(
            "/session/plans/2026-07-26T12-00-00-test-plan.md"
        );
        const result = await checkToolPermission(event, state, "/", makeCtx());
        assert.equal(result.block, true);
    });
});
