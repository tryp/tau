/**
 * Pipe nerf replaces output-limiting shell pipes with the tool's own capture.
 *
 * The bash tool already keeps the last `DEFAULT_MAX_LINES` (2000) lines or
 * 50KB inline, writes everything it drops to a temp file, and — for a background
 * job — indexes the whole output into the context sidecar so it can be read
 * with `context_search` / `context_get`. A `| tail -20` inside the command
 * happens *before* any of that: the discarded text never reaches the tool, so it
 * is never written to the temp file, never indexed, and cannot be recovered.
 *
 * The measured habit (30-day corpus, 3,245 files, 808k bash calls):
 *
 * - 463,318 of 808,346 bash calls (57.32%) end in a limiting pipe.
 * - 99.53% of those limits are below the 2000-line budget the tool already
 *   applies, so the pipe replaces a bound that is applied anyway with one that
 *   destroys the recovery path.
 * - 53.68% are <= 10 lines.
 * - 29.86% are `2>&1 | <limiter>`: stderr is merged into stdout and then cut,
 *   which discards the error half of the output.
 * - 19,702 of 36,277 `bash_bg` calls (54.31%) pipe, and a background job's log
 *   is the only record it has.
 * - 1.02% of piped calls retained any full output at all.
 *
 * So the rewrite removes the limiter and lets the tool's own capture apply. It
 * is deliberately narrow, because a pipe that *transforms* or *filters* is not
 * redundant and rewriting it would change the answer:
 *
 * - `| tail -20`, `| head -40`, `| wc -l` bound the output. Removing them
 *   returns strictly more of the command's own output.
 * - `| grep foo` keeps matching lines. Removing it returns other lines: a
 *   different answer, so it is left alone.
 * - `| sed 's/a/b/'` and `| awk '{print $1}'` rewrite every line. Removing
 *   them returns different text: a different answer, so they are left alone.
 * - Only a `grep -c` / `--count` is a limiter, because it emits one number
 *   regardless of input size.
 *
 * `head` is hoisted the same way as `tail` even though the tool keeps the tail,
 * for two reasons: the agent asked for a *bound*, not for a specific end, and
 * the inline result is capped by the tool's own budget either way. The note
 * says so explicitly, so the agent knows the region it is looking at changed.
 *
 * Recognition mirrors `session_analysis.pipe_usage` (the counting oracle), and
 * the rewrite guards here are deliberately stricter: counting a habit and being
 * willing to rewrite it are separate decisions.
 */

/** A filter stage that bounds how much output reaches the tool. */
export type LimiterKind = "tail" | "head" | "wc" | "grep" | "rg" | "sed" | "awk";

/** A resolved trailing limiter stage inside a bash command string. */
export interface PipeInvocation {
    /** The filter's name as written, without a path prefix. */
    kind: LimiterKind;
    /** The line count the agent asked for, or null when none was set. */
    limit: number | null;
    /** The limit token as written (`-20`, `-n 20`, `-n20`), or null. */
    limitToken: string | null;
    /** Index of the `|` operator that introduces this stage. */
    start: number;
    /** Index just past the limiter's own arguments (end of the stage). */
    end: number;
    /** Whether the stage begins with `2>&1`, so stderr was merged into it. */
    mergedStderr: boolean;
}

export type SkipReason =
    /** The trailing stage does not bound output (no limiter present). */
    | "no-pipe"
    /** A `tail -f` follows its input rather than bounding it. */
    | "not-a-limiter"
    /** A limiter exists but is not the command's last stage. */
    | "last-stage-only"
    /** Nothing runs before the limiter, so removing it leaves no command. */
    | "empty-command"
    | "disabled"
    | "line-break";

export interface PipePlan {
    action: "rewrite" | "skip";
    reason: SkipReason | null;
    original: string;
    invocation: PipeInvocation | null;
    /** The command that will actually run. */
    rewritten: string;
}

/**
 * pi's own inline limits. Mirrors core's DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES,
 * which decide whether the rewritten command's output stays inline or is
 * written out and indexed. Used by the note to say which happened.
 */
export const BUILTIN_MAX_LINES = 2000;
export const BUILTIN_MAX_BYTES = 50 * 1024;

/**
 * Name of a stage's program: the first token with any path prefix removed,
 * so `/usr/bin/tail -20` resolves to `tail`. A leading `&` (bash's `|&`) is
 * consumed by the caller first.
 */
const PROGRAM_RE = /^[\w.+~/-]*/;

// `tail -20`, `tail -n 20`, `tail -n20`, and the deprecated bare `tail 20`.
const TAIL_HEAD_N_RE = /(?:^|\s)-(?:[A-Za-z]*n)?\s*(\d+)/;
const BARE_N_RE = /(?:^|\s)(\d+)(?:\s|$)/;
// `sed -n '1,50p'` / `sed -n 160,230p`: the last line number is a monotone proxy
// for how much the stage emits, so a re-run showing `160,230p` orders above
// `1,160p`.
const SED_RANGE_P_RE = /(\d+)\s*p/;
// `grep -c` / `rg -c` / `grep --count`. A plain filter keeps every match, so it
// is not a limiter.
const COUNT_SHORT_RE = /(?:^|\s)-[A-Za-z]*c(?:\s|$)/;
const COUNT_LONG_RE = /(?:^|\s)--count(?:\s|=|$)/;
// `sed` selects lines only with `-n`; without it the `p` command duplicates
// them, which does not bound output.
const SED_AN_RE = /(?:^|\s)-[A-Za-z]*n(?:\s|$)/;
// An `awk` program bounds the stream only when it can end early or emit after
// the stream ends.
const AWK_BOUND_RE = /\bEND\b|\bexit\b|\bNR\b/;
// A trailing comment cannot be rewritten: the limiter is inside it, so removing
// it would change the comment's text rather than the command.
const TRAILING_COMMENT_RE = /(^|\n)\s*#/;

/**
 * Index of the command's last *top-level* pipe operator, or -1.
 *
 * A `|` inside quotes, a command substitution, or a `( )` subshell is not an
 * operator: `awk '{print "a|b"}' | wc -l` pipes into `wc`, while
 * `wc -l < "a | tail -1"` has no pipe at all even though a `| tail` sits inside
 * the filename. `||` is a control operator rather than a pipe.
 */
export function lastPipeOperator(command: string): number {
    let quote = "";
    let depth = 0;
    let found = -1;
    let i = 0;
    const n = command.length;
    while (i < n) {
        const ch = command[i];
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < n) {
                i += 2;
                continue;
            }
            if (ch === quote) quote = "";
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
        } else if (ch === "\\" && i + 1 < n) {
            i += 2;
            continue;
        } else if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (ch === "|" && depth === 0) {
            if (command[i + 1] === "|") {
                i += 2;
                continue;
            }
            found = i;
        }
        i += 1;
    }
    return found;
}

/**
 * Index of the first top-level control operator in `text`, or -1.
 *
 * A limiter's own arguments end where its segment does. Without this bound,
 * `git status | wc -l; git log -1` gave the `wc` stage the whole rest of the
 * command and `parseCount` read its "bound" as the `1` from `git log -1`. The
 * corpus fixture caught this as a disagreement with the Python oracle, which
 * bounds its stage args the same way.
 */
function controlOperatorIn(text: string): number {
    let quote = "";
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < text.length) {
                i += 1;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
        } else if (ch === "\\" && i + 1 < text.length) {
            i += 1;
        } else if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0) {
            if (ch === ";" || ch === "\n") return i;
            if (ch === "&" && text[i + 1] === "&") return i;
            if (ch === "|" && text[i + 1] === "|") return i;
        }
    }
    return -1;
}

/** End of the last top-level control operator (`&&`, `||`, `;`, newline). */
function lastControlOperator(command: string): number {
    let quote = "";
    let depth = 0;
    let found = -1;
    let i = 0;
    const n = command.length;
    while (i < n) {
        const ch = command[i];
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < n) {
                i += 2;
                continue;
            }
            if (ch === quote) quote = "";
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
        } else if (ch === "\\" && i + 1 < n) {
            i += 2;
            continue;
        } else if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0) {
            if (ch === "\n") {
                found = i;
            } else if (ch === ";") {
                found = i;
            } else if (ch === "&" && command[i + 1] === "&") {
                found = i;
            } else if (ch === "|" && command[i + 1] === "|") {
                found = i;
                i += 1;
            }
        }
        i += 1;
    }
    return found;
}

/** Split a stage into its program name, keeping a path prefix out of the way. */
function programName(stage: string): string | null {
    const token = PROGRAM_RE.exec(stage.trim())?.[0] ?? "";
    if (!token || !/[A-Za-z]/.test(token)) return null;
    const slash = token.lastIndexOf("/");
    return slash === -1 ? token : token.slice(slash + 1);
}

/** The `2>&1` immediately before a limiter, so stderr was merged into it. */
function hasStderrMerge(beforeOperator: string): boolean {
    return /2>&1\s*$/.test(beforeOperator);
}

/** The stage's own arguments, ending at its segment's control operator. */
function boundedArgs(stage: string, nameLength: number): string {
    const args = stage.slice(nameLength);
    const cut = controlOperatorIn(args);
    return cut >= 0 ? args.slice(0, cut) : args;
}

function parseCount(
    kind: string,
    stage: string
): { limit: number | null; token: string | null } {
    if (kind === "sed") {
        // `sed -n '1,50p'`: the digits sit inside quotes with no surrounding
        // whitespace, so the tail/head patterns cannot see them. The LAST line
        // number is used so a re-run showing `51,100p` orders above `1,50p`.
        const ranges = [...stage.matchAll(/(\d+)\s*p/g)];
        const last = ranges.at(-1);
        if (last) return { limit: Number(last[1]), token: last[0].trim() };
        return { limit: null, token: null };
    }
    const tailHead = TAIL_HEAD_N_RE.exec(stage);
    if (tailHead) {
        const token = stage
            .slice(tailHead.index, tailHead.index + tailHead[0].length)
            .trim();
        return { limit: Number(tailHead[1]), token };
    }
    const bare = BARE_N_RE.exec(stage);
    if (bare) {
        return { limit: Number(bare[1]), token: bare[1] };
    }
    return { limit: null, token: null };
}

/**
 * Resolve the command's trailing limiter, or null when there is none.
 *
 * Mirrors `session_analysis.pipe_usage.limiting_filter` /
 * `limit_value`, which count the habit and are therefore permissive about the
 * exact shape. This function additionally returns spans and the stderr-merge
 * flag, which a rewrite needs and a count does not.
 */
export function findPipeInvocation(command: string): PipeInvocation | null {
    const at = lastPipeOperator(command);
    if (at < 0) return null;

    const stageStart = at + 1;
    // bash's `|&` pipes both streams; the `&` is an operator flag, not a program.
    const stage = command.slice(stageStart).trimStart().replace(/^&/, "").trimStart();
    const name = programName(stage);
    if (name === null) return null;

    // Trim ONCE and slice that same string. Slicing the untrimmed stage with a
    // trimmed offset left the program's last character behind and cut the
    // digits off the bound: `tail -20` read its limit as 0. Then cut the args at
    // the segment's control operator, so text belonging to the NEXT command
    // cannot be read as this limiter's bound.
    const args = boundedArgs(stage, name.length);
    // Recognition mirrors the oracle, which returns null for a stage that does
    // not bound. Without this gate `| tr ',' '\n'` -- a character substitution
    // that emits as many lines as it receives -- was reported as a `tr` limiter,
    // which is both wrong and a promise the rewrite cannot keep.
    if (!isLimiterName(name)) return null;
    const kind = name as LimiterKind;
    // Recognition must ALSO require that the stage bounds output, exactly as the
    // oracle does. `| grep -n "x"` and `| grep foo` keep every matching line, so
    // they are not limiters and must return null here — otherwise recognition
    // would claim a stage the rewrite refuses, which is the mismatch the corpus
    // fixture exists to catch. (Function declarations hoist, so calling the
    // binding test defined below is safe.)
    if (!stageBindsOutput(kind, args)) return null;
    const { limit, token } = parseCount(kind, args);

    return {
        kind,
        limit,
        limitToken: token,
        start: at,
        end: command.length,
        mergedStderr: hasStderrMerge(command.slice(0, at)),
        stageStart,
    };
}

const LIMITER_NAMES: ReadonlySet<string> = new Set([
    "tail",
    "head",
    "wc",
    "grep",
    "rg",
    "sed",
    "awk",
]);

/** Whether a stage's program is one this hook knows how to reason about. */
function isLimiterName(name: string): boolean {
    return LIMITER_NAMES.has(name);
}

function skipped(
    command: string,
    reason: SkipReason,
    invocation: PipeInvocation | null = null
): PipePlan {
    return {
        action: "skip",
        reason,
        original: command,
        invocation,
        rewritten: command,
    };
}

/**
 * Whether this stage bounds output, as opposed to transforming or filtering it.
 *
 * The distinction is the whole safety argument: a limiter's output is a subset
 * of its input, so removing it returns *more* of what the command produced. A
 * filter's output is a *selection*, and a transform's output is *different
 * text*, so removing either changes the answer rather than revealing it.
 */
function stageBindsOutput(kind: LimiterKind, args: string): boolean {
    switch (kind) {
        case "tail":
        case "head":
        case "wc":
            return true;
        case "grep":
        case "rg":
            return COUNT_SHORT_RE.test(args) || COUNT_LONG_RE.test(args);
        case "sed":
            return SED_AN_RE.test(args) && SED_RANGE_P_RE.test(args);
        case "awk":
            return AWK_BOUND_RE.test(args);
        default:
            return false;
    }
}

/**
 * Decide whether to strip the command's trailing output-limiting pipe.
 *
 * Only the FINAL pipeline stage of the command's LAST segment is eligible: it
 * has to be what determines what the tool ends up showing, and its output has
 * to be the command's last word.
 */
export function planPipeNerf(command: string, options: { enabled?: boolean } = {}): PipePlan {
    const at = lastPipeOperator(command);
    if (at < 0) return skipped(command, "no-pipe");

    // A limiter only bounds the tool's output if it ends the command. In
    // `a | tail -5; b` the limiter's output is interleaved with b's, so
    // removing it would change b's context too. Reported separately from
    // `no-pipe`: the command DOES pipe, and a reader comparing the two reasons
    // needs to be able to tell "no pipe" from "a pipe that is not the last word".
    if (lastControlOperator(command) >= at) {
        return skipped(command, "last-stage-only");
    }

    const invocation = findPipeInvocation(command);
    if (!invocation) return skipped(command, "no-pipe");

    if (options.enabled === false) return skipped(command, "disabled", invocation);

    // A limiter inside a trailing comment is prose, not a bound.
    if (TRAILING_COMMENT_RE.test(command)) return skipped(command, "no-pipe", invocation);

    // Trim ONCE and slice that same string; see `findPipeInvocation`.
    const stage = command.slice(invocation.stageStart).trimStart().replace(/^&/, "").trimStart();
    const args = boundedArgs(stage, (programName(stage) ?? "").length);

    // `findPipeInvocation` already gated on `stageBindsOutput`, so reaching here
    // with a non-binding stage is a parser invariant break, not a user case.
    if (!stageBindsOutput(invocation.kind, args)) {
        return skipped(command, "no-pipe", invocation);
    }

    // `| tail -f` / `| head -n -5` follow the input rather than bounding it, so
    // removing them would hand the tool a command that never returns. `-f` on
    // `tail` is the whole point of that flag.
    if (invocation.kind === "tail" && /(?:^|\s)-[A-Za-z]*f(?:\s|$)/.test(args)) {
        return skipped(command, "not-a-limiter", invocation);
    }

    // A line break between the operator and the stage means the limiter belongs
    // to a different command than the text after it.
    if (/[\r\n]/.test(command.slice(invocation.start, invocation.stageStart))) {
        return skipped(command, "line-break", invocation);
    }

    // The text before the `|` has to be a command. `cmd | ` with nothing before
    // it is a syntax error either way, and `| tail -5` on its own is not a
    // command the agent wrote on purpose.
    const before = command.slice(0, invocation.start);
    if (!/\S/.test(before)) return skipped(command, "empty-command", invocation);

    // The rewrite joins `before` with whatever followed the last control
    // operator, so a trailing `; cmd` keeps its own command and its own limiter
    // is the one rewritten. Anything after the operator must be whitespace only,
    // which `findPipeInvocation` already established.
    const controlEnd = lastControlOperator(command);
    const prefix = command.slice(0, Math.max(invocation.start, controlEnd + 1));
    const trimmedPrefix = prefix.replace(/\s+$/, "");
    // A separator must not be swallowed by the join: `a && | tail -5` is not a
    // command, and `a; | tail -5` would become `a;` with nothing to run.
    if (/[;&|]\s*$/.test(trimmedPrefix)) {
        return skipped(command, "empty-command", invocation);
    }
    if (!/\S/.test(trimmedPrefix)) return skipped(command, "empty-command", invocation);

    return {
        action: "rewrite",
        reason: null,
        original: command,
        invocation,
        rewritten: trimmedPrefix,
    };
}