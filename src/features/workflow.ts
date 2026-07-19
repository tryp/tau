/**
 * Workflow feature — orchestrates multi-agent tasks via deterministic JavaScript scripts.
 *
 * Uses the same script format as Claude Code's /workflows for interoperability:
 *
 *   export const meta = {
 *     name: "my-workflow",
 *     description: "Does things",
 *     phases: [{ title: "Research", kind: "parallel" }]
 *   }
 *
 *   const result = await agent("Do something");
 *   await agent(`Continue with: ${result}`);
 *
 * Scripts execute in a Node.js VM sandbox with global functions:
 *   agent(prompt, opts?)  — spawn a subagent, return text result
 *   parallel(fns)         — run Array<() => Promise<T>> concurrently
 *   pipeline(fns)         — chain steps sequentially, piping output
 *   args                  — user-provided arguments
 *
 * Commands:
 *   /workflow run <name>          — run named workflow from .claude/workflows/
 *   /workflow run --file <path>   — run from file
 *   /workflow run --inline <js>   — run inline script
 *   /workflow list                — list available workflows
 *   /workflow status              — show current run progress
 *   /workflow stop                — stop the running workflow
 */

import { createContext, Script } from "node:vm";
import { createHash, randomBytes } from "node:crypto";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TauState } from "../state.ts";
import { isFeatureEnabled } from "./features-helpers.ts";
import { killProcessGroup } from "../utils.ts";
import type {
    WorkflowMeta,
    WorkflowRun,
    WorkflowAgentResult,
} from "../types.ts";

// ─── Constants ──────────────────────────────────────────────────────

const WORKFLOW_DIR = ".claude/workflows";
const SESSION_WORKFLOW_DIR = "workflows";

/** Per-run abort controllers, keyed by runId. Kept out of WorkflowRun so the
 *  non-serialisable controller is never persisted in session entries. */
const runAbortControllers = new Map<string, AbortController>();

/** Default per-agent timeout. A single hung `pi -p` must not block the whole
 *  workflow; this fails the agent loudly instead. */
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Meta parser ────────────────────────────────────────────────────

/**
 * Extract the `export const meta = {...}` block from a workflow script.
 * The meta block must be a pure literal — no computed values, no function calls.
 */
export function parseMeta(script: string): WorkflowMeta {
    const match = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/);
    if (!match) {
        throw new Error(
            "Workflow script must contain `export const meta = { ... }`"
        );
    }

    const metaSource = match[1];

    // Evaluate the meta literal in a safe context
    const vmContext = createContext({ Object, Array });
    try {
        const metaScript = new Script(`(${metaSource})`);
        const meta = metaScript.runInContext(vmContext) as WorkflowMeta;

        if (!meta.name || typeof meta.name !== "string") {
            throw new Error("meta.name is required and must be a string");
        }
        if (!meta.description || typeof meta.description !== "string") {
            throw new Error(
                "meta.description is required and must be a string"
            );
        }

        return {
            name: meta.name,
            description: meta.description,
            phases: meta.phases?.map((p) => ({
                title: p.title,
                kind: p.kind,
            })),
        };
    } catch (err) {
        throw new Error(
            `Invalid meta block: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
        );
    }
}

// ─── Determinism check ──────────────────────────────────────────────

const NONDETERMINISTIC_RE =
    /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(/;

/**
 * Validate that a script is deterministic (no Date.now/Math.random/new Date).
 */
export function checkDeterminism(scriptBody: string): string | undefined {
    if (NONDETERMINISTIC_RE.test(scriptBody)) {
        return (
            "Workflow scripts must be deterministic: " +
            "Date.now(), Math.random(), and new Date() are unavailable (breaks resume)."
        );
    }
    return undefined;
}

// ─── Caching ────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 cache key from (prompt, opts).
 */
export function computeAgentKey(
    prompt: string,
    opts?: Record<string, unknown>
): string {
    const hash = createHash("sha256")
        .update(prompt)
        .update("\x00")
        .update(JSON.stringify(opts ?? {}))
        .digest("hex");
    return `agent:${hash.slice(0, 24)}`;
}

/**
 * Look up a cached result by key.
 */
export function getCachedResult(
    run: WorkflowRun,
    key: string
): WorkflowAgentResult | undefined {
    return run.cachedResults.find((r) => r.key === key);
}

// ─── Agent execution ────────────────────────────────────────────────

/**
 * Resolve how to re-invoke the currently-running pi for a sub-agent process.
 * Ported from pi's official subagent example
 * (packages/coding-agent/examples/extensions/subagent/index.ts): re-invoke the
 * same entry point that is running us rather than relying on `pi` being on
 * `$PATH`, so spawns work in worktrees, CI, and `pnpm exec` contexts. Exposed
 * for unit testing; the `existsSync` check is injectable via `exists`.
 */
export function getPiInvocation(
    args: string[],
    fields: {
        argv1: string | undefined;
        execPath: string;
        platform: string;
    },
    exists: (p: string) => boolean = existsSync
): { command: string; args: string[] } {
    const { argv1, execPath } = fields;
    const isBunVirtualScript = argv1?.startsWith("/$bunfs/root/");
    if (argv1 && !isBunVirtualScript && exists(argv1)) {
        return { command: execPath, args: [argv1, ...args] };
    }

    const execName = (execPath.split("/").pop() ?? execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: execPath, args };
    }

    return { command: "pi", args };
}

// Char 27 = ESC, char 7 = BEL. Built from char codes so no-control-regex
// has nothing to flag.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_RE = new RegExp(ESC + "][^" + BEL + "]*" + BEL, "g");
const CSI_RE = new RegExp(ESC + "\\[" + "[\\d;]*[A-Za-z]", "g");

/** Strip terminal escape sequences (OSC/CSI) that pi may emit inline. */
export function stripEscapes(text: string): string {
    return text.replace(OSC_RE, "").replace(CSI_RE, "");
}

type AgentMessage = {
    role?: string;
    content?: Array<{ text?: string }>;
};
type AgentEvent = {
    type?: string;
    messages?: AgentMessage[];
    assistantMessageEvent?: { type?: string; delta?: string };
};

/** Type guard for a parsed `pi -p --mode json` event object. */
function isAgentEvent(value: unknown): value is AgentEvent {
    return typeof value === "object" && value !== null;
}

/**
 * Extract the assistant's reply text from a `pi -p --mode json` event stream.
 * Prefers the final assistant message on the `agent_end` event; falls back to
 * concatenating `text_delta` events in order. Returns "" if nothing parseable
 * is found.
 */
export function extractAgentText(jsonStream: string): string {
    const cleaned = stripEscapes(jsonStream).trim();
    if (!cleaned) return "";

    let lastAssistant: string | undefined;
    const deltas: string[] = [];

    for (const rawLine of cleaned.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isAgentEvent(parsed)) continue;
        const evt = parsed;
        if (evt.type === "agent_end" && Array.isArray(evt.messages)) {
            for (let i = evt.messages.length - 1; i >= 0; i--) {
                const msg = evt.messages[i];
                if (msg.role === "assistant" && Array.isArray(msg.content)) {
                    lastAssistant = msg.content
                        .map((c) => c.text ?? "")
                        .join("");
                    break;
                }
            }
        }
        if (
            evt.type === "message_update" &&
            evt.assistantMessageEvent?.type === "text_delta" &&
            typeof evt.assistantMessageEvent.delta === "string"
        ) {
            deltas.push(evt.assistantMessageEvent.delta);
        }
    }

    return lastAssistant ?? deltas.join("");
}

/**
 * Spawn a `pi -p` subprocess to execute an agent call.
 *
 * Uses `--mode json` (not `--mode text`, which hangs on some pi builds) and
 * parses the assistant reply out of the JSON event stream. Bounded by a
 * per-agent timeout so a single stuck subprocess can never block the whole
 * workflow; aborts and timeouts both SIGTERM the detached process group.
 */
export async function executeAgent(
    prompt: string,
    opts: Record<string, unknown> | undefined,
    cwd: string,
    model?: string,
    signal?: AbortSignal,
    timeoutMs: number = AGENT_TIMEOUT_MS
): Promise<string> {
    const id = randomBytes(8).toString("hex");
    const promptFile = join(tmpdir(), `pi-wf-agent-${id}.md`);
    const logFile = join(tmpdir(), `pi-wf-agent-${id}.log`);

    writeFileSync(promptFile, prompt);

    const modelArg = model ? ["--model", model] : [];
    // `--no-session`: workflow agents are ephemeral; do not persist a throwaway
    // session JSONL per agent() call. Matches pi's official subagent example.
    const spawnArgs = [
        "-p",
        "--mode",
        "json",
        "--no-session",
        ...modelArg,
        `@${promptFile}`,
    ];

    const cleanup = () => {
        try {
            unlinkSync(promptFile);
        } catch {
            /* already gone */
        }
        try {
            unlinkSync(logFile);
        } catch {
            /* already gone */
        }
    };

    return new Promise((resolve, reject) => {
        const invocation = getPiInvocation(spawnArgs, {
            argv1: process.argv[1],
            execPath: process.execPath,
            platform: process.platform,
        });
        const proc = spawn(invocation.command, invocation.args, {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const logStream = createWriteStream(logFile, { flags: "w" });
        let output = "";
        let settled = false;

        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            logStream.end();
            try {
                if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
            } catch {
                /* already dead */
            }
            cleanup();
            action();
        };

        proc.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            logStream.write(chunk);
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
            logStream.write(chunk);
        });

        proc.on("close", (code) => {
            if (code === 0 || code === null) {
                const text = extractAgentText(output);
                finish(() =>
                    resolve(
                        text.length > 0 ? text : stripEscapes(output).trim()
                    )
                );
            } else {
                finish(() =>
                    reject(
                        new Error(
                            `Agent exited with code ${code}: ${output.slice(0, 500)}`
                        )
                    )
                );
            }
        });

        proc.on("error", (err) => {
            finish(() => reject(err));
        });

        // Per-agent timeout: SIGTERM the group and reject loudly.
        const timer = setTimeout(() => {
            finish(() =>
                reject(
                    new Error(
                        `Agent timed out after ${Math.round(timeoutMs / 1000)}s`
                    )
                )
            );
        }, timeoutMs);
        timer.unref();

        // Abort (user `/workflow stop`): same kill path.
        if (signal) {
            const onAbort = () => {
                finish(() => reject(new Error("Agent aborted")));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            proc.on("close", () => {
                signal.removeEventListener("abort", onAbort);
                clearTimeout(timer);
            });
        } else {
            proc.on("close", () => clearTimeout(timer));
        }
    });
}

// ─── VM sandbox ─────────────────────────────────────────────────────

/**
 * Execute a workflow script in a VM sandbox.
 *
 * Returns the final output text (last agent result) or throws on error.
 * The `onProgress` callback receives status updates as agents execute.
 */
export async function executeWorkflowScript(
    scriptBody: string,
    run: WorkflowRun,
    cwd: string,
    abortController: AbortController,
    model?: string,
    onProgress?: (event: WorkflowProgressEvent) => void
): Promise<{ result: string; cachedResults: WorkflowAgentResult[] }> {
    const cachedResults = [...run.cachedResults];
    let agentCount = 0;
    // Tracks the script's global phase() so agent progress events can report
    // which phase they belong to (Claude Code scripts call phase() at top level).
    let currentPhase: string | undefined;

    // Create the agent() global function
    const agentFn = async (
        prompt: string,
        opts?: Record<string, unknown>
    ): Promise<string> => {
        const key = computeAgentKey(prompt, opts);
        // Honour the agent() opts that Claude Code scripts rely on:
        //   model  — per-agent model tier override (e.g. "sonnet"),
        //            falling back to the run/session model.
        //   label  — display label for progress events.
        //   phase  — progress group for this agent; opts.phase overrides
        //            the script's global phase() for this call.
        const label = typeof opts?.label === "string" ? opts.label : undefined;
        const phaseForEvent =
            typeof opts?.phase === "string" ? opts.phase : currentPhase;
        const agentModel = typeof opts?.model === "string" ? opts.model : model;

        // Check cache first
        const cached = cachedResults.find((r) => r.key === key);
        if (cached) {
            onProgress?.({
                type: "cache_hit",
                agentIndex: agentCount,
                key,
                prompt: prompt.slice(0, 80),
                label,
                phase: phaseForEvent,
            });
            return cached.result;
        }

        // Execute agent
        agentCount++;
        const agentIndex = agentCount;
        onProgress?.({
            type: "agent_start",
            agentIndex,
            key,
            prompt: prompt.slice(0, 80),
            label,
            phase: phaseForEvent,
        });

        try {
            const result = await executeAgent(
                prompt,
                opts,
                cwd,
                agentModel,
                abortController.signal
            );

            // Cache the result
            const entry: WorkflowAgentResult = {
                key,
                prompt,
                opts,
                result,
                completedAt: Date.now(),
            };
            cachedResults.push(entry);

            onProgress?.({
                type: "agent_done",
                agentIndex,
                key,
                prompt: prompt.slice(0, 80),
                resultLength: result.length,
                label,
                phase: phaseForEvent,
            });

            return result;
        } catch (err) {
            onProgress?.({
                type: "agent_error",
                agentIndex,
                key,
                prompt: prompt.slice(0, 80),
                error: err instanceof Error ? err.message : String(err),
                label,
                phase: phaseForEvent,
            });
            throw err;
        }
    };

    // Create the parallel() global function
    const parallelFn = async <T>(
        fns: Array<() => Promise<T>>
    ): Promise<T[]> => {
        if (!Array.isArray(fns)) {
            throw new Error("parallel() expects an array of functions");
        }
        return Promise.all(fns.map((fn) => fn()));
    };

    // Create the pipeline() global function
    const pipelineFn = async (
        fns: Array<(input: unknown) => Promise<unknown>>
    ): Promise<unknown> => {
        if (!Array.isArray(fns)) {
            throw new Error("pipeline() expects an array of functions");
        }
        let value: unknown;
        for (const fn of fns) {
            value = await fn(value);
        }
        return value;
    };

    // Build the VM context with global functions
    const sandbox = {
        agent: agentFn,
        parallel: parallelFn,
        pipeline: pipelineFn,
        args: run.args,
        // phase() and log() are optional-extension globals in the spec, but
        // Claude Code scripts call them directly (no typeof-adapter), so the
        // sandbox must provide them or the script throws ReferenceError.
        phase: (title: string) => {
            if (typeof title === "string") currentPhase = title;
        },
        log: (...args: unknown[]) => {
            onProgress?.({
                type: "log",
                agentIndex: -1,
                message: args
                    .map((a) =>
                        typeof a === "string" ? a : JSON.stringify(a, null, 2)
                    )
                    .join(" "),
            });
        },
        console: {
            log: (...args: unknown[]) => {
                onProgress?.({
                    type: "log",
                    agentIndex: -1,
                    message: args
                        .map((a) =>
                            typeof a === "string"
                                ? a
                                : JSON.stringify(a, null, 2)
                        )
                        .join(" "),
                });
            },
        },
        // Block non-deterministic and dangerous globals.
        // Setting undefined doesn't prevent access — the VM falls through
        // to the real global. Instead, provide functions that throw.
        setTimeout: () => {
            throw new Error("setTimeout is unavailable in workflow scripts");
        },
        setInterval: () => {
            throw new Error("setInterval is unavailable in workflow scripts");
        },
        setImmediate: () => {
            throw new Error("setImmediate is unavailable in workflow scripts");
        },
        Date: class {
            constructor() {
                throw new Error(
                    "Date is unavailable in workflow scripts (breaks resume)"
                );
            }
            static now() {
                throw new Error(
                    "Date.now() is unavailable in workflow scripts (breaks resume)"
                );
            }
        },
        Math: new Proxy(Math, {
            get(target, prop) {
                if (prop === "random") {
                    throw new Error(
                        "Math.random() is unavailable in workflow scripts (breaks resume)"
                    );
                }
                return target[prop as keyof Math];
            },
        }),
        process: undefined,
        require: undefined,
        globalThis: undefined,
    };

    const vmContext = createContext(sandbox);

    // Wrap the script body in an async IIFE so top-level await works
    const wrappedScript = `(async () => {\n${scriptBody}\n})()`;

    try {
        const script = new Script(wrappedScript);
        // runInContext returns unknown; narrow to string
        const rawResult: unknown = await script.runInContext(vmContext, {
            timeout: 30 * 60 * 1000, // 30 minute timeout
        });

        const result =
            typeof rawResult === "string"
                ? rawResult
                : JSON.stringify(rawResult);

        return {
            result,
            cachedResults,
        };
    } catch (err) {
        throw new Error(
            `Workflow script error: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
        );
    }
}

// ─── Progress events ────────────────────────────────────────────────

export type WorkflowProgressEvent =
    | {
          type: "agent_start";
          agentIndex: number;
          key: string;
          prompt: string;
          label?: string;
          phase?: string;
      }
    | {
          type: "agent_done";
          agentIndex: number;
          key: string;
          prompt: string;
          resultLength: number;
          label?: string;
          phase?: string;
      }
    | {
          type: "agent_error";
          agentIndex: number;
          key: string;
          prompt: string;
          error: string;
          label?: string;
          phase?: string;
      }
    | {
          type: "cache_hit";
          agentIndex: number;
          key: string;
          prompt: string;
          label?: string;
          phase?: string;
      }
    | {
          type: "log";
          agentIndex: number;
          message: string;
      };

// ─── Script body extraction ─────────────────────────────────────────

/**
 * Extract the script body (everything after the meta block).
 * Strips the `export const meta = ...` declaration, then removes any
 * remaining ESM `export` / `import` keywords so the body is valid in the
 * CommonJS-style `vm.Script` context it runs in (where `export` is a hard
 * syntax error). Spec-compliant scripts have no such keywords in the body;
 * this is a robustness measure for non-compliant scripts and surfaces the
 * real error instead of an opaque "Unexpected token 'export'".
 */
export function extractScriptBody(script: string): string {
    return (
        script
            // Drop the meta literal (parsed separately by parseMeta).
            .replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\s*\n?/, "")
            // `export default <expr>` -> `<expr>`
            .replace(/^\s*export\s+default\s+/gms, "")
            // `export <decl>` -> `<decl>`
            .replace(/^\s*export\s+/gms, "")
            // `import ... from "...";` and bare `import "...";` (line-oriented)
            .replace(
                /^\s*import\s(?:[^;\n]*?\S)?\s*(?:from\s*["'][^"']*["'])?\s*;?\s*$/gms,
                ""
            )
            .trim()
    );
}

// ─── Workflow resolution ────────────────────────────────────────────

/**
 * Resolve a workflow script by name.
 * Checks (in order):
 * 1. <cwd>/.claude/workflows/<name>.js
 * 2. <cwd>/.claude/workflows/<name>.mjs
 */
export function resolveWorkflow(name: string, cwd: string): string | undefined {
    const dir = resolve(cwd, WORKFLOW_DIR);
    for (const ext of [".js", ".mjs"]) {
        const filePath = join(dir, `${name}${ext}`);
        try {
            return readFileSync(filePath, "utf8");
        } catch {
            /* not found */
        }
    }
    return undefined;
}

/**
 * List available workflow names from <cwd>/.claude/workflows/.
 */
export function listWorkflows(cwd: string): string[] {
    const dir = resolve(cwd, WORKFLOW_DIR);
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.endsWith(".js") || e.endsWith(".mjs"))
        .map((e) => e.replace(/\.(js|mjs)$/, ""))
        .sort();
}

// ─── Status helpers ─────────────────────────────────────────────────

function updateWorkflowStatus(state: TauState, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const run = state.activeWorkflow;
    if (!run || run.status !== "running") {
        ctx.ui.setStatus("tau-workflow", undefined);
        return;
    }

    const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    const cacheCount = run.cachedResults.length;

    ctx.ui.setStatus(
        "tau-workflow",
        ctx.ui.theme.fg(
            "accent",
            `⊛ wf:${run.name} · ${timeStr} · ${cacheCount} cached`
        )
    );
}

// ─── Feature registration ───────────────────────────────────────────

export function registerWorkflow(pi: ExtensionAPI, state: TauState): void {
    // Restore workflow from session entries on startup
    pi.on("session_start", async (_event, ctx) => {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "custom" &&
                entry.customType === "tau-workflow-state"
            ) {
                const data = entry.data as Record<string, unknown> | undefined;
                if (
                    data &&
                    typeof data.runId === "string" &&
                    data.status === "running"
                ) {
                    const run = data as unknown as WorkflowRun;
                    // Mark as killed — we can't resume mid-execution
                    data.status = "killed";
                    state.activeWorkflow = run;
                    ctx.ui.notify(
                        `Workflow "${run.name}" was running when session ended — marked as killed. Use /workflow run --file ${run.scriptPath ?? ""} to rerun.`,
                        "warning"
                    );
                }
                break;
            }
        }
        updateWorkflowStatus(state, ctx);
    });

    // ── /workflow command ──────────────────────────────────────────

    pi.registerCommand("workflow", {
        description:
            "Orchestrate multi-agent workflows. Usage: /workflow run <name>, /workflow run --file <path>, /workflow run --inline <script>, /workflow list, /workflow status, /workflow stop",
        handler: async (args, ctx: ExtensionCommandContext) => {
            if (!isFeatureEnabled(state, "workflow")) {
                ctx.ui.notify(
                    "Workflow is disabled — run /tau to enable",
                    "info"
                );
                return;
            }

            const trimmed = (args ?? "").trim();
            const tokens = trimmed.split(/\s+/);
            const subcommand = tokens[0]?.toLowerCase();

            if (subcommand === "list") {
                const workflows = listWorkflows(ctx.cwd);
                if (workflows.length === 0) {
                    ctx.ui.notify(
                        "No workflows found in .claude/workflows/",
                        "info"
                    );
                } else {
                    const lines = workflows.map((w, i) => `  ${i + 1}. ${w}`);
                    ctx.ui.notify(
                        `Available workflows:\n${lines.join("\n")}`,
                        "info"
                    );
                }
                return;
            }

            if (subcommand === "status") {
                const run = state.activeWorkflow;
                if (!run) {
                    ctx.ui.notify("No active workflow.", "info");
                    return;
                }

                const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const statusEmoji =
                    run.status === "running"
                        ? "⊛"
                        : run.status === "completed"
                          ? "✓"
                          : run.status === "failed"
                            ? "✗"
                            : "⊘";
                ctx.ui.notify(
                    `${statusEmoji} Workflow "${run.name}" — ${run.status}\n` +
                        `  Run ID: ${run.runId}\n` +
                        `  Elapsed: ${mins}m ${secs}s\n` +
                        `  Cached results: ${run.cachedResults.length}\n` +
                        (run.error ? `  Error: ${run.error}\n` : "") +
                        (run.scriptPath ? `  Script: ${run.scriptPath}\n` : ""),
                    "info"
                );
                return;
            }

            if (subcommand === "stop") {
                const run = state.activeWorkflow;
                if (!run || run.status !== "running") {
                    ctx.ui.notify("No active workflow to stop.", "info");
                    return;
                }
                // Abort any in-flight agent subprocess immediately. This runs
                // synchronously on the command thread; it does NOT await the
                // hung run (which is what made stop unresponsive before).
                const controller = runAbortControllers.get(run.runId);
                if (controller) controller.abort();
                run.status = "killed";
                run.completedAt = Date.now();
                pi.appendEntry("tau-workflow-state", run);
                updateWorkflowStatus(state, ctx);
                ctx.ui.notify(`Workflow "${run.name}" stopped.`, "warning");
                return;
            }

            if (subcommand === "run") {
                const rest = tokens.slice(1).join(" ");

                // Check for flags
                if (rest.startsWith("--file ")) {
                    const filePath = rest.slice(7).trim();
                    runWorkflowFromFile(pi, state, ctx, filePath, undefined);
                    return;
                }

                if (rest.startsWith("--inline ")) {
                    const inlineScript = rest.slice(9).trim();
                    runWorkflowInline(pi, state, ctx, inlineScript, undefined);
                    return;
                }

                // Default: run by name
                const name = rest.trim();
                if (!name) {
                    ctx.ui.notify(
                        "Usage: /workflow run <name> | --file <path> | --inline <script>",
                        "info"
                    );
                    return;
                }
                runWorkflowByName(pi, state, ctx, name, undefined);
                return;
            }

            // No subcommand — show help
            ctx.ui.notify(
                "Usage:\n" +
                    "  /workflow run <name>        — run a named workflow\n" +
                    "  /workflow run --file <path> — run from a file\n" +
                    "  /workflow run --inline <js> — run inline script\n" +
                    "  /workflow list              — list available workflows\n" +
                    "  /workflow status            — show current run\n" +
                    "  /workflow stop              — stop running workflow",
                "info"
            );
        },
    });

    // ── workflow tool ──────────────────────────────────────────────

    pi.registerTool({
        name: "workflow",
        label: "Workflow",
        description:
            "Orchestrate multi-agent tasks via deterministic JavaScript workflow scripts. " +
            "Scripts use agent() to spawn subagents, parallel() for concurrency, pipeline() for sequential chaining. " +
            "Scripts must begin with `export const meta = { name, description }`.",
        promptSnippet:
            "Orchestrate multi-agent tasks with deterministic JS workflow scripts",
        promptGuidelines: [
            "Use workflow for complex multi-step tasks that benefit from parallel agent execution.",
            "Workflow scripts are deterministic JavaScript — no Date.now/Math.random/new Date.",
            "Agent results are cached by (prompt, opts) so only changed agents re-run on resume.",
        ],
        parameters: Type.Object({
            name: Type.Optional(
                Type.String({
                    description: "Name of a predefined workflow to run.",
                })
            ),
            script: Type.Optional(
                Type.String({
                    description:
                        "Inline workflow script. Must begin with `export const meta = { name, description }`.",
                })
            ),
            scriptPath: Type.Optional(
                Type.String({
                    description: "Path to a workflow script file.",
                })
            ),
            args: Type.Optional(
                Type.Unknown({
                    description:
                        "Arguments exposed as `args` global in the script. Pass arrays/objects as actual values, not JSON strings.",
                })
            ),
            resumeFromRunId: Type.Optional(
                Type.String({
                    description:
                        "Run ID of a prior workflow to resume. Cached results are reused for unchanged agent calls.",
                })
            ),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            if (!isFeatureEnabled(state, "workflow")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Workflow is disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }

            // Resolve script source
            let script: string | undefined;
            let scriptPath: string | undefined;

            if (params.scriptPath) {
                try {
                    script = readFileSync(params.scriptPath, "utf8");
                    scriptPath = params.scriptPath;
                } catch {
                    throw new Error(
                        `Cannot read script file: ${params.scriptPath}`
                    );
                }
            } else if (params.name) {
                script = resolveWorkflow(params.name, ctx.cwd);
                if (!script) {
                    throw new Error(
                        `Workflow "${params.name}" not found in .claude/workflows/`
                    );
                }
            } else if (params.script) {
                script = params.script;
            } else {
                throw new Error(
                    "Must provide one of: name, script, or scriptPath"
                );
            }

            const result = await executeRun(
                pi,
                state,
                ctx,
                script,
                scriptPath,
                params.args,
                params.resumeFromRunId
            );

            return {
                content: [{ type: "text" as const, text: result.summary }],
                details: result.details,
            };
        },
    });

    // ── Run helpers ────────────────────────────────────────────────

    async function executeRun(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionContext,
        script: string,
        scriptPath: string | undefined,
        args: unknown,
        resumeFromRunId?: string
    ): Promise<{ summary: string; details: Record<string, unknown> }> {
        // Check for already running workflow
        if (state.activeWorkflow?.status === "running") {
            throw new Error(
                `Workflow "${state.activeWorkflow.name}" is already running. Stop it first with /workflow stop.`
            );
        }

        // Parse meta
        const meta = parseMeta(script);

        // Check determinism
        const body = extractScriptBody(script);
        const determinismError = checkDeterminism(body);
        if (determinismError) {
            throw new Error(determinismError);
        }

        // Resume: load cached results from prior run
        let cachedResults: WorkflowAgentResult[] = [];
        if (resumeFromRunId) {
            const priorRun = loadPriorRun(
                ctx.sessionManager.getEntries(),
                resumeFromRunId
            );
            if (!priorRun) {
                throw new Error(
                    `No prior run found with ID ${resumeFromRunId}`
                );
            }
            if (priorRun.status === "running") {
                throw new Error("Prior run is still running. Stop it first.");
            }
            cachedResults = priorRun.cachedResults;
        }

        // Generate run ID
        const runId = `wf_${randomBytes(6).toString("hex")}`;

        // Persist script to session directory if not already on disk
        const sessionDir = ctx.sessionManager
            .getSessionFile()
            ?.replace(/\.jsonl$/, "");
        if (!scriptPath && sessionDir) {
            const wfDir = join(sessionDir, SESSION_WORKFLOW_DIR, meta.name);
            mkdirSync(wfDir, { recursive: true });
            scriptPath = join(wfDir, `${runId}.js`);
            writeFileSync(scriptPath, script);
        }

        // Create run state
        const run: WorkflowRun = {
            runId,
            name: meta.name,
            script,
            scriptPath,
            args,
            status: "running",
            startedAt: Date.now(),
            cachedResults,
        };

        state.activeWorkflow = run;
        pi.appendEntry("tau-workflow-state", run);
        updateWorkflowStatus(state, ctx);

        // Abort controller lives outside the run object so the non-serialisable
        // controller is never persisted; `/workflow stop` looks it up by runId.
        const abortController = new AbortController();
        runAbortControllers.set(runId, abortController);

        const model = ctx.model;
        const modelId = model ? `${model.provider}/${model.id}` : undefined;

        try {
            const { result, cachedResults } = await executeWorkflowScript(
                body,
                run,
                ctx.cwd,
                abortController,
                modelId,
                () => {
                    // Refresh status bar on every progress event.
                    // The cached results are written to run.cachedResults
                    // after executeWorkflowScript returns.
                    updateWorkflowStatus(state, ctx);
                }
            );

            // Mark completed
            run.status = "completed";
            run.completedAt = Date.now();
            run.cachedResults = cachedResults;

            pi.appendEntry("tau-workflow-state", run);
            state.activeWorkflow = run;
            updateWorkflowStatus(state, ctx);

            const summary =
                `Workflow "${meta.name}" completed (run ${runId}). ` +
                `${cachedResults.length} agent results cached. ` +
                (scriptPath
                    ? `Script: ${scriptPath}. To resume: /workflow run --file ${scriptPath}`
                    : "");

            return {
                summary,
                details: {
                    runId,
                    name: meta.name,
                    status: "completed",
                    agentCount: cachedResults.length,
                    resultPreview: result.slice(0, 500),
                    scriptPath,
                },
            };
        } catch (err) {
            // If `/workflow stop` already marked this run killed, honour that
            // instead of clobbering it with a failed/aborted error.
            if (run.status !== "killed") {
                run.status = "failed";
                run.completedAt = Date.now();
                run.error = err instanceof Error ? err.message : String(err);
            }

            pi.appendEntry("tau-workflow-state", run);
            state.activeWorkflow = run;
            updateWorkflowStatus(state, ctx);

            // A killed run is an expected stop, not an error to surface.
            if (run.status === "killed")
                return {
                    summary: `Workflow "${meta.name}" stopped.`,
                    details: { runId, name: meta.name, status: "killed" },
                };

            throw err;
        } finally {
            runAbortControllers.delete(runId);
        }
    }

    /**
     * Launch a workflow in the background WITHOUT awaiting it, so the command
     * thread stays free to process `/workflow stop` mid-run. Completion and
     * failure are reported via notify from the detached promise. This mirrors
     * how the `workflow` tool's own execute path differs: the tool awaits
     * (the model wants the result), the slash command does not.
     */
    function launchWorkflowBackground(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        script: string,
        scriptPath: string | undefined,
        args: unknown
    ): void {
        let metaName = "workflow";
        try {
            metaName = parseMeta(script).name;
        } catch {
            // parseMeta will throw again inside executeRun with a clear error.
        }
        ctx.ui.notify(`Workflow "${metaName}" started.`, "info");
        void executeRun(pi, state, ctx, script, scriptPath, args)
            .then((result) => {
                // A killed run is already announced by `/workflow stop`; don't
                // emit a redundant completion notify.
                if (result.details?.status !== "killed") {
                    ctx.ui.notify(result.summary, "info");
                }
            })
            .catch((err: unknown) =>
                ctx.ui.notify(
                    `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
                    "error"
                )
            );
    }

    function runWorkflowByName(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        name: string,
        args: unknown
    ): void {
        const script = resolveWorkflow(name, ctx.cwd);
        if (!script) {
            ctx.ui.notify(
                `Workflow "${name}" not found in .claude/workflows/`,
                "error"
            );
            return;
        }
        launchWorkflowBackground(pi, state, ctx, script, undefined, args);
    }

    function runWorkflowFromFile(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        filePath: string,
        args: unknown
    ): void {
        let script: string;
        try {
            script = readFileSync(filePath, "utf8");
        } catch {
            ctx.ui.notify(`Cannot read script file: ${filePath}`, "error");
            return;
        }
        launchWorkflowBackground(pi, state, ctx, script, filePath, args);
    }

    function runWorkflowInline(
        pi: ExtensionAPI,
        state: TauState,
        ctx: ExtensionCommandContext,
        script: string,
        args: unknown
    ): void {
        launchWorkflowBackground(pi, state, ctx, script, undefined, args);
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function loadPriorRun(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    runId: string
): WorkflowRun | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (
            entry.type === "custom" &&
            entry.customType === "tau-workflow-state"
        ) {
            const run = entry.data as WorkflowRun | undefined;
            if (run?.runId === runId) return run;
        }
    }
    return undefined;
}
