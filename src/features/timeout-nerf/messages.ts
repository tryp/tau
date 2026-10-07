import type { NerfPlan, TimeoutInvocation } from "./parse.ts";

/** Longest command rendered in full in the prose line of the note. */
const MAX_PREVIEW_CHARS = 200;

/**
 * Render the removed bound so the note never claims a wrong unit.
 *
 * The token is written as the agent typed it, so appending "s" would claim
 * "1.5hs" for `timeout 1.5h`. The parsed seconds are added whenever the token
 * is not already a plain seconds count, because "2h30m" alone hides the bound
 * the agent actually set.
 */
function boundText(invocation: TimeoutInvocation): string {
    const { token, seconds } = invocation;
    if (seconds === null) return token;
    return token === String(seconds) ? `${seconds}s` : `${token} (${seconds}s)`;
}

/**
 * Bound the prose copy of a long command. The pasteable `bash_bg` call below
 * still carries the command in full, so shortening here cannot lose it, and the
 * trailing ellipsis keeps a preview from being mistaken for the whole command.
 */
function preview(command: string): string {
    return command.length <= MAX_PREVIEW_CHARS
        ? command
        : `${command.slice(0, MAX_PREVIEW_CHARS)}…`;
}

/** pi's foreground bash budget in ms. Mirrors core's default and its env override. */
function bashBudgetMs(): number {
    const raw = Number(process.env.PI_BASH_DEFAULT_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
}

/**
 * The explicit, agent-facing note prepended to the modified call's result.
 *
 * This is the only place the agent learns that its command was changed, so it
 * must say what was removed, what now runs, what the new effective bound is,
 * and which primitive to reach for next. It is prepended to every modified
 * call, so it stays short.
 */
export function nerfNote(plan: NerfPlan): string {
    if (plan.action !== "rewrite" || !plan.invocation) return "";

    const removedPrefix = plan.original.slice(
        plan.invocation.start,
        plan.invocation.end
    );
    const lifted =
        plan.cwd === null ? "" : `, cwd lifted to ${JSON.stringify(plan.cwd)}`;

    // A `bash_bg` call the agent can paste directly. The command is the
    // effective one, NOT `wrappedCommand`: when a `cd` prologue was kept rather
    // than lifted, that prologue is part of the command, and dropping it would
    // run the job in the wrong directory. `timeout` is omitted rather than
    // defaulted to 0, which would mean "kill immediately".
    const seconds = plan.invocation.seconds;
    const bgArgs: Record<string, unknown> = { command: plan.rewritten };
    if (plan.cwd !== null) bgArgs.cwd = plan.cwd;
    if (seconds !== null) bgArgs.timeout = seconds;
    // Wake before the kill deadline rather than at a fixed 5m, which for a
    // short bound would arrive only after the job had already been killed.
    const remindSeconds =
        seconds === null
            ? 300
            : Math.max(30, Math.min(300, Math.floor(seconds / 2)));
    bgArgs.remindDelay = `${remindSeconds}s`;

    return [
        `[timeout-nerf] Your command was modified before running: removed the shell prefix ${JSON.stringify(removedPrefix)}${lifted}.`,
        `Effective command: ${JSON.stringify(preview(plan.rewritten))}.`,
        `The shell's kill at ${boundText(plan.invocation)} no longer applies. pi now detaches a still-running command after ${Math.round(bashBudgetMs() / 1000)}s instead, and a detached command's output is not captured.`,
        `For a hard kill, pass the bash tool's \`timeout\` parameter instead of wrapping in the shell \`timeout\` utility.`,
        `To run long and read the log later, use bash_bg (it captures output and can wake you): bash_bg(${JSON.stringify(bgArgs)}), then inspect it with \`jobs\`.`,
    ].join("\n");
}

/** Standing guidance contributed to the bash tool's prompt guidelines. */
export function bashGuidelines(): string[] {
    return [
        "Do not wrap commands in the shell `timeout` utility. A leading shell `timeout` wrapper is removed before execution, because it pre-empts pi's own handling: it can kill a command before pi's budget detaches it, or kill it after. Use the tools below instead.",
        "For a hard kill bound, set the bash tool's `timeout` parameter. An explicit `timeout` parameter keeps kill semantics.",
        "For a long run you will check on later, use `bash_bg` with `timeout` (kill deadline) and `remindDelay` (wakes you when it elapses), then read the captured log with `jobs` or `job_decide`. Prefer this over a foreground command whose output would be lost when it is detached.",
    ];
}
