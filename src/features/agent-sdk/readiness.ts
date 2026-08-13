/**
 * Readiness diagnostics for the optional Claude Agent SDK provider.
 *
 * The SDK is an optional dependency (it bundles a platform-specific native
 * binary), so the provider's models are listed even when the dependency is
 * absent. This module gives the provider a cheap, structured probe that runs
 * BEFORE any dynamic import or subprocess spawn, so selecting a
 * `claude-agent-sdk` model with the runtime missing fails fast with an
 * actionable diagnostic instead of a deep resolver error mid-turn.
 *
 * Two independent pieces must resolve:
 *
 *   1. the `@anthropic-ai/claude-agent-sdk` package itself (checked via a
 *      cheap `import.meta.resolve`, no module execution), and
 *   2. the Claude Code native binary the SDK spawns (reusing the existing
 *      platform-package resolution, which also honours the
 *      `CLAUDE_CODE_EXECUTABLE` override).
 *
 * Kept SDK-free (no runtime import of the optional dependency) and fully
 * unit-testable: the resolution steps are injected through
 * {@link AgentSdkReadinessProbe}, mirroring the auth.ts / executable.ts
 * module pattern. Only the pure diagnostic logic is tested — the live
 * resolvers touch the filesystem and the installed optional dependency.
 */

import { resolveClaudeCodeExecutable } from "./executable.ts";
import { AGENT_SDK_INSTALL_HINT } from "./sdk-loader.ts";

/** The runtime piece(s) that failed to resolve. */
export type AgentSdkReadinessIssue = "sdk" | "executable";

/** Structured result of a readiness probe. */
export interface AgentSdkReadiness {
    /** True when every required runtime piece is resolvable. */
    ready: boolean;
    /** The pieces that failed resolution, in a stable order. */
    issues: AgentSdkReadinessIssue[];
    /** Human-readable, actionable diagnostic; present when not ready. */
    reason?: string;
}

/**
 * Injectable resolution steps so the diagnostic logic can be unit-tested
 * without touching the filesystem or the installed optional dependency.
 */
export interface AgentSdkReadinessProbe {
    /** True when the SDK package resolves (cheap module-resolution probe). */
    sdkResolvable(): boolean;
    /** Resolves the native binary path; throws when it cannot. */
    executablePath(): string;
}

const defaultProbe: AgentSdkReadinessProbe = {
    sdkResolvable() {
        try {
            import.meta.resolve("@anthropic-ai/claude-agent-sdk");
            return true;
        } catch {
            return false;
        }
    },
    executablePath() {
        return resolveClaudeCodeExecutable();
    },
};

/**
 * Check whether the Claude Agent SDK runtime is ready to execute.
 *
 * Reports the SDK package first: when it is missing the native binary is
 * unreachable too, so only the package issue is reported (with the install
 * hint) to keep the diagnostic actionable rather than noisy. When the package
 * resolves but the platform binary does not, the executable issue carries the
 * resolver's own message (reinstall / `CLAUDE_CODE_EXECUTABLE` override).
 */
export function checkAgentSdkReadiness(
    probe: AgentSdkReadinessProbe = defaultProbe
): AgentSdkReadiness {
    if (!probe.sdkResolvable()) {
        return {
            ready: false,
            issues: ["sdk"],
            reason: AGENT_SDK_INSTALL_HINT,
        };
    }
    try {
        probe.executablePath();
        return { ready: true, issues: [] };
    } catch (error) {
        return {
            ready: false,
            issues: ["executable"],
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
