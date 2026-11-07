/**
 * Interface contract tests for pi-tau extension.
 *
 * Loads the extension factory with a mock pi, captures all tool
 * registrations, and validates:
 *   - Tool count, names, labels, descriptions, parameters
 *   - Parameter descriptions
 *   - No stale references in descriptions
 *   - Execute error paths for pure-logic branches
 *
 * Runs with: `node --test src/__tests__/interface.unit.test.ts`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TauState } from "../state.ts";
import { registerBackgroundJobs } from "../features/background.ts";
import { registerAgentBackground } from "../features/agent-background.ts";
import { registerTask } from "../features/task.ts";
import { registerToolsSelector } from "../features/tools-selector.ts";

// ──────────────────────────────────────────────
// Mock pi
// ──────────────────────────────────────────────

interface ToolExecuteResult {
    content?: { text?: string }[];
    isError?: boolean;
    [key: string]: unknown;
}

interface CapturedTool {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TSchema;
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<ToolExecuteResult>;
}

function createMockPi(): { pi: ExtensionAPI; tools: CapturedTool[] } {
    const tools: CapturedTool[] = [];
    const pi = {
        registerTool: (t: CapturedTool) => {
            tools.push(t);
        },
        registerCommand: () => {},
        registerFlag: () => {},
        registerShortcut: () => {},
        registerToolPromptGuidelines: () => {},
        getSessionName: () => "test-session",
        on: () => {},
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => {},
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "none" as const,
        setThinkingLevel: () => {},
        sendMessage: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        setSessionName: () => {},
        setLabel: () => {},
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        getFlag: () => undefined,
        createBashTool: () => ({ execute: () => ({ content: [] }) }),
        events: { on: () => {}, emit: () => {} },
    };
    return { pi: pi as unknown as ExtensionAPI, tools };
}

// ──────────────────────────────────────────────
// Tool existence and metadata
// ──────────────────────────────────────────────

void describe("tool registration", () => {
    const { pi, tools } = createMockPi();
    const state = new TauState();
    registerBackgroundJobs(pi, state);
    registerAgentBackground(pi, state);
    registerTask(pi, state);
    registerToolsSelector(pi, state);

    const toolMap = new Map(tools.map((t) => [t.name, t]));

    // Adjust expected count as features are added/removed
    const MIN_TOOLS = 5;
    void it(`registers at least ${MIN_TOOLS} tools`, () => {
        assert.ok(
            tools.length >= MIN_TOOLS,
            `got ${tools.length}, expected >= ${MIN_TOOLS}`
        );
    });

    // Core background tools
    void it("registers bash_bg", () => {
        assert.ok(toolMap.has("bash_bg"), "bash_bg not registered");
    });

    void it("registers jobs", () => {
        assert.ok(toolMap.has("jobs"), "jobs not registered");
    });

    void it("registers job_decide", () => {
        assert.ok(toolMap.has("job_decide"), "job_decide not registered");
    });

    void it("registers agent_bg", () => {
        assert.ok(toolMap.has("agent_bg"), "agent_bg not registered");
    });

    void it("registers task", () => {
        assert.ok(toolMap.has("task"), "task not registered");
    });

    // Every tool must have valid metadata
    for (const tool of tools) {
        void it(`${tool.name} has a non-empty description`, () => {
            assert.ok(
                tool.description?.length > 20,
                `"${tool.name}" description too short: ${tool.description?.length}`
            );
        });

        void it(`${tool.name} has a label`, () => {
            assert.ok(tool.label?.length > 0, `"${tool.name}" label is empty`);
        });

        void it(`${tool.name} has parameters defined`, () => {
            assert.ok(
                tool.parameters,
                `"${tool.name}" parameters is undefined`
            );
        });
    }
});

// ──────────────────────────────────────────────
// Parameter descriptions
// ──────────────────────────────────────────────

void describe("parameter descriptions", () => {
    const { pi, tools } = createMockPi();
    const state = new TauState();
    registerBackgroundJobs(pi, state);
    registerAgentBackground(pi, state);
    registerTask(pi, state);
    registerToolsSelector(pi, state);

    function getParams(name: string): Record<string, { description?: string }> {
        const tool = tools.find((t) => t.name === name)!;
        return (
            (
                tool.parameters as unknown as {
                    properties?: Record<string, { description?: string }>;
                }
            ).properties ?? {}
        );
    }

    for (const tool of tools) {
        const params = getParams(tool.name);
        for (const [paramName, schema] of Object.entries(params)) {
            void it(`${tool.name}.${paramName} has a description`, () => {
                const s = schema;
                assert.ok(
                    (s.description?.length ?? 0) > 0,
                    `"${tool.name}.${paramName}" is missing description`
                );
            });
        }
    }
});

// ──────────────────────────────────────────────
// No stale references in descriptions
// ──────────────────────────────────────────────

void describe("tool descriptions contain no stale references", () => {
    const { pi, tools } = createMockPi();
    const state = new TauState();
    registerBackgroundJobs(pi, state);
    registerAgentBackground(pi, state);
    registerTask(pi, state);
    registerToolsSelector(pi, state);

    // Tool names that have been removed or renamed — should not appear in descriptions
    const staleNames: string[] = [];

    for (const tool of tools) {
        for (const stale of staleNames) {
            void it(`${tool.name} does not mention removed tool "${stale}"`, () => {
                const mentions = tool.description
                    .toLowerCase()
                    .includes(stale.toLowerCase());
                assert.ok(
                    !mentions,
                    `"${tool.name}" description mentions removed tool "${stale}"`
                );
            });
        }
    }
});

// ──────────────────────────────────────────────
// jobs execute error paths
// ──────────────────────────────────────────────

void describe("jobs execute error paths", () => {
    void it("returns empty list when no jobs exist", async () => {
        const { pi, tools } = createMockPi();
        const state = new TauState();
        registerBackgroundJobs(pi, state);
        const jobsTool = tools.find((t) => t.name === "jobs")!;
        const result = await jobsTool.execute(
            "tc-1",
            { action: "list" },
            undefined,
            undefined,
            { cwd: "/tmp" }
        );
        assert.ok(result.content?.[0]?.text);
        // Should show empty state, not crash
        assert.ok(typeof result.content[0].text === "string");
    });

    void it("output on nonexistent jobId errors", async () => {
        const { pi, tools } = createMockPi();
        const state = new TauState();
        registerBackgroundJobs(pi, state);
        const jobsTool = tools.find((t) => t.name === "jobs")!;
        await assert.rejects(
            jobsTool.execute(
                "tc-2",
                { action: "output", jobId: "nonexistent-42" },
                undefined,
                undefined,
                { cwd: "/tmp" }
            ),
            /Job not found/
        );
    });
});

// ──────────────────────────────────────────────
// job_decide execute error paths
// ──────────────────────────────────────────────

void describe("job_decide execute error paths", () => {
    void it("fails when no jobId is provided", async () => {
        const { pi, tools } = createMockPi();
        const state = new TauState();
        registerBackgroundJobs(pi, state);
        const decide = tools.find((t) => t.name === "job_decide")!;
        const result = await decide.execute(
            "tc-1",
            { decision: "check" },
            undefined,
            undefined,
            { cwd: "/tmp" }
        );
        assert.ok(result.isError !== false, "missing jobId should error");
    });

    void it("fails on nonexistent jobId", async () => {
        const { pi, tools } = createMockPi();
        const state = new TauState();
        registerBackgroundJobs(pi, state);
        const decide = tools.find((t) => t.name === "job_decide")!;
        const result = await decide.execute(
            "tc-2",
            { jobId: "nonexistent-99", decision: "check" },
            undefined,
            undefined,
            { cwd: "/tmp" }
        );
        assert.ok(result.isError !== false, "nonexistent job should error");
    });
});
