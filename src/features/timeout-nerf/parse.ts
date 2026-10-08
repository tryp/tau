/** A flag standing between `timeout` and its duration. */
export interface TimeoutFlag {
    /** The flag's name: `-k`, `--signal` (an attached value is split off). */
    name: string;
    /** Its value (`5s`, `KILL`), or null when the flag takes none. */
    value: string | null;
}

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
    /** The flags the invocation carries, in order (`-k`, `--foreground`). */
    flags: TimeoutFlag[];
}

/**
 * Resolve the FIRST resolvable `timeout` invocation, or null.
 *
 * This mirrors `session_analysis.timeout_usage.timeout_invocation`, which counts
 * the habit and therefore stays permissive about flags. The rewrite guards in
 * `planNerf` are deliberately stricter than the oracle: recognising a form as a
 * `timeout` call and being willing to rewrite it are separate decisions.
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
            flags: resolved.flags,
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
// GNU `timeout`'s option set, matching the wrapper pattern upstream uses in
// `features/permissions/bash.ts`. Only these may precede the duration: an
// unrecognised flag makes `timeout` itself fail (`timeout -x 300 cmd` exits 125
// with "invalid option"), so the command never ran and stripping the wrapper
// would convert that failure into a success.
const BOOLEAN_FLAGS = new Set([
    "-v",
    "--verbose",
    "--foreground",
    "--preserve-status",
]);
const ARG_FLAGS = new Set(["-k", "--kill-after", "-s", "--signal"]);
// `-k5s` / `-sKILL`: the value rides on the flag token instead of following it.
const ATTACHED_ARG_FLAG_RE = /^-[ks][A-Za-z0-9_.+-]+$/;
// `-s`/`--signal` is validated by NAME. GNU resolves a name through `str2sig`,
// case-insensitively and with or without the `SIG` prefix, so the POSIX set is
// safe on every libc; the Linux-only names (`POLL`, `STKFLT`, `PWR`, `IOT`,
// `CLD`) are left out, because refusing one costs a rewrite while accepting one
// a libc lacks would run a command GNU rejected. A NUMBER is refused outright,
// because GNU's acceptance of one follows no rule a rewrite can rely on:
// measured on coreutils 9.10, `-s 0` through `-s 64` are accepted but `-s 65`
// through `-s 127` are not, `-s 128` through `-s 192` are accepted again, and
// values at or above 2^32 are refused whatever their low bits are. So `-s 9`
// and `-s 15` are refused although GNU accepts them, and no numeric bound would
// be right. RT forms are accepted bare, never with an offset, because the
// offset's bound is the libc's RT range (measured: `RTMIN+30` accepted,
// `RTMIN+31` and `RTMAX+1` rejected). Measured corpus usage: 160 invocations
// carry a signal flag and their values are `TERM` (155) and `INT` (5), both in
// the set; no numeric or unknown-name value appears at all. So validating names
// preserves every real signal rewrite while still refusing what GNU rejects.
const SIGNAL_FLAGS = new Set(["-s", "--signal"]);
const SIGNAL_NAMES = new Set([
    "HUP",
    "INT",
    "QUIT",
    "ILL",
    "TRAP",
    "ABRT",
    "BUS",
    "FPE",
    "KILL",
    "USR1",
    "SEGV",
    "USR2",
    "PIPE",
    "ALRM",
    "TERM",
    "CHLD",
    "CONT",
    "STOP",
    "TSTP",
    "TTIN",
    "TTOU",
    "URG",
    "XCPU",
    "XFSZ",
    "VTALRM",
    "PROF",
    "WINCH",
    "SYS",
]);
const REALTIME_SIGNAL_RE = /^(?:SIG)?RT(?:MIN|MAX)$/;

/** Whether GNU `timeout` itself would accept this `-s`/`--signal` value. */
function isGnuSignal(value: string): boolean {
    const upper = value.toUpperCase();
    return (
        SIGNAL_NAMES.has(upper.replace(/^SIG/, "")) ||
        REALTIME_SIGNAL_RE.test(upper)
    );
}
// GNU accepts a decimal number with at most one LOWERCASE unit suffix, and
// rejects an uppercase one: `timeout 5S true` exits 125 ("invalid time
// interval '5S'"). Measured as accepted: `5`, `5s`, `1.5h`, `.5s`, `+5s`,
// `5.`, `05s`, `1e3`. Measured as rejected: `5S`, `5ss`, `5s5`, ``. `-k` takes
// the same grammar, so it is validated by the same rule.
const GNU_DURATION_RE = /^\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[smhd]?$/;

/** Whether GNU `timeout` itself would accept this duration token. */
function isGnuDuration(token: string): boolean {
    return GNU_DURATION_RE.test(token);
}

/**
 * Whether the invocation carries a flag GNU `timeout` accepts before its
 * duration, with a value GNU would accept for that flag.
 *
 * Both halves matter for the same reason: `timeout -x 300 cmd` and
 * `timeout -k foo 300 cmd` each make `timeout` itself exit 125 before the
 * command runs, so stripping the wrapper would convert a failure into a
 * success. A flag GNU would have accepted is stripped as usual.
 */
function isKnownTimeoutFlag(flag: TimeoutFlag): boolean {
    if (flag.name === "--") return flag.value === null;
    if (BOOLEAN_FLAGS.has(flag.name)) return flag.value === null;
    if (flag.name === "-k" || flag.name === "--kill-after") {
        // `-k`'s value is a time interval, so the same rule as the bound applies:
        // GNU rejects `-k 5S` exactly as it rejects `5S`.
        return flag.value !== null && isGnuDuration(flag.value);
    }
    // `-s`/`--signal` values are validated by the caller (see SIGNAL_FLAGS);
    // reaching here means the value resolved, so the flag is accepted. Anything
    // else is a flag GNU itself would have rejected.
    if (SIGNAL_FLAGS.has(flag.name)) return true;
    return false;
}
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
    /** The flags between `timeout` and the duration, in order. */
    flags: TimeoutFlag[];
}

/** Mirrors the Python oracle's whitespace/token/flag walking exactly. */
function resolvePrefix(rest: string): ResolvedPrefix | null {
    let position = 0;
    const flags: TimeoutFlag[] = [];
    while (position < rest.length) {
        while (position < rest.length && /\s/.test(rest[position])) position++;
        let end = position;
        while (end < rest.length && !/\s/.test(rest[end])) end++;
        if (position === end) return null;

        const token = rest.slice(position, end);
        if (token.startsWith("-")) {
            // Split the name from an attached value (`--signal=TERM`, `-k5s`) so
            // the guard can check the value against the flag it belongs to. Only
            // a LONG option may carry its value after `=`: GNU getopt hands a
            // short option the whole remainder, so `-s=TERM` is the value `=TERM`
            // (GNU exits 125, "invalid signal") and splitting it would rewrite a
            // command that never ran. `-s=TERM` and `-k=5s` then fall through to
            // the flag check as unknown flags and are refused there.
            const equalAt = token.startsWith("--") ? token.indexOf("=") : -1;
            const attached =
                equalAt === -1 ? ATTACHED_ARG_FLAG_RE.exec(token) : null;
            const name =
                equalAt !== -1
                    ? token.slice(0, equalAt)
                    : attached
                      ? token.slice(0, 2)
                      : token;
            let value =
                equalAt !== -1
                    ? token.slice(equalAt + 1)
                    : attached
                      ? token.slice(2)
                      : null;
            position = end;
            if (ARG_FLAGS.has(name) && value === null) {
                // `-k 5s`: the value is the next token.
                while (position < rest.length && /\s/.test(rest[position]))
                    position++;
                let valueEnd = position;
                while (valueEnd < rest.length && !/\s/.test(rest[valueEnd]))
                    valueEnd++;
                if (valueEnd === position) return null;
                value = rest.slice(position, valueEnd);
                position = valueEnd;
            }
            flags.push({ name, value });
            continue;
        }

        const cleaned = token.replace(/^[;|&()<>]+|[;|&()<>]+$/g, "");
        const seconds = parseDurationSeconds(cleaned);
        if (seconds === null) return null;
        return { token: cleaned, seconds, offset: end, flags };
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
    | "unknown-flag"
    | "line-break"
    | "non-gnu-duration"
    | "not-a-command"
    | "signal-value"
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
    ":",
    ".",
    "alias",
    "bg",
    "bind",
    "break",
    "builtin",
    "caller",
    "cd",
    "command",
    "compgen",
    "complete",
    "compopt",
    "continue",
    "coproc",
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
    "time",
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
// Heads that are bash syntax rather than a program name.
const CONSTRUCT_HEAD_RE = /^(?:\{|\[\[|\]\]|!)$/;

/**
 * Whether a head word can vanish entirely.
 *
 * An UNQUOTED expansion-only head (`${CMD}`, `$CMD`, `$(which make)`) expands to
 * nothing when the value is empty, which leaves the original a commandless
 * wrapper: measured, `timeout 300 ${UNSET}` exits 125 while the rewrite
 * `${UNSET}` exits 0. A quoted expansion or one with literal text is different
 * -- `timeout 300 "$UNSET"`, `"$UNSET"/x` and `$UNSET/x` all exit 127, the same
 * as their rewrites, because the empty result is still an argument -- so those
 * are left alone rather than refused.
 */
function headCanVanish(word: string): boolean {
    // Strip the expansions FIRST: a quote inside one does not make the word
    // unable to vanish. `timeout 300 ${UNSET:+"x"}` and `timeout 300
    // $(echo"")` both exit 125 (measured) while their rewrites exit 0, because
    // the whole expansion disappears -- quotes included -- when it expands to
    // nothing.
    const withoutExpansions = word
        .replace(/\$\{[^}]*\}/g, "")
        .replace(/\$\([^()]*\)/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "")
        .replace(/\$[0-9@*#?$!-]/g, "");
    // A quote OUTSIDE an expansion leaves an empty argument behind, which fails
    // the same way in both forms (measured 127/127), so the word is kept.
    if (/["']/.test(withoutExpansions)) return false;
    return withoutExpansions.trim() === "";
}

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
    // The flags and the duration must sit on the same line as `timeout`: a line
    // break is a command separator in bash, so a prefix that crossed one belongs
    // to a different command than the text following it. Upstream guards the
    // same boundary with `[ \t]+` rather than `\s+` in
    // `features/permissions/bash.ts`. This is checked here rather than inside
    // `resolvePrefix` so that recognition stays permissive for the habit-counting
    // oracle while the rewrite refuses a form whose bound cannot be trusted.
    if (/[\r\n]/.test(command.slice(invocation.start, invocation.end))) {
        return skipped(command, "line-break", invocation);
    }
    // The bound must be one GNU itself would accept. `parseDurationSeconds`
    // above is deliberately permissive because it also mirrors the habit-counting
    // oracle, which lowercases the unit; GNU does not. `timeout 5S true` exits 125
    // ("invalid time interval '5S'") without running `true`, so stripping that
    // wrapper would turn a command that never ran into one that runs. Measured
    // corpus cost: 0 -- the uppercase forms appear only in this project's own
    // transcripts. The guard is kept because the two parsers disagree by design,
    // not because a session needed it.
    if (!isGnuDuration(invocation.token)) {
        return skipped(command, "non-gnu-duration", invocation);
    }
    // The text after the prefix must start a command. A newline separates
    // commands, and a leading operator or redirection means the prefix is not a
    // prefix: `timeout 300 && make` and `timeout 300 | cat` become `&& make` and
    // `| cat`, which bash rejects with a syntax error (measured: the `|` form
    // turns the original's exit 0 into exit 2), `timeout 300 > f` becomes `> f`,
    // which creates an empty file where the original exited 125, and
    // `timeout 300 2>&1 make` becomes something that runs where the original did
    // not. All of those predate this change and are the same class: there is no
    // command after the prefix, so there is nothing safe to strip. A backslash
    // continuation is not a separator, so `timeout 300 \` + newline + `make`
    // stays eligible. Measured corpus cost: 0 -- of 69,158 rewrites on the
    // filtered 30d corpus (2,723 files), none began with a control operator, a
    // redirection, a construct opener, or a quoted or expanded head -- so these
    // guards too are correctness-only, not something a session needed.
    const tailText = command.slice(invocation.end);
    if (/^[ \t]*[0-9]*[;&|<>()\r\n]/.test(tailText)) {
        return skipped(command, "not-a-command", invocation);
    }
    // The head has to be able to name a program. A construct opener is bash
    // syntax rather than a program, and a head that vanishes leaves a commandless
    // wrapper behind (see headCanVanish). Both measured as conversions:
    // `timeout 300 { make; }` is 2 -> 0 and `timeout 300 ${UNSET}` is 125 -> 0.
    // A vanishing head is only dangerous when nothing can take its place, so a
    // later plain word keeps the rewrite: `timeout 300 $CMD make` and `timeout
    // 300 $PY script.py` run the same thing either way (measured 0 -> 0), because
    // an empty head simply leaves the next word as the command. A redirection is
    // not a command, nor is the word after one, so `$CMD > f` and `$CMD 2>&1`
    // are still refused. Trailing separators are stripped first, so `timeout 300
    // true; echo hi` is left alone (measured 0 -> 0). A builtin with no external
    // counterpart (`command`, `time`, `cd`) is caught below by
    // SHELL_ONLY_BUILTINS instead.
    const tailWords = tailText.trim().split(/\s+/);
    const headWord = (tailWords[0] ?? "").replace(/^[;&|]+|[;&|]+$/g, "");
    // A token split inside a substitution -- `$(which make)` contains a space, so
    // the head token is only `$(which` -- is not the whole head and cannot be
    // judged; it is refused rather than guessed at.
    const headIsSplitSubstitution = /\$\([^()]*$|`[^`]*$/.test(headWord);
    const rest = tailWords.slice(1);
    // A standby word has to be able to name the program itself: a word that can
    // vanish too (`$UNSET $UNSET2`) leaves the command empty in the rewrite while
    // the original was a commandless wrapper (measured 125 -> 0).
    const hasStandbyCommand = rest.some(
        (word, index) =>
            !/[;&|<>]/.test(word) &&
            !/[;&|<>]$/.test(
                index === 0 ? headWord : (rest[index - 1] ?? "")
            ) &&
            !headCanVanish(word)
    );
    if (
        headWord !== "" &&
        (CONSTRUCT_HEAD_RE.test(headWord) ||
            headIsSplitSubstitution ||
            (headCanVanish(headWord) && !hasStandbyCommand))
    ) {
        return skipped(command, "not-a-command", invocation);
    }
    // A signal flag's value has to be one GNU resolves. A number cannot be
    // checked at all (see SIGNAL_NAMES), and an unknown name makes GNU exit 125
    // before the command runs, so both are refused here rather than falling
    // through to the generic flag check, which would report the flag rather
    // than the value that failed.
    if (
        invocation.flags.some(
            (flag) =>
                SIGNAL_FLAGS.has(flag.name) && !isGnuSignal(flag.value ?? "")
        )
    ) {
        return skipped(command, "signal-value", invocation);
    }
    // Recognising only the flags upstream recognises keeps a command that could
    // never have run from being rewritten into one that does.
    if (invocation.flags.some((flag) => !isKnownTimeoutFlag(flag))) {
        return skipped(command, "unknown-flag", invocation);
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
