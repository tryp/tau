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
    /**
     * Why the view is not faithful, phrased for the agent.
     *
     * NOT rendered by `pipeNote` today. When a view is unfaithful the caller
     * keeps the tool's own content as the body, so the agent is looking at the
     * whole capture rather than at a reduced answer, and the note stays strictly
     * about retention instead of describing a view it did not produce. The field
     * is still populated because the distinction is what tells a caller (and a
     * test) that the view is a lower bound; surfacing the sentence again is a
     * one-line change here and should come with a test for the unfaithful note.
     */
    caveat: string | null;
    /**
     * How the agent's own pipe would have bounded what it now sees.
     *
     * Currently computed by `describeView` and passed in, but no branch of the
     * note renders it: the note states the captured count and the retrieval form
     * instead of describing the view. Left in place because it is the only
     * agent-facing description of the view the tool actually returned, which the
     * receipt path still needs.
     */
    viewDescription: string;
    /**
     * The pre-filter (stage-0) capture, when the command still filtered after
     * the limiter was hoisted. This is the data a re-filter will want.
     *
     * Not mentioned by the retention note: the note names one retrieval route,
     * and the stage-0 file is reachable through the same source id the note
     * already gives. Kept because the tool result carries it and the measurement
     * entries record it.
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
 * The retention note: what it may and may not claim.
 *
 * The invariant itself lives in `prepareInlineOutput` (features/sidecar.ts);
 * this module is only its agent-facing wording, and that function must be read
 * before any branch below is changed. Short version: a limiter decides what the
 * agent SEES, never whether the capture SURVIVES. If the limiter discarded a
 * captured line, that line is persisted and addressable whatever its size --
 * size decides WHERE the capture lives, never WHETHER it exists.
 *
 * That gives the note hard limits, and they are the reason it is shaped this
 * way rather than as a paragraph of advice:
 *
 * - It must always say whether the capture was retained and, when it was, the
 *   cheapest way to read another window. An agent that cannot tell whether its
 *   `pytest | tail -5` output still exists re-runs the suite, which is the exact
 *   work this feature exists to remove.
 * - It must never infer retention from the size of the view. The note this
 *   replaced said "small enough to return inline, so nothing was written to disk
 *   or indexed" -- it described the VIEW and concluded it of the CAPTURE, so
 *   test and build output, which routinely fits the inline budget, discarded
 *   data in the common case. The same inference pointing the other way (naming a
 *   path or source id that does not exist) is equally wrong, so every branch
 *   keys off the handles the tool actually returned, never off a line count.
 * - It must never contradict the rest of the result. One note claimed "nothing
 *   was written to disk or indexed" in the same result as a sidecar receipt
 *   saying the output had been indexed, and the agent had no way to tell which
 *   to believe.
 * - It must never send the agent back to re-run the command for more lines.
 *
 * So there are three cases, in the order the code tests them:
 *
 * 1. No retrieval handle and no capture to speak of: say so plainly. The
 *    discarded lines really are gone at that point, so promising retrieval is
 *    the original lie in a new place.
 * 2. A handle, and the view already contains every captured line: say the view
 *    is complete. "All are retained, read any window" beside complete output
 *    sends the agent to a tool call that cannot show it anything new.
 * 3. A handle, and the limiter dropped lines: state the captured line count and
 *    give the retrieval forms. The count is over the WHOLE capture, so it is the
 *    stat the agent would otherwise re-run the command to compute.
 */
export function pipeNote(plan: PipePlan, observed: PipeObservation): string {
    if (plan.action !== "rewrite" || !plan.invocation) return "";
    const invocation = plan.invocation;
    const capturedLines = observed.totalLines ?? observed.visibleLines;
    const lines = [
        `Effective command: ${JSON.stringify(preview(plan.rewritten))}.`,
    ];
    // A handle, not a size. "Retained" means retrievable somewhere the agent can
    // reach; zero lines is the one capture not worth indexing, and it is excluded
    // here so an empty result reads as empty instead of as retained-but-hidden.
    const hasRetrievalHandle =
        Boolean(observed.fullOutputPath || observed.sourceId) &&
        capturedLines !== 0;
    // What the agent's own pipe bounded the view to, used only to decide whether
    // any captured line sits outside that view. Compare against the capture, not
    // the view: a view of 5 lines can be the whole 5-line capture.
    const viewLimit =
        invocation.limit ??
        (["head", "tail"].includes(invocation.kind) ? 10 : null);
    // An unfaithful view has already dropped a region, so it needs no count to
    // prove there is more than the agent can see; the count comparison only
    // decides the faithful case.
    const hasLinesBeyondView =
        !observed.faithful ||
        (capturedLines !== null &&
            capturedLines !== undefined &&
            viewLimit !== null &&
            ["head", "tail", "sed"].includes(invocation.kind) &&
            capturedLines > viewLimit);

    if (!hasRetrievalHandle) {
        lines.unshift(
            "No output was captured, so there is nothing available to retrieve."
        );
        return lines.join("\n");
    }

    const count = capturedLines ?? 0;
    if (!hasLinesBeyondView) {
        lines.unshift(
            `The complete ${count}-line output is retained; the view above contains all of it.`
        );
        return lines.join("\n");
    }

    // The receipt's own chunk id is preferred because it is the chunk the agent
    // was already shown; the conventional first-chunk id keeps the call valid
    // when the tool reported a source without rendering a receipt.
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
