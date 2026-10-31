import type { PipePlan } from "./parse.ts";

/** What the tool actually captured, as far as the result can report it. */
export interface PipeObservation {
    /**
     * Line count of the command's whole output, when the tool reports it.
     * Core computes this before its own truncation, so it counts lines that are
     * not in the inline result. Null when the result carries no truncation
     * detail, in which case the visible text's own count is used.
     */
    totalLines: number | null;
    /** Strong errors and warnings over the visible text. */
    err: number;
    warn: number;
    /** Lines in the text the agent can actually read. */
    visibleLines: number | null;
    /** Core's temp file holding everything dropped from the inline result. */
    fullOutputPath: string | null;
    /** Context-sidecar source id, when the output was indexed there. */
    sourceId: string | null;
    /** How to recover the rest, when there is something to recover. */
    receiptLines: string[];
    /**
     * Whether the view below the note is exactly what the removed pipe printed.
     * False means a region was already dropped, so the view is a lower bound
     * rather than the answer the agent asked for.
     */
    faithful: boolean;
    /** Why the view is not faithful, phrased for the agent. */
    caveat: string | null;
    /** How the agent's own pipe would have bounded what it now sees. */
    viewDescription: string;
    /**
     * The pre-filter (stage-0) capture, when the command still filtered after
     * the limiter was hoisted. This is the data a re-filter will want.
     */
    pipeStageZero: {
        path: string;
        command: string;
        sourceId: string | null;
    } | null;
}

/**
 * Bound the prose copy of a long command. The retrieval lines below carry the
 * source id rather than the command, so shortening here cannot lose anything
 * the agent needs to paste.
 */
function preview(command: string): string {
    return command.length <= MAX_PREVIEW_CHARS
        ? command
        : `${command.slice(0, MAX_PREVIEW_CHARS)}…`;
}

/** Longest command rendered in full in the prose line of the note. */
const MAX_PREVIEW_CHARS = 200;

/**
 * The agent-facing note prepended to every modified call's result.
 * It leads with whether the output was captured or retained, then names the
 * effective command and gives only the retrieval forms needed for another view.
 * See `prepareInlineOutput` for the capture-retention contract.
 */
export function pipeNote(plan: PipePlan, observed: PipeObservation): string {
    if (plan.action !== "rewrite" || !plan.invocation) return "";
    const invocation = plan.invocation;
    const capturedLines = observed.totalLines ?? observed.visibleLines;
    const lines = [
        `Effective command: ${JSON.stringify(preview(plan.rewritten))}.`,
    ];
    const hasCapture =
        Boolean(observed.fullOutputPath || observed.sourceId) &&
        capturedLines !== 0;
    const viewLimit =
        invocation.limit ??
        (["head", "tail"].includes(invocation.kind) ? 10 : null);
    const hasMoreThanView =
        !observed.faithful ||
        (capturedLines !== null &&
            capturedLines !== undefined &&
            viewLimit !== null &&
            ["head", "tail", "sed"].includes(invocation.kind) &&
            capturedLines > viewLimit);

    if (!hasCapture) {
        lines.unshift(
            "No output was captured, so there is nothing available to retrieve."
        );
        return lines.join("\n");
    }

    const count = capturedLines ?? 0;
    if (!hasMoreThanView) {
        lines.unshift(
            `The complete ${count}-line output is retained; the view above contains all of it.`
        );
        return lines.join("\n");
    }

    const range = observed.fullOutputPath
        ? `sed -n 'START,ENDp' ${observed.fullOutputPath}`
        : observed.sourceId
          ? `context_get source_id:${JSON.stringify(observed.sourceId)} chunk_id:${JSON.stringify(observed.receiptLines[1]?.match(/chunk_id:["']?([^"' ]+)/)?.[1] ?? `${observed.sourceId}_0001`)}`
          : "";
    lines.unshift(
        `Captured ${count} lines; all are retained (${observed.err} err, ${observed.warn} warn). Read any window with ${range}.`
    );
    if (observed.sourceId) {
        lines.push(
            `Search: context_search query:"pattern" source_id:${JSON.stringify(observed.sourceId)}`
        );
    }
    return lines.join("\n");
}

/** Standing guidance contributed to the bash tool's prompt guidelines. */
export function bashGuidelines(): string[] {
    return [
        "Do not truncate a command's output with a shell pipe. A trailing `| tail -N`, `| head -N`, `| wc -l`, or `| grep -c` is removed before execution: the whole output is captured to a file (and to the context sidecar for large or background output) while your result stays bounded to the N lines you asked for. The pipe is what prevents that capture from happening, and it discards the beginning of an output before anything can read it.",
        "The removal note tells you the captured line count and the err/warn mix over the WHOLE captured output. Read that before re-running anything: it is the stat you would have run the command again to compute.",
        "Filtering is fine and is left alone. `| grep pattern`, `| sed`, and `| awk` change which lines and what text the command produces, so they are NOT removed; they return a different answer, not more of the same one.",
        'To read more of an output you just produced, never re-run the command with a narrower pipe. If the removal note gave you a source id: context_search query:"..." source_id:"...", then context_get source_id:"..." chunk_id:"...", then context_export source_id:"...". If it gave you a file path, grep or sed that path.',
    ];
}
