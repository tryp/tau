/** A resolved shell `timeout` invocation inside a bash command string. */
export interface TimeoutInvocation {
    /** Duration as written: "300", "90s", "1.5h", "2h30m". */
    token: string;
    /** Parsed seconds, or null when the token is not a resolvable duration. */
    seconds: number | null;
    /** Start index of the whole `timeout <flags> <duration>` prefix. */
    start: number;
    /** Index just past that prefix. */
    end: number;
}

/**
 * Resolve the FIRST resolvable `timeout` invocation, or null.
 *
 * This mirrors `session_analysis.timeout_usage.timeout_invocation`.
 */
export function findTimeoutInvocation(
    command: string
): TimeoutInvocation | null {
    const invocationPattern = /(?<![\w.-])(?:[\w./~$-]+\/)?timeout(?=\s)/g;
    for (const match of command.matchAll(invocationPattern)) {
        const start = match.index;
        const afterName = start + match[0].length;
        const resolved = resolvePrefix(
            command.slice(afterName, afterName + 200)
        );
        if (!resolved) continue;
        return {
            token: resolved.token,
            seconds: resolved.seconds,
            start,
            end: afterName + resolved.offset,
        };
    }
    return null;
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
    "": 1,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
};
const ARG_FLAGS = new Set(["-k", "--kill-after", "-s", "--signal"]);
// GNU `timeout` accepts one number with at most ONE unit suffix: "300", "90s",
// "1.5h". A compound token such as "2h30m" is rejected outright
// (`timeout: invalid time interval`, exit 125), so accepting it here would
// rewrite a command that FAILS into one that runs.
const DURATION_RE = /^(\d+(?:\.\d+)?)([smhd]?)$/;

/** Parse a GNU timeout duration token into seconds, or null if invalid. */
export function parseDurationSeconds(text: string): number | null {
    const match = DURATION_RE.exec(text.trim().toLowerCase());
    if (!match) return null;
    const unit = match[2] ?? "";
    return Number(match[1]) * DURATION_UNIT_SECONDS[unit];
}

interface ResolvedPrefix {
    token: string;
    seconds: number;
    offset: number;
}

/** Mirrors the Python oracle's whitespace/token/flag walking exactly. */
function resolvePrefix(rest: string): ResolvedPrefix | null {
    let position = 0;
    while (position < rest.length) {
        while (position < rest.length && /\s/.test(rest[position])) position++;
        let end = position;
        while (end < rest.length && !/\s/.test(rest[end])) end++;
        if (position === end) return null;

        const token = rest.slice(position, end);
        if (token.startsWith("-")) {
            position = end;
            const equalAt = token.indexOf("=");
            const flagName = equalAt === -1 ? token : token.slice(0, equalAt);
            if (ARG_FLAGS.has(flagName) && equalAt === -1) {
                while (position < rest.length && /\s/.test(rest[position]))
                    position++;
                while (position < rest.length && !/\s/.test(rest[position]))
                    position++;
            }
            continue;
        }

        const cleaned = token.replace(/^[;|&()<>]+|[;|&()<>]+$/g, "");
        const seconds = parseDurationSeconds(cleaned);
        if (seconds === null) return null;
        return { token: cleaned, seconds, offset: end };
    }
    return null;
}

export type SkipReason =
    | "no-invocation"
    | "no-duration"
    | "no-bound"
    | "no-command"
    | "not-leading"
    | "self-backgrounded"
    | "network-client"
    | "shell-builtin"
    | "tool-timeout-set"
    | "disabled";

export interface NerfPlan {
    action: "rewrite" | "skip";
    reason: SkipReason | null;
    original: string;
    invocation: TimeoutInvocation | null;
    rewritten: string;
    cwd: string | null;
    wrappedCommand: string;
}

export interface NerfOptions {
    enabled?: boolean;
    defaultBudgetMs?: number;
    toolTimeoutSeconds?: number;
    /**
     * Whether a `cd` prologue may be lifted into the tool's `cwd`. Defaults to
     * true. A caller that can inspect the filesystem sets this to false when the
     * directory is reachable only through a symlink, because the tool sets the
     * process working directory (so the shell reports the PHYSICAL path) while a
     * shell `cd` sets the LOGICAL one.
     */
    liftCwd?: boolean;
}

const ANY_INVOCATION_RE = /(?<![\w.-])(?:[\w./~$-]+\/)?timeout(?=\s)/;
// The separator is captured because only `&&` may be lifted; see `planNerf`.
const CD_PROLOGUE_RE = /^\s*cd\s+(.+?)\s*(&&|;)\s*$/s;
// A directory is safe to lift into the tool's `cwd` only when the tool's path
// resolution would land in the same place the shell's `cd` did. The tool
// resolves a per-call cwd with a plain `path.resolve` (no shell expansion), so
// `~`, `$VAR`, backticks and globs would resolve to a literal relative path
// under the session cwd and run the command in the WRONG directory. Quoting
// only buys whitespace: the quotes are consumed by the shell, not the tool.
const PLAIN_UNQUOTED_DIR_RE = /^[^\s'"$`*?[\]~\\]+$/;
const PLAIN_QUOTED_DIR_RE = /^[^$`*?[\]~\\]*$/;
const QUOTED_DIR_RE = /^(?:"([^"]*)"|'([^']*)')$/s;
// Exclude `2>&1`, `>&2`, and `&>` redirections; they are not background jobs.
// A quoted `&` can still match; that only conservatively skips a rewrite.
const BACKGROUND_OPERATOR_RE = /(^|[^&>])&(?![&>])/;
const SELF_BACKGROUND_COMMAND_RE =
    /(?:^|[\s;&|])(?:[^\s;&|]+\/)?(?:nohup|setsid|disown)(?=\s|$)/i;
const NETWORK_CLIENT_RE = /\b(?:curl|wget|nc|ssh)\b/i;

// `timeout` execs its command, so a shell builtin with no external counterpart
// cannot run under it at all: `timeout 300 cd /tmp` exits 127 with "failed to
// run command 'cd'". Stripping the wrapper would turn that failure into a
// success, so such targets are left alone. Builtins that DO have an external
// counterpart (pwd, echo, true, false, test, printf, kill) are deliberately
// absent: `timeout` runs them and the result matches. Measured at 0 of the 173
// sampled corpus commands, but the class is real and the guard is free.
const SHELL_ONLY_BUILTINS = new Set([
    ".",
    "alias",
    "bg",
    "bind",
    "builtin",
    "caller",
    "cd",
    "compgen",
    "complete",
    "compopt",
    "declare",
    "dirs",
    "disown",
    "enable",
    "eval",
    "exec",
    "exit",
    "export",
    "fc",
    "fg",
    "getopts",
    "hash",
    "help",
    "history",
    "jobs",
    "let",
    "local",
    "logout",
    "mapfile",
    "popd",
    "pushd",
    "read",
    "readarray",
    "readonly",
    "return",
    "set",
    "shift",
    "shopt",
    "source",
    "suspend",
    "times",
    "trap",
    "type",
    "typeset",
    "ulimit",
    "umask",
    "unalias",
    "unset",
    "wait",
]);
// The first bare word of a command, used only to spot such a target.
const FIRST_WORD_RE = /^[^\s;&|<>()]+/;

function skipped(
    command: string,
    reason: SkipReason,
    invocation: TimeoutInvocation | null,
    wrappedCommand = command
): NerfPlan {
    return {
        action: "skip",
        reason,
        original: command,
        invocation,
        rewritten: command,
        cwd: null,
        wrappedCommand,
    };
}

/**
 * Decide whether to strip a leading shell timeout wrapper. This deliberately
 * only rewrites a command whose timeout is its first command (optionally
 * preceded by a simple `cd DIR &&` or `cd DIR;` prologue).
 */
export function planNerf(command: string, options: NerfOptions = {}): NerfPlan {
    const invocation = findTimeoutInvocation(command);
    if (!invocation) {
        return skipped(
            command,
            ANY_INVOCATION_RE.test(command) ? "no-duration" : "no-invocation",
            null
        );
    }
    if (options.enabled === false)
        return skipped(command, "disabled", invocation);
    if (
        options.toolTimeoutSeconds !== undefined &&
        options.toolTimeoutSeconds !== null
    ) {
        return skipped(command, "tool-timeout-set", invocation);
    }
    // A duration of 0 DISABLES the shell's timeout rather than killing at once,
    // so the wrapper applies no bound to translate. Stripping it would still be
    // equivalent, but the note could not honestly claim a kill was removed, so
    // the wrapper is left alone instead.
    if (invocation.seconds === 0) {
        return skipped(command, "no-bound", invocation);
    }

    // A prologue is either empty or a `cd ... &&` / `cd ... ;` prefix. Anything
    // else means the `timeout` is not the command's first command, so the
    // command is left alone rather than guessing which segment it bounded.
    const beforeInvocation = command.slice(0, invocation.start);
    let cwd: string | null = null;
    // Index the rewrite copies from: the whole prologue when it is kept, or the
    // invocation start when the prologue has been lifted into `cwd`.
    let removeBefore = 0;
    if (/^\s*$/.test(beforeInvocation)) {
        removeBefore = beforeInvocation.length;
    } else {
        const cdMatch = CD_PROLOGUE_RE.exec(beforeInvocation);
        if (!cdMatch) return skipped(command, "not-leading", invocation);
        // Only `&&` may be lifted into `cwd`. `&&` short-circuits, so a `cd`
        // that fails also skips the rest of the command, which a lifted cwd
        // reproduces. After `;` the rest runs in the ORIGINAL directory even
        // when the `cd` failed, and no `cwd` can reproduce that, so the
        // prologue is kept and only the timeout is stripped.
        if (cdMatch[2] === "&&" && options.liftCwd !== false) {
            const directory = plainDirectory(cdMatch[1]);
            if (directory !== null) {
                cwd = directory;
                removeBefore = beforeInvocation.length;
            }
        }
        // Otherwise the prologue is kept verbatim and only the timeout is
        // stripped, so shell-only path forms keep their own semantics.
    }

    const wrappedCommand = command.slice(invocation.end).trim();
    // GNU `timeout 300` with nothing to run exits 125; rewriting it to an empty
    // command would exit 0 instead, silently turning a failure into a success.
    // A leading `#` makes the remainder a comment, which the shell also treats
    // as no command at all, so both forms are left alone.
    if (wrappedCommand === "" || wrappedCommand.startsWith("#")) {
        return skipped(command, "no-command", invocation, wrappedCommand);
    }
    if (
        SELF_BACKGROUND_COMMAND_RE.test(wrappedCommand) ||
        BACKGROUND_OPERATOR_RE.test(wrappedCommand)
    ) {
        return skipped(
            command,
            "self-backgrounded",
            invocation,
            wrappedCommand
        );
    }
    if (NETWORK_CLIENT_RE.test(wrappedCommand)) {
        return skipped(command, "network-client", invocation, wrappedCommand);
    }
    const target = FIRST_WORD_RE.exec(wrappedCommand)?.[0] ?? "";
    if (SHELL_ONLY_BUILTINS.has(target)) {
        return skipped(command, "shell-builtin", invocation, wrappedCommand);
    }

    const head = command.slice(removeBefore, invocation.start);
    const tail = command.slice(invocation.end);
    return {
        action: "rewrite",
        reason: null,
        original: command,
        invocation,
        rewritten: joinSeam(head, tail),
        cwd,
        wrappedCommand,
    };
}

/**
 * Join the kept head to the tail, normalising only the seam's whitespace.
 *
 * A kept prologue ends in whitespace and the tail begins with whitespace, so a
 * plain concatenation would leave `cd /x &&  make`. Whitespace elsewhere in the
 * command must be preserved: collapsing it globally would rewrite the inside of
 * quoted strings and heredocs.
 */
function joinSeam(head: string, tail: string): string {
    if (head === "") return tail.trim();
    if (tail === "") return head.trim();
    return `${head.replace(/\s+$/, "")} ${tail.replace(/^\s+/, "")}`.trim();
}

/**
 * The directory to lift into `cwd`, or null when it must stay in the command.
 *
 * Returns the unquoted directory only when the tool's plain path resolution
 * would match what the shell `cd` did; see `PLAIN_UNQUOTED_DIR_RE`.
 */
function plainDirectory(raw: string): string | null {
    const trimmed = raw.trim();
    // `cd -` means `$OLDPWD` and `cd --` / `cd -P` are shell options. The tool
    // would resolve them as literal relative paths (or fail), so they must stay
    // in the command. Quoting does not help: `cd "-"` still means `$OLDPWD`,
    // because `cd` interprets the argument rather than the shell.
    if (trimmed.startsWith("-")) return null;
    const quoted = QUOTED_DIR_RE.exec(trimmed);
    if (quoted) {
        const inner = quoted[1] ?? quoted[2] ?? "";
        if (inner.startsWith("-")) return null;
        return inner && PLAIN_QUOTED_DIR_RE.test(inner) ? inner : null;
    }
    return PLAIN_UNQUOTED_DIR_RE.test(trimmed) ? trimmed : null;
}
