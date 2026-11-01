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

import { fileURLToPath } from "node:url";

const stageZeroCaptureScript = fileURLToPath(
    new URL("./stage0-capture.mjs", import.meta.url)
);

function stageZeroCaptureCommand(path: string): string {
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(stageZeroCaptureScript)} ${JSON.stringify(path)}`;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Split a pipeline into shell stages, respecting quoting and subshells. */
function splitPipelineStages(command: string): string[] {
    const stages: string[] = [];
    let start = 0;
    let quote = "";
    let depth = 0;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === "\\" && quote === '"') i++;
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") quote = ch;
        else if (ch === "\\") i++;
        else if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (ch === "|" && depth === 0 && command[i + 1] !== "|") {
            stages.push(command.slice(start, i).trim());
            if (command[i + 1] === "&") i++;
            start = i + 1;
        }
    }
    stages.push(command.slice(start).trim());
    return stages;
}

/** Capture PIPESTATUS without changing the pipeline's observable exit code. */
function recordPipelineExit(
    segment: string,
    path: string,
    index: number
): string {
    const exitPath = shellQuote(path);
    return `( ${segment}; __pi_pipe_rc=$? __pi_pipe_status=("\${PIPESTATUS[@]}"); printf '%s\\t%s\\n' ${index} "\${__pi_pipe_status[*]}" >> ${exitPath}; exit "$__pi_pipe_rc" )`;
}

function instrumentPipelineExits(
    command: string,
    capturePath: string
): { command: string; exitPath: string; stages: string[][] } {
    const exitPath = `${capturePath}.exits`;
    const stages: string[][] = [];
    const segments = splitControlSegments(command).map((segment) => {
        if (!segment.text.includes(stageZeroCaptureScript)) return segment;
        const commands = splitPipelineStages(segment.text);
        stages.push(commands);
        return {
            ...segment,
            text: recordPipelineExit(segment.text, exitPath, stages.length),
        };
    });
    const joined = segments
        .map((segment) => segment.text + segment.separator)
        .join("");
    return {
        command: `: > ${shellQuote(exitPath)}; ${joined}`,
        exitPath,
        stages,
    };
}

/** A filter stage that bounds how much output reaches the tool. */
export type LimiterKind =
    | "tail"
    | "head"
    | "wc"
    | "grep"
    | "rg"
    | "sed"
    | "awk";

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
    /** Index of the limiter's first character (after the operator). */
    stageStart: number;
    /** Index just past the limiter's own arguments (end of the stage). */
    end: number;
    /** Whether the stage begins with `2>&1`, so stderr was merged into it. */
    mergedStderr: boolean;
    /** The limiter's own arguments, for reproducing its view. */
    args: string;
    /**
     * Whether an upstream pipeline stage precedes the limiter.
     *
     * It decides what the limiter can be reconstructed from. `cat f | wc -l`
     * counts the capture's lines, so the tool's own total answers it exactly.
     * `seq 1 100 | grep -v 5 | wc -l` counts lines that never match, and the
     * capture holds whatever survived -- so neither the capture nor the tool's
     * total can answer it, and the view must be marked unfaithful rather than
     * reported as a number.
     */
    hasUpstreamStage: boolean;
}

/** Options controlling the rewrite, mirrors `NerfOptions` in timeout-nerf. */
export interface PipeOptions {
    enabled?: boolean;
    /**
     * Where to tee stage 0's pre-filter output when the command still filters
     * after the limiter is hoisted. Omit to skip the capture.
     */
    stageZeroPath?: string;
    /** Directory used for stage-0 files; commands that scan it are not hoisted. */
    stageZeroDirectory?: string;
}

export type SkipReason =
    /** The trailing stage does not bound output (no limiter present). */
    | "no-pipe"
    /** A recognized limiter is in a trailing comment and cannot be rewritten. */
    | "limiter-in-comment"
    /** A `tail -f` follows its input rather than bounding it. */
    | "not-a-limiter"
    /**
     * An `&&` or `||` follows the limiter, so the chain reads the stage's exit
     * status. Removing the stage changes what runs: measured,
     * `false | tail -5 && echo done` prints `done` (tail exits 0) while
     * `false && echo done` prints nothing.
     */
    | "status-bearing-operator"
    /** Nothing runs before the limiter, so removing it leaves no command. */
    | "empty-command"
    | "disabled"
    | "line-break"
    /** A limiter pipe was found in a non-final semicolon/newline segment. */
    | `pipe-outside-scope:segment-${number}`
    /** A shell here-document makes the remaining command text data, not code. */
    | "heredoc"
    /** The command scans the directory where pipe-hoist would write its capture. */
    | "capture-directory-reference";

export interface PipePlan {
    action: "rewrite" | "skip";
    reason: SkipReason | null;
    original: string;
    invocation: PipeInvocation | null;
    /** The command that will actually run. */
    rewritten: string;
    /**
     * Where stage 0's output is being written, when the command still filters
     * after the limiter was hoisted.
     *
     * Set only when the rewritten command still contains a pipeline: if removing
     * the limiter left a single command, its whole output IS the capture and a
     * second file would duplicate it.
     */
    stageZero: { path: string; command: string; operatorAt: number } | null;
    /** Compound calls keep their shell limiters, so the shell already made each view. */
    preserveLimiterViews?: boolean;
    /** Ordered pipeline inputs appended to the compound call's stage-0 file. */
    stageZeroSegments?: {
        command: string;
        separator: string;
        captured: boolean;
    }[];
    /** Directory named in the self-reference preflight notice. */
    captureDirectory?: string;
    /** Path containing per-segment PIPESTATUS records. */
    stageExitPath?: string;
    /** Rewritten process names for each captured pipeline segment. */
    pipelineExitCommands?: string[][];
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
        if (ch === "'" || ch === '"' || ch === "`") {
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
            if (
                ch === "\\" &&
                (quote === '"' || quote === "`") &&
                i + 1 < text.length
            ) {
                i += 1;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
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

/** Split at top-level statement/status operators, retaining each separator. */
function splitControlSegments(
    command: string
): { text: string; separator: string }[] {
    const segments: { text: string; separator: string }[] = [];
    let start = 0;
    while (start < command.length) {
        const relative = controlOperatorIn(command.slice(start));
        if (relative < 0) break;
        const at = start + relative;
        const separator =
            command.startsWith("&&", at) || command.startsWith("||", at)
                ? command.slice(at, at + 2)
                : command[at];
        segments.push({ text: command.slice(start, at), separator });
        start = at + separator.length;
    }
    segments.push({ text: command.slice(start), separator: "" });
    return segments;
}

/**
 * Index of the command's FIRST top-level pipe operator, or -1.
 *
 * This marks the end of stage 0 -- the command whose output every later stage is
 * a deterministic function of. Capturing stage 0 is what lets an agent re-run a
 * DIFFERENT filter against it without re-executing the command; capturing a
 * later stage does not, because that stage is re-derivable from stage 0.
 *
 * `|&` is skipped rather than matched: injecting `| tee` into it would splice a
 * new stage into a both-streams redirect and change the command.
 */
export function firstPipeOperator(command: string): number {
    let quote = "";
    let depth = 0;
    const found = -1;
    let i = 0;
    const n = command.length;
    while (i < n) {
        const ch = command[i];
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < n) {
                i += 2;
                continue;
            }
            if (ch === quote) {
                quote = "";
            }
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
        } else if (ch === "\\" && i + 1 < n) {
            i += 2;
            continue;
        } else if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (ch === "|" && depth === 0) {
            if (command[i + 1] === "|" || command[i + 1] === "&") {
                i += 2;
                continue;
            }
            return i;
        }
        i += 1;
    }
    return found;
}

/**
 * The last top-level control operator, and whether it reads a status.
 *
 * `;` and a newline separate statements: the next one runs regardless of what
 * the previous returned. `&&` and `||` chain on it: they read the previous
 * stage's exit status. That difference decides whether a limiter placed before
 * the operator can be removed, and conflating the two is what a single
 * "not-the-last-stage" guard does -- it refused 116,786 corpus calls that the
 * `;` form makes safe.
 */
function segmentNumberAt(command: string, end: number): number {
    let segment = 1;
    let start = 0;
    while (start < end) {
        const relative = controlOperatorIn(command.slice(start, end));
        if (relative < 0) break;
        const at = start + relative;
        if (command[at] === ";" || command[at] === "\n") segment += 1;
        start =
            at +
            (command.startsWith("&&", at) || command.startsWith("||", at)
                ? 2
                : 1);
    }
    return segment;
}

function lastControlOperator(command: string): {
    at: number;
    statusBearing: boolean;
} {
    let quote = "";
    let depth = 0;
    let at = -1;
    let statusBearing = false;
    let i = 0;
    const n = command.length;
    while (i < n) {
        const ch = command[i];
        if (quote) {
            if (ch === "\\" && quote === '"' && i + 1 < n) {
                i += 2;
                continue;
            }
            if (ch === quote) {
                quote = "";
            }
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
        } else if (ch === "\\" && i + 1 < n) {
            i += 2;
            continue;
        } else if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0) {
            if (ch === "\n" || ch === ";") {
                at = i;
                statusBearing = false;
            } else if (
                (ch === "&" && command[i + 1] === "&") ||
                (ch === "|" && command[i + 1] === "|")
            ) {
                at = i;
                statusBearing = true;
                i += 1;
            }
        }
        i += 1;
    }
    return { at, statusBearing };
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
    const stage = command
        .slice(stageStart)
        .trimStart()
        .replace(/^&/, "")
        .trimStart();
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
        args,
        // Only a pipe in this command segment is upstream. A pipeline after `;`,
        // `&&`, or `||` is independent and must not make this limiter unfaithful.
        hasUpstreamStage: (() => {
            let segmentStart = 0;
            while (segmentStart < at) {
                const relative = controlOperatorIn(
                    command.slice(segmentStart, at)
                );
                if (relative < 0) break;
                const operatorAt = segmentStart + relative;
                segmentStart =
                    operatorAt +
                    (command.startsWith("&&", operatorAt) ||
                    command.startsWith("||", operatorAt)
                        ? 2
                        : 1);
            }
            return lastPipeOperator(command.slice(segmentStart, at)) >= 0;
        })(),
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

/** What the agent's own pipe would have printed, reconstructed from the capture. */
export interface LimiterView {
    /** The text to show in place of the full output. */
    text: string;
    /**
     * Whether `text` is exactly what the shell pipe would have printed. False
     * when the tool's own budget had already dropped the region the limiter
     * reads, or when the limiter is a program this module does not reproduce.
     */
    faithful: boolean;
    /** Why it is not faithful, phrased for the note. */
    caveat: string | null;
}

function splitLines(text: string): string[] {
    const lines = text.split("\n");
    // A trailing newline is a terminator, not an empty final line.
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

/**
 * Reproduce the agent's pipe against the captured output.
 *
 * The command runs untruncated so the tool captures everything, but the RESULT
 * is still bounded to what the agent asked for. Removing the pipe and returning
 * the whole capture would hand back 60 lines where the agent wrote `| tail -3`
 * -- the very context growth the pipe was written to prevent.
 *
 * `faithful` is false when the view cannot be reconstructed from what reached
 * the hook: the tool's own 2000-line / 50KB budget may have dropped the region
 * the limiter reads (a `head` loses the head, a `grep -c` loses its matches),
 * and a program like `awk 'END{...}'` is not re-implementable here. In those
 * cases the view is the capture itself and the note points at it rather than
 * presenting a number that would be quietly wrong: `caveat` carries the reason
 * for callers that want to surface it, and `messages.ts` records why the note
 * itself currently leaves it to the body.
 */
export function applyLimiter(
    text: string,
    invocation: PipeInvocation,
    context: { truncated: boolean; totalLines: number | null }
): LimiterView {
    const { kind, limit } = invocation;
    const lines = splitLines(text);
    const total = context.totalLines ?? lines.length;
    // `head`, `grep -c`, and `sed -n` all read from the START of the output, so
    // they are only reproducible when nothing was dropped from the start.
    const lostHead = context.truncated;

    switch (kind) {
        case "tail": {
            const keep = limit ?? 10; // `tail`'s own default
            // A tail of a tail is a tail, so this is faithful even when the
            // capture is a truncated one.
            return {
                text: lines.slice(Math.max(0, lines.length - keep)).join("\n"),
                faithful: true,
                caveat: null,
            };
        }
        case "head": {
            // `head`/`tail` take the first/last lines of whatever reached them, so
            // an upstream filter does not break the reconstruction -- the view is
            // of the filtered capture, which is what the pipeline produced.
            if (lostHead) {
                return {
                    text,
                    faithful: false,
                    caveat: `your pipe asked for the first ${
                        limit ?? "few"
                    } lines, which the tool's own inline budget had already dropped`,
                };
            }
            const keep = limit ?? 10;
            return {
                text: lines.slice(0, keep).join("\n"),
                faithful: true,
                caveat: null,
            };
        }
        case "wc": {
            // `wc -l` counts its INPUT's lines. With no upstream stage the input is
            // the capture, so the tool's own total answers it exactly even after
            // the tool dropped lines. With an upstream stage (`grep -v`, `head`,
            // `sed`) the input is that stage's output, which is neither the
            // capture nor its line count -- so reporting `totalLines` here would
            // invent a number. `seq 1 100 | grep -v 5 | wc -l` must answer 90 and
            // the capture cannot say so.
            if (invocation.hasUpstreamStage) {
                return {
                    text,
                    faithful: false,
                    caveat: "your pipe counted lines after an earlier stage filtered them, which the captured output no longer represents; the count is not shown",
                };
            }
            return { text: String(total), faithful: true, caveat: null };
        }
        case "grep":
        case "rg": {
            if (invocation.hasUpstreamStage) {
                // Same reason as `wc`: the pattern is matched against the
                // capture, but the agent's pipeline matched it against whatever
                // the previous stage emitted.
                return {
                    text,
                    faithful: false,
                    caveat: "your pipe counted matches after an earlier stage filtered them, which the captured output no longer represents; the count is not shown",
                };
            }
            if (lostHead) {
                return {
                    text,
                    faithful: false,
                    caveat: "your pipe counted matches across the whole output, and the tool's inline budget had already dropped part of it, so the count below is a lower bound",
                };
            }
            const matches = lines.filter((line) =>
                grepPattern(invocation).test(line)
            ).length;
            return { text: String(matches), faithful: true, caveat: null };
        }
        case "sed": {
            if (invocation.hasUpstreamStage) {
                return {
                    text,
                    faithful: false,
                    caveat: "your pipe selected a line range after an earlier stage filtered them, which the captured output no longer represents",
                };
            }
            if (lostHead || limit === null) {
                return {
                    text,
                    faithful: false,
                    caveat: lostHead
                        ? "your pipe selected a line range from output the tool's inline budget had already dropped"
                        : "your pipe selected a line range that could not be reproduced from the capture",
                };
            }
            return {
                text: lines.slice(0, limit).join("\n"),
                faithful: true,
                caveat: null,
            };
        }
        default: {
            // `awk` programs are arbitrary; re-running the agent's program over
            // the capture is not something this module should guess at.
            return {
                text,
                faithful: false,
                caveat: "your pipe ran an awk program, which is applied to the command rather than to the result, so the full output is shown here",
            };
        }
    }
}

/** The pattern a counting grep filters on, or a never-matching pattern. */
function grepPattern(invocation: PipeInvocation): RegExp {
    const args = invocation.args ?? "";
    // Drop the flags, then take the first non-flag token as the pattern.
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const first = tokens.find((token) => !token.startsWith("-"));
    if (!first) return /(?!)/;
    const unquoted = first.replace(/^['"]|['"]$/g, "");
    // `-E` alternation is the common form; treat `\|` as alternation either way.
    const body = unquoted.replace(/\\\|/g, "|");
    try {
        return new RegExp(body);
    } catch {
        return /(?!)/;
    }
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
        stageZero: null,
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
function hasHeredocOperator(command: string): boolean {
    let quote = "";
    let escaped = false;
    for (let i = 0; i < command.length - 1; i += 1) {
        const ch = command[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
            // Any heredoc operator at top level disqualifies the command, and the
            // delimiter's spelling is deliberately NOT inspected. Enumerating
            // forms missed real ones: `<<\EOF` is a heredoc whose delimiter is
            // backslash-escaped (the escape suppresses expansion, so it is the
            // form a careful writer reaches for), and `<<$'EOF'` uses ANSI-C
            // quoting. `<<\EOF` was being preserved only incidentally -- its
            // body's pipe happened to sit outside the last segment -- so the
            // same command without a trailing statement was rewritable. A
            // false positive costs one skipped rewrite; a false negative
            // splices a tee into text destined for a file and can lose the
            // write entirely. `$((x << 2))` is the one false positive this
            // trades for, and skipping it is harmless.
            return true;
        }
    }
    return false;
}

function planPipeNerfCore(
    command: string,
    options: PipeOptions = {}
): PipePlan {
    if (hasHeredocOperator(command)) return skipped(command, "heredoc");

    // A compound call has more than one independently filtered stream. Removing
    // one limiter and applying its view to the concatenated result would delete
    // the other answer (or apply it to the wrong segment). Keep every limiter in
    // the shell and tee each pipeline's stage 0 into the shared per-call capture;
    // the shell's result is then already the exact view for every segment.
    const segments = splitControlSegments(command);
    if (segments.length > 1) {
        const invocations = segments.map((segment) =>
            findPipeInvocation(segment.text)
        );
        const filteredSegments = invocations
            .map((invocation, index) => ({ invocation, index }))
            .filter((item) => item.invocation !== null);
        const pipelineCount = segments.filter(
            (segment) => lastPipeOperator(segment.text) >= 0
        ).length;
        if (filteredSegments.length > 0 && pipelineCount > 1) {
            const invocation = filteredSegments[0].invocation!;
            if (options.enabled === false || !options.stageZeroPath) {
                return skipped(command, "no-pipe", invocation);
            }
            if (TRAILING_COMMENT_RE.test(command)) {
                return skipped(command, "limiter-in-comment", invocation);
            }
            let offset = 0;
            let firstOperatorAt: number | null = null;
            const rewrittenSegments = segments.map((segment, index) => {
                const currentOffset = offset;
                offset += segment.text.length + segment.separator.length;
                const current = invocations[index];
                if (!current) return segment;
                const pipeAt = firstPipeOperator(segment.text);
                if (
                    pipeAt < 0 ||
                    /\|&/.test(segment.text) ||
                    (current.kind === "tail" &&
                        /(?:^|\s)-[A-Za-z]*f(?:\s|$)/.test(current.args))
                ) {
                    return null;
                }
                const before = segment.text
                    .slice(0, pipeAt)
                    .replace(/\s+$/, "");
                const after = segment.text
                    .slice(pipeAt + 1)
                    .replace(/^\s+/, "");
                const text = `${before} | ${stageZeroCaptureCommand(options.stageZeroPath!)} | ${after}`;
                if (firstOperatorAt === null) {
                    firstOperatorAt = currentOffset + pipeAt;
                }
                return { ...segment, text };
            });
            if (rewrittenSegments.some((segment) => segment === null)) {
                return skipped(command, "no-pipe", invocation);
            }
            const rawRewritten = rewrittenSegments
                .map((segment) => `${segment!.text}${segment!.separator}`)
                .join("");
            const exitCapture = instrumentPipelineExits(
                rawRewritten,
                options.stageZeroPath
            );
            const rewritten = exitCapture.command;
            const stageZeroSegments = segments.map((segment, index) => ({
                command: segment.text.trim(),
                separator: segment.separator,
                captured: Boolean(invocations[index]),
            }));
            const segmentLabel = stageZeroSegments
                .map(
                    (segment, index) =>
                        `(${index + 1}) ${JSON.stringify(segment.command)}${segment.captured ? " [stage-0 captured]" : " [not captured]"}${segment.separator ? ` [then ${segment.separator}]` : ""}`
                )
                .join("; ");
            const firstCapture =
                firstOperatorAt === null
                    ? null
                    : {
                          path: options.stageZeroPath,
                          command: `Compound stage-0 capture: ${segmentLabel}`,
                          operatorAt: firstOperatorAt,
                      };
            return {
                action: "rewrite",
                reason: null,
                original: command,
                invocation,
                rewritten,
                stageZero: firstCapture,
                preserveLimiterViews: true,
                stageZeroSegments,
                stageExitPath: exitCapture.exitPath,
                pipelineExitCommands: exitCapture.stages,
            };
        }
    }

    const at = lastPipeOperator(command);
    if (at < 0) return skipped(command, "no-pipe");

    // A limiter only bounds the tool's output if it ends the command. In
    // `a | tail -5; b` the limiter's output is interleaved with b's, so
    // removing it would change b's context too. Reported separately from
    // `no-pipe`: the command DOES pipe, and a reader comparing the two reasons
    // needs to be able to tell "no pipe" from "a pipe that is not the last word".
    // A `;` or newline after the limiter only separates statements, so the
    // limiter can still be removed. An `&&` or `||` chains on the stage's exit
    // status, and removing the stage changes what runs.
    const control = lastControlOperator(command);
    if (control.at > at && control.statusBearing) {
        return skipped(command, "status-bearing-operator");
    }
    // A limiter before the final `;`/newline does not determine the command's
    // last output. Never rewrite an earlier statement just because it has the
    // command's last pipe.
    if (control.at > at && !control.statusBearing) {
        const segment = segmentNumberAt(command, at);
        return skipped(command, `pipe-outside-scope:segment-${segment}`);
    }

    const invocation = findPipeInvocation(command);
    if (!invocation) return skipped(command, "no-pipe");

    if (options.enabled === false)
        return skipped(command, "disabled", invocation);

    // A limiter inside a trailing comment is prose, not a bound.
    if (TRAILING_COMMENT_RE.test(command))
        return skipped(command, "limiter-in-comment", invocation);

    // Trim ONCE and slice that same string; see `findPipeInvocation`.
    const stage = command
        .slice(invocation.stageStart)
        .trimStart()
        .replace(/^&/, "")
        .trimStart();
    const args = boundedArgs(stage, (programName(stage) ?? "").length);

    // `findPipeInvocation` already gated on `stageBindsOutput`, so reaching here
    // with a non-binding stage is a parser invariant break, not a user case.
    if (!stageBindsOutput(invocation.kind, args)) {
        return skipped(command, "no-pipe", invocation);
    }

    // `| tail -f` / `| head -n -5` follow the input rather than bounding it, so
    // removing them would hand the tool a command that never returns. `-f` on
    // `tail` is the whole point of that flag.
    if (
        invocation.kind === "tail" &&
        /(?:^|\s)-[A-Za-z]*f(?:\s|$)/.test(args)
    ) {
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
    if (!/\S/.test(before))
        return skipped(command, "empty-command", invocation);

    // The rewrite removes the limiter's OWN segment and keeps everything around
    // it. `seq 1 50 | tail -3; echo done` must become `seq 1 50; echo done`:
    // dropping only the stage text would leave a dangling `|`, and dropping
    // everything after the segment would delete `echo done` along with it.
    const segmentEnd = lastControlOperator(command.slice(invocation.start)).at;
    const stageEnd =
        segmentEnd < 0 ? command.length : invocation.start + segmentEnd;
    const beforeSegment = command
        .slice(0, invocation.start)
        .replace(/\s+$/, "");
    const afterSegment = command.slice(stageEnd);
    // A separator must not be swallowed: `a && | tail -5` is not a command, and
    // `a; | tail -5` would become `a;` with nothing to run.
    if (/[;&|]\s*$/.test(beforeSegment)) {
        return skipped(command, "empty-command", invocation);
    }
    if (!/\S/.test(beforeSegment))
        return skipped(command, "empty-command", invocation);

    // Rejoin without swallowing or inventing a separator: the text after the
    // segment starts with its own operator (`; echo done`) or is a newline.
    const separator = /^[\s]*[;&|]/.test(afterSegment) ? "" : " ";
    const rewritten =
        afterSegment.trim().length === 0
            ? beforeSegment
            : `${beforeSegment}${separator}${afterSegment.replace(/^\s+/, "")}`;

    // Stage 0's output is what a re-filter would want, and it is NOT recoverable
    // if the command still filters after the limiter is hoisted: the capture is
    // the filtered output, so a different grep cannot be run against it. Tee it
    // at the first operator. `tee` writes the stage's output to the file AND
    // passes it on, so the pipeline's result and exit status are unchanged
    // (verified byte-for-byte and by status against a real shell).
    //
    // Only when a pipeline REMAINS. If the rewrite left a single command, its
    // whole output is already the capture and a second file duplicates it -- and
    // would double the sidecar sources for every piped call.
    let stageZero: PipePlan["stageZero"] = null;
    if (options.stageZeroPath) {
        const operatorAt = firstPipeOperator(rewritten);
        if (operatorAt > 0) {
            const command0 = rewritten.slice(0, operatorAt).trim();
            // Storage is auxiliary: if the path cannot be used, run the command
            // unchanged rather than fail the call the agent asked for.
            stageZero = {
                path: options.stageZeroPath,
                command: command0,
                operatorAt,
            };
        }
    }
    // The seam is normalized to one space either side. `rewritten` can carry the
    // whitespace of the removed limiter (`ls  | grep`), and an unnormalized join
    // is what produced `ls  | tee /tmp/x | grep`.
    // `<stage-0> | tee <path> | <rest>`: the two pipe operators come back, one on
    // each side of the tee. `rewritten.slice(0, operatorAt)` deliberately EXCLUDES
    // the operator it was measured at, so both `|` are added here.
    const final = stageZero
        ? [
              rewritten.slice(0, stageZero.operatorAt).replace(/\s+$/, ""),
              `| ${stageZeroCaptureCommand(stageZero.path)}`,
              "|",
              rewritten.slice(stageZero.operatorAt + 1).replace(/^\s+/, ""),
          ].join(" ")
        : rewritten;
    const exitCapture = stageZero
        ? instrumentPipelineExits(final, stageZero.path)
        : null;

    return {
        action: "rewrite",
        reason: null,
        original: command,
        invocation,
        rewritten: (exitCapture?.command ?? final).trim(),
        stageZero,
        ...(exitCapture
            ? {
                  stageExitPath: exitCapture.exitPath,
                  pipelineExitCommands: exitCapture.stages,
              }
            : {}),
    };
}

export function planPipeNerf(
    command: string,
    options: PipeOptions = {}
): PipePlan {
    const plan = planPipeNerfCore(command, options);
    const directory = options.stageZeroDirectory;
    if (plan.action === "rewrite" && directory && command.includes(directory)) {
        return {
            ...skipped(command, "capture-directory-reference", plan.invocation),
            captureDirectory: directory,
        };
    }
    return plan;
}
