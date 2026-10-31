/**
 * Tool hints annotate another extension's or a core tool's result when this
 * runtime knows a cheaper way to get the same thing.
 *
 * This is the counterpart to pipe-nerf and timeout-nerf: those rewrite the call
 * before it runs, this one speaks after it ran, when the agent can still see
 * what it got and judge the suggestion against it. The hint is appended as a
 * separate content block so it never displaces the payload, never marks a
 * result as an error, and never edits the tool's own words.
 *
 * Rules, each with the corpus evidence that made it worth the tokens:
 *
 *  - sed-range: `bash` + `sed -n 'A,Bp' FILE` where `read` is a drop-in
 *    replacement (see `matchSedRange` for why the predicate is strict).
 *  - diagnostics: an `lsp_diagnostics` result naming an error or warning
 *    position, where `lsp_code_action` can apply the fix. 7,888 diagnostics
 *    calls against 117 code-action calls in 30 days.
 *  - job-poll: the third `jobs` poll of one job in a session, where
 *    `job_decide` is the tool that ends the loop. 15,093 `jobs` calls against
 *    2,157 `job_decide` calls in the same window.
 *
 * Admission is controlled by `HintGate`, not by a once-per-session flag: a hint
 * repeated every turn is noise, but a hint retired after one ignored attempt is
 * silent for the rest of the session. See `gate.ts` for why compaction made the
 * original rule wrong.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../../state.ts";
import { isFeatureEnabled } from "../features-helpers.ts";
import {
    POLL_THRESHOLD,
    findDiagnosticPosition,
    jobIdOf,
    matchSedRange,
} from "./hints.ts";
import { HintGate } from "./gate.ts";
import { diagnosticsHint, jobPollHint, sedRangeHint } from "./messages.ts";

/** `tool_result` arrives with the tool name narrowed per tool; only these fields are read. */
interface HintableResultEvent {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
}

export type HintRule = "sed-range" | "diagnostics" | "job-poll";

/**
 * Text of every content block, joined. The predicates look for a header line
 * and an entry line, which may sit in different blocks, so joining is what
 * makes the match independent of how the host chunked the result.
 */
function resultText(event: HintableResultEvent): string {
    return event.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n");
}

export function registerToolHints(pi: ExtensionAPI, state?: TauState): void {
    /** Per-rule admission, keyed by rule; job polling is keyed per job id. */
    const ruleGate = new HintGate();
    const jobGate = new HintGate();
    /** Poll counts per job id. */
    const polls = new Map<string, number>();
    /** Suppression is silent by construction; record the first one per rule. */
    const suppressionRecorded = new Set<string>();

    const enabled = (): boolean => !state || isFeatureEnabled(state, "tool-hints");

    const suppress = (rule: HintRule, reason: string): void => {
        if (suppressionRecorded.has(rule)) return;
        suppressionRecorded.add(rule);
        pi.appendEntry("tool-hints-suppressed", { rule, reason });
    };

    pi.on("tool_result", (event) => {
        if (!enabled()) return;
        // A hint on a failed call piles on a result the agent already has to
        // reason about, and the failure is usually why the call was wrong.
        if (event.isError) return;

        const e = event as unknown as HintableResultEvent;
        let hint: string | null = null;
        let rule: HintRule | null = null;

        if (e.toolName === "bash") {
            const view = matchSedRange(e.input.command);
            if (!view) return;
            rule = "sed-range";
            const decision = ruleGate.offer(rule);
            if (!decision.fire) {
                suppress(rule, "rearm-pending");
                return;
            }
            hint = sedRangeHint(view);
        } else if (e.toolName === "lsp_diagnostics") {
            const pos = findDiagnosticPosition(resultText(e));
            if (!pos) return;
            rule = "diagnostics";
            const decision = ruleGate.offer(rule);
            if (!decision.fire) {
                suppress(rule, "rearm-pending");
                return;
            }
            hint = diagnosticsHint(pos);
        } else if (e.toolName === "jobs") {
            const jobId = jobIdOf(e.input);
            if (!jobId) return;
            const count = (polls.get(jobId) ?? 0) + 1;
            polls.set(jobId, count);
            // The first hint waits for a loop to be real; after that the gate
            // decides whether the job has been ignored long enough to re-offer.
            if (count < POLL_THRESHOLD) return;
            rule = "job-poll";
            if (!jobGate.offer(jobId).fire) {
                suppress(rule, "rearm-pending");
                return;
            }
            hint = jobPollHint(jobId);
        } else {
            return;
        }

        if (!hint || !rule) return;
        pi.appendEntry("tool-hints", {
            rule,
            tool: e.toolName,
            toolCallId: e.toolCallId,
        });
        return {
            content: [...event.content, { type: "text" as const, text: hint }],
        };
    });

    pi.on("session_shutdown", () => {
        ruleGate.reset();
        jobGate.reset();
        polls.clear();
        suppressionRecorded.clear();
    });
}

/**
 * Standalone entry point, so the feature can be loaded on its own
 * (`pi -e src/features/tool-hints/index.ts`) for an end-to-end check.
 */
export default function (pi: ExtensionAPI): void {
    registerToolHints(pi);
}
