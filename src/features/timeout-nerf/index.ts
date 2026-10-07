/**
 * Timeout nerf replaces shell `timeout` wrappers with pi's process controls.
 * A 30-day corpus contained 82,578 shell-timeout calls (14.86% of 555,731
 * bash calls) and 50,119 of those (61%) were written `cd DIR && timeout`.
 * Core bash already detaches a command that exceeds its default 240s budget,
 * which happened 12,166 times in the same window, so a shell wrapper mostly
 * pre-empts a mechanism pi already has: it can kill the command before that
 * budget detaches it, or kill it after. This hook removes the leading wrapper,
 * lifts a simple `cd` into `cwd`, and tells the agent exactly what changed and
 * how to choose between a hard kill and a captured background job.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashGuidelines, nerfNote } from "./messages.ts";
import { planNerf } from "./parse.ts";
import type { NerfPlan } from "./parse.ts";

export {
    findTimeoutInvocation,
    parseDurationSeconds,
    planNerf,
} from "./parse.ts";
export type {
    TimeoutInvocation,
    NerfPlan,
    NerfOptions,
    SkipReason,
} from "./parse.ts";
export { nerfNote, bashGuidelines } from "./messages.ts";

/**
 * `registerToolPromptGuidelines` and the bash input's `cwd` field were added to
 * pi after 0.74.0 — the version pi-tau's pnpm lock resolves for local
 * type-checking. The peer dependency is `*`, so the host supplies pi, and the
 * runtime here is 0.84.x where both exist. Declare the newer surface narrowly
 * and feature-detect it, so the extension keeps both capabilities on a current
 * host and stays loadable, rather than throwing at registration, on an older one.
 */
type PiWithOptionalGuidelines = ExtensionAPI & {
    registerToolPromptGuidelines?: (
        toolName: string,
        guidelines: string[]
    ) => void;
};

/** The bash tool input as pi declares it from 0.84 onward (adds `cwd`). */
interface BashInputWithCwd {
    command?: string;
    timeout?: number;
    cwd?: string;
}

/**
 * Whether lifting `dir` into the tool's `cwd` reproduces the shell's `cd`.
 *
 * The tool sets the process working directory, so the shell derives `PWD` from
 * `getcwd()` and reports the PHYSICAL path, while `cd` sets the LOGICAL one. For
 * `cd /bin && pwd` the shell prints "/bin", but the same command with
 * `cwd: "/bin"` prints "/usr/bin", so a directory reached through a symlink is
 * not interchangeable with a lifted `cwd`. The two agree exactly when the
 * literal path is already physical, which is what this checks.
 */
function cwdLiftIsFaithful(dir: string): boolean {
    try {
        return realpathSync.native(dir) === resolve(dir);
    } catch {
        // A directory that cannot be resolved cannot be entered either. Keeping
        // the `cd` in the command preserves whatever the shell would have done.
        return false;
    }
}

/** Register the timeout rewrite and its explicit agent-facing explanation. */
export function registerTimeoutNerf(pi: ExtensionAPI): void {
    const pending = new Map<string, NerfPlan>();

    const api = pi as PiWithOptionalGuidelines;
    if (typeof api.registerToolPromptGuidelines === "function") {
        api.registerToolPromptGuidelines("bash", bashGuidelines());
    }

    pi.on("tool_call", (event) => {
        if (event.toolName !== "bash") return;
        const input = event.input as BashInputWithCwd;
        const command = input.command;
        if (typeof command !== "string") return;

        const options = {
            toolTimeoutSeconds:
                typeof input.timeout === "number" ? input.timeout : undefined,
        };
        let plan = planNerf(command, options);
        if (
            plan.action === "rewrite" &&
            plan.cwd !== null &&
            !cwdLiftIsFaithful(plan.cwd)
        ) {
            // Re-plan without the lift so the `cd` stays in the command and the
            // rewrite keeps the shell's logical path.
            plan = planNerf(command, { ...options, liftCwd: false });
        }
        if (plan.action !== "rewrite") return;

        input.command = plan.rewritten;
        if (plan.cwd !== null) input.cwd = plan.cwd;
        // A duplicate toolCallId cannot be attributed to either call, so drop
        // the entry instead of annotating a result with the other call's note,
        // which would be actively wrong. The host generates unique ids; count
        // the collision so this branch is observable rather than silent.
        if (pending.has(event.toolCallId)) {
            pending.delete(event.toolCallId);
            pi.appendEntry("timeout-nerf-collision", {
                toolCallId: event.toolCallId,
            });
        } else {
            pending.set(event.toolCallId, plan);
        }
        pi.appendEntry("timeout-nerf", {
            toolCallId: event.toolCallId,
            original: plan.original,
            rewritten: plan.rewritten,
            timeoutToken: plan.invocation?.token,
            timeoutSeconds: plan.invocation?.seconds,
            cwd: plan.cwd,
        });
    });

    pi.on("tool_result", (event) => {
        const plan = pending.get(event.toolCallId);
        if (!plan) return;
        pending.delete(event.toolCallId);

        const note = nerfNote(plan);
        if (!note) return;
        return {
            content: [{ type: "text", text: note }, ...event.content],
        };
    });

    pi.on("session_shutdown", () => {
        pending.clear();
    });
}

/**
 * Standalone entry point.
 *
 * pi-tau loads this feature through its own `src/index.ts`, so the default
 * export is not needed for normal operation. Exporting a factory as well keeps
 * the feature loadable on its own (`pi -e src/features/timeout-nerf/index.ts`),
 * which is how the end-to-end check proves that a rewrite reaches a real tool
 * call rather than only a fake event object.
 */
export default function (pi: ExtensionAPI): void {
    registerTimeoutNerf(pi);
}
