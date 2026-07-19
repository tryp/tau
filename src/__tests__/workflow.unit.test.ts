import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── parseMeta tests ────────────────────────────────────────────────

void describe("workflow parseMeta", () => {
    void it("extracts a valid meta block", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        const meta = parseMeta(`
export const meta = {
  name: "test-workflow",
  description: "A test workflow"
}

const result = await agent("hello");
`);
        assert.equal(meta.name, "test-workflow");
        assert.equal(meta.description, "A test workflow");
    });

    void it("extracts meta with phases", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        const meta = parseMeta(`
export const meta = {
  name: "phased-workflow",
  description: "Has phases",
  phases: [
    { title: "Research", kind: "parallel" },
    { title: "Implement", kind: "sequential" }
  ]
}

await agent("go");
`);
        assert.equal(meta.name, "phased-workflow");
        assert.ok(meta.phases);
        assert.equal(meta.phases.length, 2);
        assert.equal(meta.phases[0].title, "Research");
        assert.equal(meta.phases[0].kind, "parallel");
        assert.equal(meta.phases[1].kind, "sequential");
    });

    void it("throws when meta block is missing", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        assert.throws(
            () => parseMeta('const x = await agent("hello");'),
            /must contain/
        );
    });

    void it("throws when name is missing", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        assert.throws(
            () =>
                parseMeta(`
export const meta = {
  description: "No name"
}
`),
            /name is required/
        );
    });

    void it("throws when description is missing", async () => {
        const { parseMeta } = await import("../features/workflow.ts");
        assert.throws(
            () =>
                parseMeta(`
export const meta = {
  name: "no-desc"
}
`),
            /description is required/
        );
    });
});

// ─── checkDeterminism tests ─────────────────────────────────────────

void describe("workflow checkDeterminism", () => {
    void it("returns undefined for deterministic scripts", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        assert.equal(
            checkDeterminism('const r = await agent("hello");'),
            undefined
        );
    });

    void it("returns error for Date.now()", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        const err = checkDeterminism("const t = Date.now();");
        assert.ok(err);
        assert.ok(err.includes("Date.now()"));
    });

    void it("returns error for Math.random()", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        const err = checkDeterminism("const r = Math.random();");
        assert.ok(err);
        assert.ok(err.includes("Math.random()"));
    });

    void it("returns error for new Date()", async () => {
        const { checkDeterminism } = await import("../features/workflow.ts");
        const err = checkDeterminism("const d = new Date();");
        assert.ok(err);
        assert.ok(err.includes("new Date()"));
    });
});

// ─── computeAgentKey tests ──────────────────────────────────────────

void describe("workflow computeAgentKey", () => {
    void it("returns a stable key for same inputs", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello", { model: "sonnet" });
        const key2 = computeAgentKey("hello", { model: "sonnet" });
        assert.equal(key1, key2);
    });

    void it("returns different keys for different prompts", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello");
        const key2 = computeAgentKey("world");
        assert.notEqual(key1, key2);
    });

    void it("returns different keys for different opts", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello", { model: "sonnet" });
        const key2 = computeAgentKey("hello", { model: "opus" });
        assert.notEqual(key1, key2);
    });

    void it("returns same key for same prompt without opts", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key1 = computeAgentKey("hello");
        const key2 = computeAgentKey("hello");
        assert.equal(key1, key2);
    });

    void it("key starts with agent: prefix", async () => {
        const { computeAgentKey } = await import("../features/workflow.ts");
        const key = computeAgentKey("test");
        assert.ok(key.startsWith("agent:"));
    });
});

// ─── getCachedResult tests ──────────────────────────────────────────

void describe("workflow getCachedResult", () => {
    void it("finds a cached result by key", async () => {
        const { getCachedResult } = await import("../features/workflow.ts");
        const run = {
            runId: "wf_test",
            name: "test",
            script: "",
            status: "completed" as const,
            startedAt: 0,
            cachedResults: [
                {
                    key: "agent:abc123",
                    prompt: "hello",
                    result: "world",
                    completedAt: 100,
                },
            ],
        };
        const found = getCachedResult(run, "agent:abc123");
        assert.ok(found);
        assert.equal(found.result, "world");
    });

    void it("returns undefined for missing key", async () => {
        const { getCachedResult } = await import("../features/workflow.ts");
        const run = {
            runId: "wf_test",
            name: "test",
            script: "",
            status: "completed" as const,
            startedAt: 0,
            cachedResults: [],
        };
        assert.equal(getCachedResult(run, "agent:missing"), undefined);
    });
});

// ─── extractScriptBody tests ────────────────────────────────────────

void describe("workflow extractScriptBody", () => {
    void it("strips the meta export block", async () => {
        const { extractScriptBody } = await import("../features/workflow.ts");
        const body = extractScriptBody(`
export const meta = {
  name: "test",
  description: "test"
}

const r = await agent("hello");
`);
        assert.ok(!body.includes("export const meta"));
        assert.ok(body.includes('await agent("hello")'));
    });

    void it("returns trimmed body when no meta present", async () => {
        const { extractScriptBody } = await import("../features/workflow.ts");
        const body = extractScriptBody('const r = await agent("go");');
        assert.ok(body.includes("agent"));
    });

    void it("strips non-meta ESM export/import keywords", async () => {
        const { extractScriptBody } = await import("../features/workflow.ts");
        const body = extractScriptBody(`
export const meta = {
  name: "t",
  description: "t"
}

import { foo } from "bar";

export default async function ({ agent }) {
  return agent("go")
}
`);
        // No export/import tokens survive into the vm.Script body.
        assert.ok(!/\bexport\b/.test(body));
        assert.ok(!/\bimport\b/.test(body));
        // The default-exported function body is retained as a plain decl.
        assert.ok(body.includes("async function"));
        assert.ok(body.includes('agent("go")'));
    });
});

// ─── extractAgentText / stripEscapes tests ─────────────────────────

void describe("workflow extractAgentText", () => {
    void it("extracts the final assistant message from agent_end", async () => {
        const { extractAgentText } = await import("../features/workflow.ts");
        const stream = [
            '{"type":"session"}',
            '{"type":"agent_start"}',
            '{"type":"message_end","message":{"role":"user"}}',
            '{"type":"agent_end","messages":[{"role":"user","content":[{"text":"hi"}]},{"role":"assistant","content":[{"text":"Hello world"}]}],"willRetry":false}',
        ].join("\n");
        assert.equal(extractAgentText(stream), "Hello world");
    });

    void it("falls back to concatenated text_delta events", async () => {
        const { extractAgentText } = await import("../features/workflow.ts");
        const stream = [
            '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"foo "}}',
            '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"bar"}}',
        ].join("\n");
        assert.equal(extractAgentText(stream), "foo bar");
    });

    void it("ignores OSC escape noise interleaved with JSON", async () => {
        const { extractAgentText, stripEscapes } =
            await import("../features/workflow.ts");
        const esc = String.fromCharCode(27);
        const bel = String.fromCharCode(7);
        const stream =
            esc +
            "]777;notify;Pi;OK" +
            bel +
            '{"type":"agent_end","messages":[{"role":"assistant","content":[{"text":"OK"}]}]}';
        assert.equal(
            stripEscapes(stream),
            '{"type":"agent_end","messages":[{"role":"assistant","content":[{"text":"OK"}]}]}'
        );
        assert.equal(extractAgentText(stream), "OK");
    });

    void it("returns empty string for unparseable output", async () => {
        const { extractAgentText } = await import("../features/workflow.ts");
        assert.equal(extractAgentText("not json at all"), "");
        assert.equal(extractAgentText(""), "");
    });
});

// ─── Claude Code script structure compatibility ────────────────────

void describe("workflow getPiInvocation", () => {
    void it("re-invokes the current on-disk entry script when present", async () => {
        const { getPiInvocation } = await import("../features/workflow.ts");
        const out = getPiInvocation(
            ["-p", "--mode", "json"],
            {
                argv1: "/usr/local/bin/pi",
                execPath: "/usr/local/bin/node",
                platform: "darwin",
            },
            () => true // argv1 exists on disk
        );
        assert.equal(out.command, "/usr/local/bin/node");
        assert.deepEqual(out.args, [
            "/usr/local/bin/pi",
            "-p",
            "--mode",
            "json",
        ]);
    });

    void it("uses execPath directly for a non-generic runtime", async () => {
        const { getPiInvocation } = await import("../features/workflow.ts");
        // Bun-compiled pi binary: argv1 is the bun virtual fs, execPath is pi.
        const out = getPiInvocation(
            ["--no-session"],
            {
                argv1: "/$bunfs/root/lolcat.js",
                execPath: "/Users/joe/.local/share/claude/versions/2.1.199",
                platform: "darwin",
            },
            () => false
        );
        assert.equal(
            out.command,
            "/Users/joe/.local/share/claude/versions/2.1.199"
        );
        assert.deepEqual(out.args, ["--no-session"]);
    });

    void it("falls back to `pi` on PATH for a generic node/bun runtime", async () => {
        const { getPiInvocation } = await import("../features/workflow.ts");
        const out = getPiInvocation(
            ["-p"],
            {
                argv1: undefined,
                execPath: "/usr/local/bin/node",
                platform: "linux",
            },
            () => false
        );
        assert.equal(out.command, "pi");
        assert.deepEqual(out.args, ["-p"]);
    });
});

// ─── Claude Code script structure compatibility ────────────────────

void describe("workflow claude-script structure", () => {
    void it("parses meta with phases[{title,kind}] and strips nothing else", async () => {
        const { parseMeta, extractScriptBody } =
            await import("../features/workflow.ts");
        const script = [
            "export const meta = {",
            "  name: 'tf-backends',",
            "  description: 'Add Terraform backends',",
            "  phases: [",
            "    { title: 'Design', kind: 'sequential' },",
            "    { title: 'Implement', kind: 'sequential' },",
            "  ],",
            "}",
            "",
            "phase('Design')",
            "const design = await agent('design it', { label: 'design', phase: 'Design' })",
            "log('got design')",
            "phase('Implement')",
            "await agent(`implement: ${design}`, { label: 'impl', model: 'sonnet' })",
        ].join("\n");
        const meta = parseMeta(script);
        assert.equal(meta.name, "tf-backends");
        assert.equal(meta.phases?.[0].title, "Design");
        assert.equal(meta.phases?.[0].kind, "sequential");

        // The body retains the Claude-script top-level structure (no export
        // tokens, phase()/log()/agent() calls intact) so it is VM-valid.
        const body = extractScriptBody(script);
        assert.ok(!/\bexport\b/.test(body));
        assert.ok(body.includes("phase('Design')"));
        assert.ok(body.includes("log('got design')"));
        assert.ok(body.includes("model: 'sonnet'"));
    });
});

// ─── Registration tests ─────────────────────────────────────────────

void describe("workflow registration", () => {
    void it("exports registerWorkflow function", async () => {
        const mod = await import("../features/workflow.ts");
        assert.equal(typeof mod.registerWorkflow, "function");
    });

    void it("registers /workflow command", async () => {
        const { registerWorkflow } = await import("../features/workflow.ts");

        const commands = new Map<
            string,
            { description: string; handler: () => Promise<void> }
        >();
        const events = new Map<string, Array<() => Promise<unknown>>>();
        const entries: Array<{
            type: string;
            customType: string;
            data: unknown;
        }> = [];
        const sentMessages: Array<{ text: string; options?: unknown }> = [];

        const mockPi = {
            registerCommand(
                name: string,
                opts: {
                    description: string;
                    handler: () => Promise<void>;
                }
            ) {
                commands.set(name, opts);
            },
            on(event: string, handler: () => Promise<unknown>) {
                const arr = events.get(event) ?? [];
                arr.push(handler);
                events.set(event, arr);
            },
            appendEntry(customType: string, data: unknown) {
                entries.push({ type: "custom", customType, data });
            },
            sendUserMessage(text: string, options?: unknown) {
                sentMessages.push({ text, options });
            },
            registerTool: () => {},
        };

        const mockState = { activeWorkflow: undefined };

        registerWorkflow(
            mockPi as unknown as Parameters<typeof registerWorkflow>[0],
            mockState as unknown as Parameters<typeof registerWorkflow>[1]
        );

        assert.ok(commands.has("workflow"));
        assert.ok(events.has("session_start"));
    });
});

// ─── resolveWorkflow tests ───────────────────────────────────────────

void describe("workflow resolveWorkflow", () => {
    void it("returns undefined for nonexistent workflow", async () => {
        const { resolveWorkflow } = await import("../features/workflow.ts");
        assert.equal(resolveWorkflow("nonexistent", "/tmp"), undefined);
    });
});

// ─── listWorkflows tests ─────────────────────────────────────────────

void describe("workflow listWorkflows", () => {
    void it("returns empty array when directory does not exist", async () => {
        const { listWorkflows } = await import("../features/workflow.ts");
        const workflows = listWorkflows("/tmp/nonexistent-dir-xyz");
        assert.deepEqual(workflows, []);
    });
});
