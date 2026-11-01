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
import { readFileSync } from "node:fs";
import type { TauState } from "../../state.ts";
import { isFeatureEnabled } from "../features-helpers.ts";
import { countLines } from "../log-classify.ts";
import { formatSidecarReceipt } from "../sidecar.ts";
import { bashGuidelines, pipeNoteSections } from "./messages.ts";
import { stageZeroDirectory, stageZeroPathFor } from "./stage0-path.ts";
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
export { bashGuidelines, pipeNote, pipeNoteSections } from "./messages.ts";
export type { PipeNoteSections } from "./messages.ts";
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
function visibleSeverity(text: string): {
    err: number;
    warn: number;
    lines: number;
} {
    const counts = countLines(text);
    return { err: counts.err, warn: counts.warn, lines: counts.total };
}

/**
 * The retrieval lines for a sidecar source, in the same wording as
 * `sidecar.formatSidecarReceipt`, so the agent sees one consistent vocabulary.
 */
export function stageZeroStatus(path: string | undefined): {
    truncated: boolean;
    bytesWritten: number;
    reason: "cap" | "epipe" | null;
    tail: { bytes: number; dropped: number } | null;
} | null {
    if (!path) return null;
    try {
        const parsed: unknown = JSON.parse(
            readFileSync(`${path}.status.json`, "utf8")
        );
        if (parsed === null || typeof parsed !== "object") return null;
        const status = parsed as {
            truncated?: unknown;
            bytesWritten?: unknown;
            reason?: unknown;
            tail?: unknown;
        };
        if (
            typeof status.truncated !== "boolean" ||
            !Number.isSafeInteger(status.bytesWritten) ||
            (status.bytesWritten as number) < 0 ||
            (status.reason !== null &&
                status.reason !== "cap" &&
                status.reason !== "epipe") ||
            (status.tail !== undefined &&
                status.tail !== null &&
                typeof status.tail !== "object")
        )
            return null;
        let tail: { bytes: number; dropped: number } | null = null;
        if (status.tail !== undefined && status.tail !== null) {
            const candidate = status.tail as { bytes?: unknown; dropped?: unknown };
            if (
                !Number.isSafeInteger(candidate.bytes) ||
                !Number.isSafeInteger(candidate.dropped) ||
                (candidate.bytes as number) < 0 ||
                (candidate.dropped as number) < 0
            )
                return null;
            tail = {
                bytes: candidate.bytes as number,
                dropped: candidate.dropped as number,
            };
        }
        return {
            truncated: status.truncated,
            bytesWritten: status.bytesWritten as number,
            reason: status.reason,
            tail,
        };
    } catch {
        return null;
    }
}

function pipelineExitLines(plan: PipePlan): string[] {
    if (!plan.stageExitPath || !plan.pipelineExitCommands) return [];
    let records: string[];
    try {
        records = readFileSync(plan.stageExitPath, "utf8").trim().split("\n");
    } catch {
        return [];
    }
    const lines: string[] = [];
    for (const record of records) {
        const [segmentText, codesText] = record.split("\t", 2);
        const segment = Number(segmentText);
        const codes = codesText?.split(/\s+/).map(Number);
        const commands = plan.pipelineExitCommands[segment - 1];
        if (
            !commands ||
            !codes?.length ||
            codes.some((code) => !Number.isInteger(code))
        )
            continue;
        const statuses = codes.map((code, index) => {
            const command = commands[index] ?? "unknown stage";
            const label = command.includes("stage0-capture.mjs")
                ? "pipe-hoist capture"
                : JSON.stringify(command.slice(0, 120));
            return `stage ${index + 1} ${label}=${code}`;
        });
        lines.push(
            `Pipeline exits (segment ${segment}): ${statuses.join(", ")}.`
        );
    }
    return lines;
}

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
function describeView(
    invocation: PipeInvocation,
    view: LimiterView,
    viewDescriptionOverride?: "receipt"
): string {
    if (!view.faithful) {
        return `the full captured output (your ${invocation.kind} view could not be reproduced from it)`;
    }
    if (viewDescriptionOverride === "receipt") {
        return "a summary of the captured output, with its totals and how to read the rest";
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

        // Stage 0's output is what a re-filter would want. It is only worth
        // writing when the command still filters AFTER the limiter is hoisted: if
        // the rewrite left a single command, its whole output is already the
        // capture. `planPipeNerf` decides that, so the path is offered rather
        // than prescribed.
        const captureDirectory = stageZeroDirectory();
        const stageZeroPath = stageZeroPathFor(
            event.toolCallId,
            captureDirectory
        );
        const plan = planPipeNerf(command, {
            stageZeroPath,
            stageZeroDirectory: captureDirectory,
        });
        if (plan.action !== "rewrite") {
            if (plan.reason === "capture-directory-reference") {
                pending.set(event.toolCallId, plan);
            }
            return;
        }

        input.command = plan.rewritten;
        if (plan.stageZeroSegments && plan.stageZeroSegments.length > 1) {
            pi.appendEntry("pipe-nerf-compound-stage0", {
                toolCallId: event.toolCallId,
                segmentCount: plan.stageZeroSegments.length,
                capturedPipelineCount: plan.stageZeroSegments.filter(
                    (segment) => segment.captured
                ).length,
            });
        }
        if (plan.stageZero) {
            // The bash tool owns output capture, and it is the only place with
            // the session context the sidecar needs. Record the path so it can
            // index this file alongside its own, and clear it once consumed.
            state?.pipeStageZeroCalls.set(event.toolCallId, {
                path: plan.stageZero.path,
                command: plan.stageZero.command,
                lineCount: null,
            });
        }
        // Link 1 of the retention invariant; the invariant itself, and every
        // other link in the chain, is documented on `SidecarIndexOptions.force`.
        // A hoisted limiter means the agent is shown a bounded view, so this
        // call's output must be indexed whatever its size. Deleting this line, or
        // making it conditional on the output size, loses the only copy for
        // exactly the small `pytest | tail -5` capture the nerf exists to protect.
        state?.pipeHoistedCalls.add(event.toolCallId);
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
            // Recorded so the habit and the stage-0 capture rate can be measured
            // together: how often does a rewrite leave a pipeline in place, which
            // is the only case where the pre-filter output is not the capture.
            stageZero: plan.stageZero
                ? {
                      path: plan.stageZero.path,
                      command: plan.stageZero.command,
                  }
                : null,
        });
    });

    pi.on("tool_result", (event) => {
        const plan = pending.get(event.toolCallId);
        if (!plan) {
            pending.delete(event.toolCallId);
            return;
        }
        pending.delete(event.toolCallId);
        if (plan.action !== "rewrite") {
            if (plan.reason !== "capture-directory-reference") return;
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `capture disabled: command references the capture directory (${plan.captureDirectory})`,
                    },
                    ...event.content,
                ],
            };
        }

        // The bash tool has prepared the result by now, so the flag has done its
        // job. Cleared on every path: a leak here would index unrelated calls.
        state?.pipeHoistedCalls.delete(event.toolCallId);

        const details =
            (event as { details?: BashResultDetails }).details ?? {};
        if (plan.preserveLimiterViews) {
            const capture = (
                details as {
                    pipeStageZero?: { path: string; sourceId: string | null };
                }
            ).pipeStageZero;
            const status = stageZeroStatus(capture?.path);
            const exitLines = pipelineExitLines(plan);
            const captureSegments = plan.stageZeroSegments
                ?.map(
                    (segment, index) =>
                        `(${index + 1}) ${JSON.stringify(segment.command)}${segment.captured ? " [stage-0 captured]" : " [not captured]"}${segment.separator ? ` [then ${segment.separator}]` : ""}`
                )
                .join("; ");
            const captureDescription = captureSegments
                ? ` Stage-0 contains the inputs for captured pipeline segments, concatenated in order; the call segments are: ${captureSegments}.`
                : "";
            const retrieval = capture?.sourceId
                ? ` Stage-0 is indexed as ${JSON.stringify(capture.sourceId)}${status?.truncated ? ` (capture truncated: reason ${status.reason ?? "cap"})` : ""}; inspect with context_search query:"pattern" source_id:${JSON.stringify(capture.sourceId)}, then context_get or context_export.`
                : capture?.path
                  ? ` Stage-0 file: ${capture.path}; inspect it with sed -n 'START,ENDp' or grep; it is subject to the stage-0 capture retention budget.`
                  : "";
            const truncated = status?.truncated
                ? status.tail
                    ? ` Stage-0 capture truncated: first ${(status.bytesWritten / (1024 * 1024)).toFixed(1)} MiB at ${capture?.path}, last ${(status.tail.bytes / (1024 * 1024)).toFixed(1)} MiB at ${capture?.path}.tail (sed/grep it — the end of the output is often the useful part); ${status.tail.dropped} bytes in between are unavailable.`
                    : ` Stage-0 capture truncated at ${(status.bytesWritten / (1024 * 1024)).toFixed(1)} MiB (reason ${status.reason ?? "cap"}); only this captured prefix is available.`
                : "";
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Effective command: ${JSON.stringify(plan.rewritten)}. Every shell limiter was preserved, so the output below is already the requested view.${captureDescription}${retrieval}${truncated}${exitLines.length ? ` ${exitLines.join(" ")}` : ""}`,
                    },
                    ...event.content,
                ],
            };
        }
        if (!plan.invocation) return;
        // Teed to by the rewrite when the command still filtered.
        const stageZero =
            (
                details as {
                    pipeStageZero?: {
                        path: string;
                        command: string;
                        sourceId: string | null;
                    };
                }
            ).pipeStageZero ?? null;
        const truncation = details.truncation;
        const captureStatus = stageZeroStatus(stageZero?.path);
        const text = event.content
            .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
            .join("\n");

        // Indexed output arrives as a RECEIPT, not as the output. Bounding a
        // receipt is meaningless, and the numbers in it are not the output's --
        // the case produced "Captured 7 lines" against a 60-line total, and then
        // a tail -3 of the receipt prose. When the tool already reduced the
        // content to a receipt, the receipt IS the bounded result: it carries the
        // source id, the byte/line totals, and the retrieval calls.
        const isReceipt = text.startsWith("[context-sidecar]");

        const view = isReceipt
            ? { text, faithful: true, caveat: null }
            : applyLimiter(text, plan.invocation, {
                  truncated: truncation?.truncated === true,
                  totalLines: truncation?.totalLines ?? null,
              });
        const viewLines =
            view.text.length === 0 ? 0 : view.text.split("\n").length;
        const viewExceedsInlineBudget =
            Buffer.byteLength(view.text, "utf8") > 50 * 1024 ||
            viewLines > 2_000;
        const showReceipt =
            isReceipt ||
            (view.faithful &&
                viewExceedsInlineBudget &&
                Boolean(details.sourceId));
        const receiptText =
            showReceipt && !isReceipt
                ? formatSidecarReceipt(
                      "bash",
                      {
                          sourceId: details.sourceId!,
                          chunkIds: details.chunkIds ?? [],
                      },
                      Buffer.byteLength(text, "utf8"),
                      truncation?.totalLines ?? text.split("\n").length
                  )
                : text;

        // The err/warn mix is computed over the WHOLE captured text, so it is the
        // stat the agent would otherwise re-run the command to get, even though
        // the view below is bounded to the lines they asked for. A receipt is not
        // the output, so classifying it would count the receipt's own words.
        const severity = isReceipt
            ? { err: 0, warn: 0, lines: text.split("\n").length }
            : visibleSeverity(text);

        const note = pipeNoteSections(plan, {
            // Core computes `totalLines` before its own truncation, so it counts
            // lines that are not in the inline result. Falling back to the
            // visible count would understate the output on a large result, so it
            // is only a fallback when the tool reported no truncation detail.
            totalLines: truncation?.totalLines ?? null,
            err: severity.err,
            warn: severity.warn,
            visibleLines: showReceipt ? null : severity.lines,
            fullOutputPath: details.fullOutputPath ?? null,
            sourceId: details.sourceId ?? null,
            receiptLines: retrievalLines(details),
            faithful: view.faithful,
            caveat: view.caveat,
            viewDescription: describeView(
                plan.invocation,
                view,
                showReceipt ? "receipt" : undefined
            ),
            pipeStageZero: stageZero,
            stageZeroStatus: captureStatus,
            pipelineExitLines: pipelineExitLines(plan),
        });
        if (!note.receipt && !note.notice) return;

        // The bounded view replaces the raw capture, so the agent's context
        // stays what they asked for. A faithful view is exactly what their pipe
        // printed; an unfaithful one keeps the capture itself, because a view
        // that could not be reconstructed must not be handed back as if it were
        // the answer. `faithful`/`caveat` reach the note as facts (see
        // `PipeObservation`), and the note uses `faithful` only to decide between
        // "the view is complete" and "read another window" -- it never presents
        // a number that would be quietly wrong.
        const body = view.faithful
            ? [
                  {
                      type: "text" as const,
                      text: showReceipt ? receiptText : view.text,
                  },
              ]
            : [...event.content];
        // Notes describe the rewrite or retrieval path, not the tool outcome;
        // leaving isError untouched keeps command success/failure authoritative.
        return {
            content: [
                ...(note.receipt
                    ? [{ type: "text" as const, text: note.receipt }]
                    : []),
                ...body,
                ...(note.notice
                    ? [
                          {
                              type: "text" as const,
                              text: `\n\n[notice] ${note.notice}`,
                          },
                      ]
                    : []),
            ],
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
