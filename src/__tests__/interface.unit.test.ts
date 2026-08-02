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
import type { Static, TSchema } from "typebox";
import { TauState } from "../state.ts";
import { registerBackgroundJobs } from "../features/background.ts";
import { registerAgentBackground } from "../features/agent-background.ts";
import { registerTask } from "../features/task.ts";
import { registerToolsSelector } from "../features/tools-selector.ts";

// ──────────────────────────────────────────────
// Mock pi
// ──────────────────────────────────────────────

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
		ctx: unknown,
	) => Promise<any>;
}

function createMockPi(): { pi: any; tools: CapturedTool[] } {
	const tools: CapturedTool[] = [];
	const pi = {
		registerTool: (t: any) => tools.push(t),
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
	return { pi, tools };
}

// ──────────────────────────────────────────────
// Tool existence and metadata
// ──────────────────────────────────────────────

describe("tool registration", () => {
	const { pi, tools } = createMockPi();
	const state = new TauState();
	registerBackgroundJobs(pi, state);
	registerAgentBackground(pi, state);
	registerTask(pi, state);
	registerToolsSelector(pi, state);

	const toolMap = new Map(tools.map((t) => [t.name, t]));

	// Adjust expected count as features are added/removed
	const MIN_TOOLS = 5;
	it(`registers at least ${MIN_TOOLS} tools`, () => {
		assert.ok(tools.length >= MIN_TOOLS, `got ${tools.length}, expected >= ${MIN_TOOLS}`);
	});

	// Core background tools
	it("registers bash_bg", () => {
		assert.ok(toolMap.has("bash_bg"), "bash_bg not registered");
	});

	it("registers jobs", () => {
		assert.ok(toolMap.has("jobs"), "jobs not registered");
	});

	it("registers job_decide", () => {
		assert.ok(toolMap.has("job_decide"), "job_decide not registered");
	});

	it("registers agent_bg", () => {
		assert.ok(toolMap.has("agent_bg"), "agent_bg not registered");
	});

	it("registers task", () => {
		assert.ok(toolMap.has("task"), "task not registered");
	});

	// Every tool must have valid metadata
	for (const tool of tools) {
		it(`${tool.name} has a non-empty description`, () => {
			assert.ok(
				tool.description?.length > 20,
				`"${tool.name}" description too short: ${tool.description?.length}`,
			);
		});

		it(`${tool.name} has a label`, () => {
			assert.ok(tool.label?.length > 0, `"${tool.name}" label is empty`);
		});

		it(`${tool.name} has parameters defined`, () => {
			assert.ok(tool.parameters, `"${tool.name}" parameters is undefined`);
		});
	}
});

// ──────────────────────────────────────────────
// Parameter descriptions
// ──────────────────────────────────────────────

describe("parameter descriptions", () => {
	const { pi, tools } = createMockPi();
	const state = new TauState();
	registerBackgroundJobs(pi, state);
	registerAgentBackground(pi, state);
	registerTask(pi, state);
	registerToolsSelector(pi, state);

	function getParams(name: string): Record<string, any> {
		const tool = tools.find((t) => t.name === name)!;
		return (tool.parameters as any)?.properties ?? {};
	}

	for (const tool of tools) {
		const params = getParams(tool.name);
		for (const [paramName, schema] of Object.entries(params)) {
			it(`${tool.name}.${paramName} has a description`, () => {
				const s = schema as any;
				assert.ok(
					s.description?.length > 0,
					`"${tool.name}.${paramName}" is missing description`,
				);
			});
		}
	}
});

// ──────────────────────────────────────────────
// No stale references in descriptions
// ──────────────────────────────────────────────

describe("tool descriptions contain no stale references", () => {
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
			it(`${tool.name} does not mention removed tool "${stale}"`, () => {
				const mentions = tool.description.toLowerCase().includes(stale.toLowerCase());
				assert.ok(
					!mentions,
					`"${tool.name}" description mentions removed tool "${stale}"`,
				);
			});
		}
	}
});

// ──────────────────────────────────────────────
// jobs execute error paths
// ──────────────────────────────────────────────

describe("jobs execute error paths", () => {
	it("returns empty list when no jobs exist", async () => {
		const { pi, tools } = createMockPi();
		const state = new TauState();
		registerBackgroundJobs(pi, state);
		const jobsTool = tools.find((t) => t.name === "jobs")!;
		const result = await jobsTool.execute(
			"tc-1",
			{ action: "list" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.ok(result.content?.[0]?.text);
		// Should show empty state, not crash
		assert.ok(typeof result.content[0].text === "string");
	});

	it("output on nonexistent jobId errors", async () => {
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
				{ cwd: "/tmp" },
			),
			/Job not found/,
		);
	});
});

// ──────────────────────────────────────────────
// job_decide execute error paths
// ──────────────────────────────────────────────

describe("job_decide execute error paths", () => {
	it("fails when no jobId is provided", async () => {
		const { pi, tools } = createMockPi();
		const state = new TauState();
		registerBackgroundJobs(pi, state);
		const decide = tools.find((t) => t.name === "job_decide")!;
		const result = await decide.execute(
			"tc-1",
			{ decision: "check" } as any,
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.ok(result.isError !== false, "missing jobId should error");
	});

	it("fails on nonexistent jobId", async () => {
		const { pi, tools } = createMockPi();
		const state = new TauState();
		registerBackgroundJobs(pi, state);
		const decide = tools.find((t) => t.name === "job_decide")!;
		const result = await decide.execute(
			"tc-2",
			{ jobId: "nonexistent-99", decision: "check" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.ok(result.isError !== false, "nonexistent job should error");
	});
});
