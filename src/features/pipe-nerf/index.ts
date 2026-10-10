/**
 * Pipe nerf replaces output-limiting shell pipes with pi's own capture.
 *
 * Core bash already truncates to the last 2000 lines / 50KB inline, writes
 * everything it drops to a temp file, and pi-tau indexes large output into the
 * context sidecar so it can be read back with `context_search` / `context_get`.
 * A pipe inside the command happens before all of that: the discarded text
 * never reaches the tool, so it is never written out, never indexed, and cannot
 * be recovered at any price.
 *
 * Measured over 30 days (3,245 session files, 808k bash calls), 57.32% of bash
 * calls end in a limiting pipe; 99.53% of those limits are below the budget the
 * tool already applies; 29.86% merge stderr first; and 54.31% of `bash_bg`
 * calls pipe, which cuts the only record a background job has.
 *
 * This hook removes the limiter, lets the tool's own capture apply, and tells
 * the agent exactly what changed, where the rest of the output is, and which
 * tool to reach for. It leaves filters and transforms alone — see
 * `parse.ts` for why that distinction is the whole safety argument.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../../state.ts";
import { isFeatureEnabled } from "../features-helpers.ts";
import { countLines } from "../log-classify.ts";
import { bashGuidelines, pipeNote } from "./messages.ts";
import { applyLimiter, planPipeNerf } from "./parse.ts";
import type { LimiterView, PipeInvocation } from "./parse.ts";
import type { PipePlan } from "./parse.ts";

export {
    BUILTIN_MAX_BYTES,
    BUILTIN_MAX_LINES,
    applyLimiter,
    findPipeInvocation,
    lastPipeOperator,
    planPipeNerf,
} from "./parse.ts";
export type {
    LimiterView,
    PipeInvocation,
    PipePlan,
    PipeOptions,
    SkipReason,
} from "./parse.ts";
export { bashGuidelines, pipeNote } from "./messages.ts";
export type { PipeObservation } from "./messages.ts";

/**
 * `registerToolPromptGuidelines` was added to pi after 0.74.0 — the version
 * pi-tau's lock file resolves for local type-checking. The peer dependency is
 * `*`, so the host supplies pi and the runtime is newer. Declare the surface
 * narrowly and feature-detect it so the extension keeps both capabilities on a
 * current host and stays loadable, rather than throwing at registration.
 */
type PiWithOptionalGuidelines = ExtensionAPI & {
    registerToolPromptGuidelines?: (
        toolName: string,
        guidelines: string[]
    ) => void;
};

/** The tools this hook rewrites. `bash_bg` is included deliberately. */
const HOOKED_TOOLS = new Set(["bash", "bash_bg"]);

interface BashInput {
    command?: string;
    cwd?: string;
}

/**
 * Core's bash details, plus the extra fields pi-tau's own background path adds.
 * Only the fields this hook reads are declared.
 */
interface BashResultDetails {
    truncation?: {
        truncated?: boolean;
        totalLines?: number;
        outputLines?: number;
    };
    fullOutputPath?: string;
    sourceId?: string;
    chunkIds?: string[];
}

/** Count lines of a result's visible text, for the note's err/warn line. */
function visibleSeverity(
    text: string
): { err: number; warn: number; lines: number } {
    const counts = countLines(text);
    return { err: counts.err, warn: counts.warn, lines: counts.total };
}

/**
 * The retrieval lines for a sidecar source, in the same wording as
 * `sidecar.formatSidecarReceipt`, so the agent sees one consistent vocabulary.
 */
function retrievalLines(details: BashResultDetails): string[] {
    const sourceId = details.sourceId;
    if (!sourceId) return [];
    const firstChunk = details.chunkIds?.[0] ?? "";
    return [
        `- Search it first: context_search query:"..." source_id:${JSON.stringify(sourceId)}`,
        `- Read a range: context_get source_id:${JSON.stringify(sourceId)} chunk_id:${JSON.stringify(firstChunk)}`,
        `- Export it whole: context_export source_id:${JSON.stringify(sourceId)}`,
    ];
}

/**
 * Describe the view the agent is now looking at, in their own terms.
 *
 * The note has to be unambiguous here: "the whole output is captured" next to an
 * unbounded block of it reads as if the capture were still filtered, and the
 * agent then either re-runs for the rest or believes it already saw everything.
 */
function describeView(invocation: PipeInvocation, view: LimiterView): string {
    if (!view.faithful) {
        return `the full captured output (your ${invocation.kind} view could not be reproduced from it)`;
    }
    const limit = invocation.limit;
    switch (invocation.kind) {
        case "tail":
            return `the last ${limit ?? 10} lines, as your pipe would have printed`;
        case "head":
            return `the first ${limit ?? 10} lines, as your pipe would have printed`;
        case "wc":
            return "the line count your pipe would have printed";
        case "grep":
        case "rg":
            return "the match count your pipe would have printed";
        case "sed":
            return `the first ${limit ?? "few"} lines your pipe would have selected`;
        default:
            return "the bounded view your pipe would have printed";
    }
}

/**
 * Register the pipe rewrite and its explicit agent-facing explanation.
 *
 * `state` is tau's feature state. It is optional so the feature stays loadable
 * on its own (`pi -e src/features/pipe-nerf/index.ts`, which the end-to-end
 * check relies on): with no state there is nothing to toggle, so the hook stays
 * on.
 */
export function registerPipeNerf(pi: ExtensionAPI, state?: TauState): void {
    const pending = new Map<string, PipePlan>();

    const api = pi as PiWithOptionalGuidelines;
    if (typeof api.registerToolPromptGuidelines === "function") {
        // One call for both tools: the guidance is about output capture, which
        // is the same rule whichever shell ran the command.
        api.registerToolPromptGuidelines("bash", bashGuidelines());
    }

    pi.on("tool_call", (event) => {
        if (!HOOKED_TOOLS.has(event.toolName)) return;
        // Soft toggle. The registry entry is what makes `/tau set pipe-nerf
        // off` a valid id; this is what makes the setting change behaviour.
        if (state && !isFeatureEnabled(state, "pipe-nerf")) return;
        const input = event.input as BashInput;
        const command = input.command;
        if (typeof command !== "string" || !command.trim()) return;

        const plan = planPipeNerf(command);
        if (plan.action !== "rewrite") return;

        input.command = plan.rewritten;
        // A duplicate toolCallId cannot be attributed to either call, so drop the
        // entry rather than annotate one result with the other call's note,
        // which would be actively wrong. The host generates unique ids; count the
        // collision so this branch is observable rather than silent.
        if (pending.has(event.toolCallId)) {
            pending.delete(event.toolCallId);
            pi.appendEntry("pipe-nerf-collision", {
                toolCallId: event.toolCallId,
            });
        } else {
            pending.set(event.toolCallId, plan);
        }
        pi.appendEntry("pipe-nerf", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            original: plan.original,
            rewritten: plan.rewritten,
            filter: plan.invocation?.kind ?? null,
            limit: plan.invocation?.limit ?? null,
            mergedStderr: plan.invocation?.mergedStderr ?? false,
        });
    });

    pi.on("tool_result", (event) => {
        const plan = pending.get(event.toolCallId);
        if (!plan || plan.action !== "rewrite" || !plan.invocation) {
            pending.delete(event.toolCallId);
            return;
        }
        pending.delete(event.toolCallId);

        const details =
            (event as { details?: BashResultDetails }).details ?? {};
        const text = event.content
            .map((block) =>
                block.type === "text" ? (block.text ?? "") : ""
            )
            .join("\n");
        // The err/warn mix is computed over the WHOLE captured text, so it is
        // the stat the agent would otherwise re-run the command to get, even
        // though the view below is bounded to the lines they asked for.
        const severity = visibleSeverity(text);
        const truncation = details.truncation;
        const truncated = truncation?.truncated === true;

        const view = applyLimiter(text, plan.invocation, {
            truncated,
            totalLines: truncation?.totalLines ?? null,
        });

        const note = pipeNote(plan, {
            // Core computes `totalLines` before its own truncation, so it counts
            // lines that are not in the inline result. Falling back to the
            // visible count would understate the output on a large result, so it
            // is only a fallback when the tool reported no truncation detail.
            totalLines: truncation?.totalLines ?? null,
            err: severity.err,
            warn: severity.warn,
            visibleLines: severity.lines,
            fullOutputPath: details.fullOutputPath ?? null,
            sourceId: details.sourceId ?? null,
            receiptLines: retrievalLines(details),
            faithful: view.faithful,
            caveat: view.caveat,
            viewDescription: describeView(plan.invocation, view),
        });
        if (!note) return;

        // The bounded view replaces the raw capture, so the agent's context
        // stays what they asked for. A faithful view is exactly what their pipe
        // printed; an unfaithful one is the capture, with the note saying so.
        const body = view.faithful
            ? [{ type: "text" as const, text: view.text }]
            : [...event.content];
        return {
            content: [{ type: "text" as const, text: note }, ...body],
        };
    });

    pi.on("session_shutdown", () => {
        pending.clear();
    });
}

/**
 * Standalone entry point.
 *
 * pi-tau loads this feature through its own `src/index.ts`, so the default
 * export is not needed for normal operation. Exporting a factory as well keeps
 * the feature loadable on its own (`pi -e src/features/pipe-nerf/index.ts`),
 * which is how the end-to-end check proves a rewrite reaches a real tool call
 * rather than only a fake event object.
 */
export default function (pi: ExtensionAPI): void {
    registerPipeNerf(pi);
}