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
 * The explicit, agent-facing note prepended to every modified call's result.
 *
 * This is the only place the agent learns its command was changed, so it has to
 * say what was removed, what the visible window now is, how much output is
 * recoverable and from where, and which tool to reach for. It is prepended to
 * every modified call, so it stays short.
 */
export function pipeNote(plan: PipePlan, observed: PipeObservation): string {
    if (plan.action !== "rewrite" || !plan.invocation) return "";
    const invocation = plan.invocation;
    const removed = boundText(invocation);

    const lines: string[] = [
        `[pipe-nerf] Removed the output-limiting pipe ${JSON.stringify(removed)} from your command before it ran, so pi captured the whole output instead of truncating it in the shell.`,
        `Effective command: ${JSON.stringify(preview(plan.rewritten))}.`,
    ];

    if (invocation.kind === "head") {
        // `head` and the tool's truncation disagree about which end to keep, so
        // the agent has to be told or it will read a window it did not ask for.
        lines.push(
            `You asked for the first ${invocation.limit ?? "few"} lines. pi keeps the END of long output, so the lines you get are the last ones; grep the full output below if you needed the beginning.`
        );
    }
    if (invocation.mergedStderr) {
        // The merged form is where the habit costs the most: stderr was folded
        // into stdout and then cut, so a failure in the head of the output was
        // dropped before anything could read it.
        lines.push(
            "Your command merged stderr into stdout before the pipe, which cut the error half of the output. pi captures both streams, so the separation is back."
        );
    }

    const counts = observed.totalLines ?? observed.visibleLines;
    if (counts !== null && counts !== undefined) {
        lines.push(
            `Captured ${counts} lines (${observed.err} err, ${observed.warn} warn).`
        );
    }

    if (observed.fullOutputPath) {
        lines.push(`Full output: ${observed.fullOutputPath}`);
    }
    if (observed.sourceId) {
        lines.push(
            `Full output is indexed in the context sidecar as ${JSON.stringify(observed.sourceId)}; use it instead of re-running the command with a narrower pipe.`
        );
        lines.push(...observed.receiptLines);
    }
    if (!observed.fullOutputPath && !observed.sourceId) {
        lines.push(
            `Nothing was dropped (output fits within ${inlineBudget()}), so the result above is the complete output.`
        );
    } else {
        lines.push(
            `Output beyond ${inlineBudget()} is not shown above but is kept, so grep it rather than re-running the command.`
        );
    }

    return lines.join("\n");
}

/** Standing guidance contributed to the bash tool's prompt guidelines. */
export function bashGuidelines(): string[] {
    return [
        "Do not truncate a command's output with a shell pipe. A trailing `| tail -N`, `| head -N`, `| wc -l`, or `| grep -c` is removed before execution: pi already keeps the end of long output inline, writes everything it drops to a file, and indexes large output into the context sidecar. The pipe is what stops that from happening, and it discards the beginning of an output before anything can read it.",
        "Filtering is fine and is left alone. `| grep pattern`, `| sed`, and `| awk` change which lines and what text the command produces, so they are NOT removed; they return a different answer, not more of the same one.",
        "To read more of an output you just produced, do not re-run the command with a narrower pipe. Search it: context_search query:\"...\" source_id:\"...\"; read a range: context_get source_id:\"...\" chunk_id:\"...\"; export it whole: context_export source_id:\"...\".",
        "Long command output carries an err/warn line count (for example `1,204 lines (12 err, 88 warn)`). Read that count before deciding the run succeeded, and read the full output when the count is non-zero.",
    ];
}