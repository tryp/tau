import type { PipeInvocation, PipePlan } from "./parse.ts";
import { BUILTIN_MAX_BYTES, BUILTIN_MAX_LINES } from "./parse.ts";

/** Longest command rendered in full in the prose line of the note. */
const MAX_PREVIEW_CHARS = 200;

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
}

/** Render the removed stage so the note never claims a bound it did not read. */
function boundText(invocation: PipeInvocation): string {
    if (invocation.limit === null) return `| ${invocation.kind}`;
    const token = invocation.limitToken ?? String(invocation.limit);
    return `| ${invocation.kind} ${token}`;
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

/** pi's inline bounds, in the units the note reads best. */
function inlineBudget(): string {
    return `the last ${BUILTIN_MAX_LINES} lines or ${Math.round(BUILTIN_MAX_BYTES / 1024)}KB`;
}

/**
 * The agent-facing note prepended to every modified call's result.
 *
 * The contract is: you asked for a bounded view, you still get one, and
 * nothing you would otherwise have re-run for is gone. So the note says what
 * was removed, how much is now captured, the err/warn mix (the stat an agent
 * would otherwise re-run the command to compute), and the exact call that
 * retrieves any part it cannot see.
 *
 * It is prepended to every modified call, so it stays short: the retrieval
 * instructions are one line each, not a tutorial.
 */
export function pipeNote(plan: PipePlan, observed: PipeObservation): string {
    if (plan.action !== "rewrite" || !plan.invocation) return "";
    const invocation = plan.invocation;
    const removed = boundText(invocation);

    const lines: string[] = [
        `[pipe-nerf] Removed the output-limiting pipe ${JSON.stringify(removed)} before running, so the whole output is now captured instead of discarded in the shell.`,
        `Effective command: ${JSON.stringify(preview(plan.rewritten))}.`,
    ];

    // What the agent sees is what it asked for, so say so explicitly: otherwise
    // a short result next to "the whole output is captured" reads as if the
    // capture were still filtered.
    lines.push(`Showing below: ${observed.viewDescription}.`);

    if (observed.caveat) {
        lines.push(`Note: ${observed.caveat}.`);
    }
    if (invocation.mergedStderr) {
        // The merged form is where the habit costs the most: stderr was folded
        // into stdout and then cut, so a failure in the head of the output was
        // dropped before anything could read it.
        lines.push(
            "Your command merged stderr into stdout before the pipe, which cut the error half of the output. pi captures both streams, so the separation is back."
        );
    }
    if (invocation.kind === "head") {
        // `head` and the tool's truncation disagree about which end to keep, so
        // the agent has to be told or it will read a window it did not ask for.
        lines.push(
            "You asked for the beginning of the output. pi keeps the END of long output, so read the capture below if you needed the first lines."
        );
    }

    const counts = observed.totalLines ?? observed.visibleLines;
    if (counts !== null && counts !== undefined) {
        lines.push(
            `Captured ${counts} lines (${observed.err} err, ${observed.warn} warn). The err/warn counts cover everything captured, not just the part shown.`
        );
    }

    if (observed.sourceId) {
        lines.push(
            `The full output is indexed in the context sidecar as ${JSON.stringify(observed.sourceId)}. Do not re-run the command to read it.`
        );
        lines.push(...observed.receiptLines);
    }
    if (observed.fullOutputPath && !observed.sourceId) {
        lines.push(
            `The full output is on disk at ${observed.fullOutputPath}. Do not re-run the command to read it: grep it, or read a range.`
        );
        lines.push(
            `- Search it: grep -nE "pattern" ${observed.fullOutputPath}`
        );
        lines.push(
            `- Read a range: sed -n '${Math.max(1, (observed.totalLines ?? 1) - 99)},${observed.totalLines ?? 100}p' ${observed.fullOutputPath}`
        );
    }
    if (!observed.fullOutputPath && !observed.sourceId) {
        // The capture fits inline, so there is no separate retrieval route -- but
        // the agent still asked for a BOUNDED view of it. Saying "what is shown
        // is the complete output" would be false (the view is 3 lines of 60) and
        // would leave the agent no route to the rest, which is the re-run this
        // nerf exists to prevent. So say plainly that the capture was inline and
        // the remainder has to be re-requested.
        lines.push(
            `The capture fits within ${inlineBudget()}, so nothing was written to disk and there is no sidecar source. Everything captured is counted above; to read the part not shown above, re-run the same command without a pipe.`
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
        "To read more of an output you just produced, never re-run the command with a narrower pipe. If the removal note gave you a source id: context_search query:\"...\" source_id:\"...\", then context_get source_id:\"...\" chunk_id:\"...\", then context_export source_id:\"...\". If it gave you a file path, grep or sed that path.",
    ];
}
