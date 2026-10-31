/**
 * The hint strings. Kept apart from the predicates so the wording can be
 * reviewed as prompt surface on its own: every line here is paid for in every
 * session that trips a rule, so each one names the tool, the exact arguments,
 * and the benefit -- and nothing else.
 */

import type { DiagnosticPosition, SedRangeView } from "./hints.ts";

export const HINT_PREFIX = "[hint] ";

/**
 * A line-range view through sed, where `read` is the tool that does it natively.
 * `read` returns the range with line numbers, needs no shell quoting, and its
 * result carries the same offset/limit the agent is already using here.
 */
export function sedRangeHint(view: SedRangeView): string {
    const limit = view.end - view.start + 1;
    return (
        `${HINT_PREFIX}read does this without a shell: ` +
        `path=${view.path}, offset=${view.start}, limit=${limit}. ` +
        `It returns the same lines with line numbers and no quoting to escape.`
    );
}

/**
 * Diagnostics that name a position, where `lsp_code_action` can turn the report
 * into a fix. Over 30 days the corpus has 7,888 lsp_diagnostics calls against
 * 117 lsp_code_action calls: the follow-up tool is nearly undiscovered, which
 * is exactly the case an annotation is for.
 */
export function diagnosticsHint(pos: DiagnosticPosition): string {
    return (
        `${HINT_PREFIX}lsp_code_action turns this ${pos.severity} into a fix: ` +
        `filePath=${pos.path}, line=${pos.line}, column=${pos.column}. ` +
        `Call it without apply to list the fixes, then pass apply:"<title>" to run one.`
    );
}

/**
 * A poll loop, where `job_decide` is the verb that ends it. The corpus has
 * 15,093 `jobs` calls against 2,157 `job_decide` calls.
 */
export function jobPollHint(jobId: string): string {
    return (
        `${HINT_PREFIX}job_decide ends this poll loop: ` +
        `{jobId: ${JSON.stringify(jobId)}, decision: "check"} reads progress, ` +
        `"keep" lets it run, "kill" stops it.`
    );
}
