/**
 * Trigger predicates for cross-tool hints.
 *
 * A hint is only worth its tokens if (a) the cheaper alternative demonstrably
 * exists for this call, and (b) the agent is unlikely to find it on its own.
 * Each predicate below is therefore conservative: it declines whenever the
 * command could plausibly be doing something else, because a wrong hint costs
 * more than a missing one -- the agent has to first decide the hint does not
 * apply.
 *
 * Everything here is a pure function of the tool name, its input, and the
 * result text, so each rule is testable without a host.
 */

/** A `bash` command that views an explicit line range of one file. */
export interface SedRangeView {
    path: string;
    start: number;
    end: number;
}

const SED_RANGE =
    /^\s*sed\s+-n\s+(?:-e\s+)?(['"]?)(\d+)\s*,\s*(\d+)p\1\s+(\S+)\s*$/;

/**
 * Match `sed -n 'A,Bp' FILE` and nothing else.
 *
 * The command must be a single segment: a `;`, `&&`, `||`, or `|` means the
 * range view is one step inside a larger pipeline, where the alternative is
 * not a drop-in replacement and the hint would be wrong. The same test that
 * `session_analysis/sed_ranges.py` applies to the corpus -- 76% of observed
 * ranges are 50 lines or fewer, far inside the read tool's 2000-line budget,
 * which is what makes the two substitutable.
 */
export function matchSedRange(command: unknown): SedRangeView | null {
    if (typeof command !== "string") return null;
    if (/[;|]|&&/.test(command)) return null;
    const m = SED_RANGE.exec(command);
    if (!m) return null;
    const start = Number(m[2]);
    const end = Number(m[3]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 1 || end < start) return null;
    const path = m[4].replace(/^['"]|['"]$/g, "");
    if (!path || path.startsWith("-")) return null;
    return { path, start, end };
}

/** The first `- error L:C` position in an lsp_diagnostics result. */
export interface DiagnosticPosition {
    path: string;
    line: number;
    column: number;
    severity: "error" | "warning";
}

const DIAGNOSTIC_HEADER = /^LSP diagnostics for (.+?) \(([^)]+)\):\s*$/m;
const DIAGNOSTIC_ENTRY = /^-\s+(error|warning)\s+(\d+):(\d+)\s/m;

/**
 * Find a diagnostic the agent could act on with `lsp_code_action`.
 *
 * Only `error` and `warning` entries count. A `hint`-only result (an unused
 * import, say) has no fix worth a tool call, and hinting on it would train the
 * agent to ignore the hint.
 */
export function findDiagnosticPosition(
    resultText: unknown
): DiagnosticPosition | null {
    if (typeof resultText !== "string") return null;
    const header = DIAGNOSTIC_HEADER.exec(resultText);
    const entry = DIAGNOSTIC_ENTRY.exec(resultText);
    if (!header || !entry) return null;
    const path = header[1].trim();
    const line = Number(entry[2]);
    const column = Number(entry[3]);
    if (!path || !Number.isInteger(line) || line < 1) return null;
    if (!Number.isInteger(column) || column < 1) return null;
    return {
        path,
        line,
        column,
        severity: entry[1] as "error" | "warning",
    };
}

/**
 * The job a `jobs` call is polling.
 *
 * `jobs` accepts either field name across versions; both are checked because a
 * hint that names the wrong id is worse than no hint.
 */
export function jobIdOf(input: Record<string, unknown>): string | null {
    for (const key of ["jobId", "id"] as const) {
        const value = input[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

/** How many polls of the same job before the loop is worth naming. */
export const POLL_THRESHOLD = 3;
