/**
 * Plan mode must not change the ordered active-tool list.
 *
 * Replacing the active tool set rewrites the provider's prompt prefix, which
 * throws away the whole cached prefill: the session evidence behind
 * `fix(permissions): preserve cache across plan-mode changes` shows cacheRead
 * dropping from 142,966 to 11,000 (and input rising to 125,630) on the first
 * request after enter_plan_mode, and the same again after exit_plan_mode.
 *
 * The other plan-mode tests assert that `pi.setActiveTools` is never called.
 * That is the mechanism, not the contract. This test asserts the observable
 * contract directly: `pi.getActiveTools()` returns the same ordered list
 * before, during and after a mode cycle, and it does so across every entry and
 * exit path (the tools, the /perm command, and cancellation).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlanTools, cancelPlanMode } from "../features/plan-tools.ts";
import { registerPermissions } from "../features/permissions/commands.ts";
import { TauState } from "../state.ts";

type RegisteredTool = {
    execute: (...args: unknown[]) => Promise<unknown>;
};

type RegisteredCommand = {
    handler: (args: string, ctx: unknown) => Promise<void> | void;
};

/**
 * Deliberately neither the old plan-mode subset nor the normal-mode default,
 * and deliberately not alphabetical: any replacement of the active set shows
 * up as both a length change and an order change.
 */
const ORDERED_ACTIVE_TOOLS = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "task",
    "subagent",
    "subagent_wait",
    "questionnaire",
    "jobs",
    "bash_bg",
    "enter_plan_mode",
    "exit_plan_mode",
];

function makeHarness() {
    const cwd = mkdtempSync(join(tmpdir(), "pi-tau-schema-order-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
            tau: {
                plan: { reviewMode: "agent", defaultExecutionMode: "continue" },
            },
        })
    );

    const sessionDir = join(cwd, "session");
    const state = new TauState();
    const tools = new Map<string, RegisteredTool>();
    const commands = new Map<string, RegisteredCommand>();
    const applied: string[][] = [];
    let activeTools = [...ORDERED_ACTIVE_TOOLS];

    const pi = {
        registerTool(definition: {
            name: string;
            execute: RegisteredTool["execute"];
        }) {
            tools.set(definition.name, definition);
        },
        registerCommand(name: string, command: RegisteredCommand) {
            commands.set(name, command);
        },
        registerShortcut() {},
        getActiveTools: () => [...activeTools],
        setActiveTools(names: string[]) {
            applied.push([...names]);
            activeTools = [...names];
        },
        appendEntry() {},
        sendMessage() {},
        getThinkingLevel: () => "off",
        setThinkingLevel() {},
    } as unknown as ExtensionAPI;

    const ctx = {
        cwd,
        hasUI: false,
        sessionManager: {
            getSessionDir: () => sessionDir,
            getSessionId: () => "schema-order-session",
        },
        ui: {
            notify() {},
            setStatus() {},
            theme: { fg: (_colour: string, text: string) => text },
            select: async () => {
                throw new Error("plan mode must not open a UI selector here");
            },
        },
    };

    registerPlanTools(pi, state);
    registerPermissions(pi, state);

    return {
        cwd,
        state,
        pi,
        tools,
        commands,
        ctx,
        activeList: () => [...activeTools],
        applied,
        cleanup: () => rmSync(cwd, { recursive: true, force: true }),
    };
}

type Harness = ReturnType<typeof makeHarness>;

function assertSchemaUnchanged(harness: Harness, when: string): void {
    assert.deepEqual(
        harness.activeList(),
        ORDERED_ACTIVE_TOOLS,
        `ordered active tool list changed ${when}`
    );
    assert.deepEqual(
        harness.applied,
        [],
        `pi.setActiveTools was called ${when}: ${JSON.stringify(harness.applied)}`
    );
}

async function callTool(
    harness: Harness,
    name: string,
    params: Record<string, unknown>
): Promise<unknown> {
    const tool = harness.tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    return await tool.execute(
        "test-call",
        params,
        undefined,
        undefined,
        harness.ctx
    );
}

async function callCommand(
    harness: Harness,
    name: string,
    args: string
): Promise<void> {
    const command = harness.commands.get(name);
    assert.ok(command, `${name} command must be registered`);
    await command.handler(args, harness.ctx);
}

void describe("plan mode keeps the ordered active tool list unchanged", () => {
    void it("keeps the same list across an enter/exit cycle driven by the tools", async () => {
        const harness = makeHarness();
        try {
            harness.state.permissionMode = "allow";
            assertSchemaUnchanged(harness, "before entering plan mode");

            await callTool(harness, "enter_plan_mode", {
                title: "Schema order",
            });
            assert.equal(harness.state.permissionMode, "plan");
            assertSchemaUnchanged(harness, "while in plan mode");

            // First call asks for agent review; the second approves and exits.
            await callTool(harness, "exit_plan_mode", { action: "approve" });
            assert.equal(harness.state.permissionMode, "plan");
            assertSchemaUnchanged(harness, "after the plan review request");

            await callTool(harness, "exit_plan_mode", { action: "approve" });
            assert.equal(harness.state.permissionMode, "allow");
            assertSchemaUnchanged(harness, "after exiting plan mode");
        } finally {
            harness.cleanup();
        }
    });

    void it("keeps the same list across the /perm command cycle", async () => {
        const harness = makeHarness();
        try {
            harness.state.permissionMode = "allow";

            await callCommand(harness, "perm", "plan");
            assert.equal(harness.state.permissionMode, "plan");
            assertSchemaUnchanged(harness, "after /perm plan");

            await callCommand(harness, "perm", "allow");
            assert.equal(harness.state.permissionMode, "allow");
            assertSchemaUnchanged(harness, "after /perm allow");
        } finally {
            harness.cleanup();
        }
    });

    void it("keeps the same list when plan mode is cancelled", async () => {
        const harness = makeHarness();
        try {
            harness.state.permissionMode = "plan";
            harness.state.planSlug = "2026-10-31-cancel";
            harness.state.planPreviousMode = "allow";
            harness.state.planEnteredAt = Date.now();

            cancelPlanMode(harness.pi, harness.state, harness.ctx as never);
            assert.equal(harness.state.permissionMode, "allow");
            assertSchemaUnchanged(harness, "after cancelling plan mode");
        } finally {
            harness.cleanup();
        }
    });
});
