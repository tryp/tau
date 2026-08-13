/**
 * Unit tests for Claude Agent SDK provider readiness diagnostics.
 *
 * The SDK is optional, so these tests inject the resolution probes instead of
 * depending on the machine's installed packages or native binary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    checkAgentSdkReadiness,
    type AgentSdkReadinessProbe,
} from "../features/agent-sdk/readiness.ts";
import { AGENT_SDK_INSTALL_HINT } from "../features/agent-sdk/sdk-loader.ts";
import { streamClaudeAgentSdk } from "../features/agent-sdk/provider.ts";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { AgentSdkSettings } from "../features/agent-sdk/settings.ts";

function probe(
    overrides: Partial<AgentSdkReadinessProbe> = {}
): AgentSdkReadinessProbe {
    return {
        sdkResolvable: () => true,
        executablePath: () => "/tmp/claude",
        ...overrides,
    };
}

void describe("checkAgentSdkReadiness", () => {
    void it("reports ready when the SDK and native executable resolve", () => {
        const result = checkAgentSdkReadiness(probe());
        assert.deepEqual(result, { ready: true, issues: [] });
    });

    void it("reports the install hint when the optional SDK is missing", () => {
        let executableChecks = 0;
        const result = checkAgentSdkReadiness(
            probe({
                sdkResolvable: () => false,
                executablePath: () => {
                    executableChecks++;
                    return "/tmp/claude";
                },
            })
        );

        assert.equal(result.ready, false);
        assert.deepEqual(result.issues, ["sdk"]);
        assert.equal(result.reason, AGENT_SDK_INSTALL_HINT);
        assert.equal(executableChecks, 0);
    });

    void it("reports a missing native executable separately", () => {
        const result = checkAgentSdkReadiness(
            probe({
                executablePath: () => {
                    throw new Error("native executable unavailable");
                },
            })
        );

        assert.equal(result.ready, false);
        assert.deepEqual(result.issues, ["executable"]);
        assert.equal(result.reason, "native executable unavailable");
    });
});

void describe("streamClaudeAgentSdk readiness gate", () => {
    void it("returns the missing-SDK diagnostic before provider execution", async () => {
        const model: Model<Api> = {
            id: "claude-sonnet-test",
            name: "Claude Sonnet (SDK)",
            api: "anthropic-messages",
            provider: "claude-agent-sdk",
            baseUrl: "claude-agent-sdk",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 1_024,
        };
        const context: Context = { messages: [] };
        const settings: AgentSdkSettings = {
            authMode: "subscription",
            mode: "flatten",
        };
        let executableChecks = 0;

        const stream = streamClaudeAgentSdk(model, context, undefined, {
            settings,
            sdkSessions: new Map(),
            readinessProbe: probe({
                sdkResolvable: () => false,
                executablePath: () => {
                    executableChecks++;
                    return "/tmp/claude";
                },
            }),
        });

        const result = await stream.result();
        assert.equal(result.stopReason, "error");
        assert.equal(result.errorMessage, AGENT_SDK_INSTALL_HINT);
        assert.equal(executableChecks, 0);
    });
});
