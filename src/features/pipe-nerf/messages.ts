import type { PipeInvocation, PipePlan } from "./parse.ts";
import { BUILTIN_MAX_BYTES, BUILTIN_MAX_LINES } from "./parse.ts";

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

/** Visible line count, or the capture total, whichever the hook reported. */
function visibleLines(observed: PipeObservation): number {
    return observed.totalLines ?? observed.visibleLines ?? 100;
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

const PURE_READ_RE =
    /^\s*(?:\/usr\/bin\/)?(?:cat|head|tail|sed|awk|rg|grep|ls|find|stat|pwd|git\s+(?:show|diff|log|blame))\b/;

/**
 * Whether re-running the command is idempotent.
 *
 * \"Re-run without a pipe\" is safe advice for a reader and bad advice for a
 * build: `cat f | tail -5` re-run for more lines is free, while
 * `pytest | tail -5` re-run can produce different output against a tree that
 * changed underneath it. Telling an agent to re-run a suite to see 20 more lines
 * is the exact wasted work this nerf is meant to remove, so the case must be
 * split rather than answered with a blanket re-run.
 */
function pureReadCommand(command: string): boolean {
    const first = command.split(/[\n;&|]/)[0] ?? "";
    return PURE_READ_RE.test(first);
}

/** Longest command rendered in full in the prose line of the note. */
const MAX_PREVIEW_CHARS = 200;

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

    // `visibleLines` is null when the content is the tool's own sidecar receipt:
    // the receipt carries the true totals, so substituting its own line count
    // reported "Captured 7 lines" next to a receipt saying 60.
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
    // The path is offered on BOTH routes, not just the disk one. The sidecar
    // source is for `context_*` retrieval, but an agent that wants to re-filter
    // or post-process (`sort`, `jq`, `awk`, a different grep) needs something it
    // can point a tool at, and the log file is that. It was previously only
    // surfaced when nothing was indexed, so the indexed case -- the common one for
    // large output -- offered no way to post-process at all.
    if (observed.fullOutputPath) {
        const lines_total = observed.totalLines ?? visibleLines(observed);
        lines.push(
            `The full output is also on disk at ${observed.fullOutputPath} -- re-filter or post-process it there instead of re-running the command.`
        );
        lines.push(
            `- Re-filter it: grep -nE "your-pattern" ${observed.fullOutputPath}`
        );
        lines.push(
            `- Read a range: sed -n '${Math.max(1, lines_total - 99)},${lines_total}p' ${observed.fullOutputPath}`
        );
    }
    if (!observed.fullOutputPath && !observed.sourceId) {
        // There is no RECOVERABLE capture, but the agent still asked for a bounded
        // view of one. Saying "what is shown is the complete output" would be
        // false (the view is 3 lines of 60), and telling it to re-run the same
        // command would repeat work for output that was never captured.
        //
        // The split that matters is whether re-execution is safe at all: a reader
        // (`cat`, `git show`, `ls`) is idempotent, so a different bound gives a
        // different slice of the same data. A runner (`pytest`, `make`, `ruff`)
        // is not -- its output depends on the tree, so re-running to see 20 more
        // lines can produce different output and is precisely the wasted work
        // this nerf exists to remove. Point that case at bash_bg instead.
        lines.push(
            `The output was small enough to return inline, so nothing was written to disk or indexed. The lines above are a bounded view; the rest were never captured and cannot be retrieved afterwards.`
        );
        if (pureReadCommand(plan.rewritten)) {
            lines.push(
                `Your command only reads, so it is idempotent: run it again with a different bound (tail -N, head -N) or with no pipe to see any part you want.`
            );
        } else {
            lines.push(
                `Your command runs rather than only reads, so do NOT re-run it just to see more lines. Use bash_bg with the plain command next time: it writes the full output to a log and indexes it, so every part stays readable at any size.`
            );
        }
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
