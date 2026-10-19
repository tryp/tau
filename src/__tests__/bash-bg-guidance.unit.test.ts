import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerBackgroundJobs } from "../features/background.ts";
import { bashGuidelines } from "../features/timeout-nerf/messages.ts";
import { TauState } from "../state.ts";

type RegisteredTool = {
    name: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: {
        properties?: Record<string, { description?: string }>;
    };
};

void describe("bash_bg decision-deadline guidance", () => {
    void it("contains no kill semantics in schema or standing guidance", () => {
        let bashBg: RegisteredTool | undefined;
        const pi = {
            registerTool(tool: RegisteredTool) {
                if (tool.name === "bash_bg") bashBg = tool;
            },
            registerCommand() {},
            registerMessageRenderer() {},
            registerToolPromptGuidelines() {},
            createBashTool: () => ({ execute: async () => ({ content: [] }) }),
            on() {},
            sendMessage() {},
        } as never;
        registerBackgroundJobs(pi, new TauState());
        assert.ok(bashBg, "bash_bg tool must be registered");

        const timeoutDescription =
            bashBg.parameters?.properties?.timeout?.description;
        const guidance = [
            bashBg.description,
            bashBg.promptSnippet,
            ...(bashBg.promptGuidelines ?? []),
            timeoutDescription,
            ...bashGuidelines(),
        ]
            .filter((text): text is string => typeof text === "string")
            .join("\n");

        assert.match(guidance, /decision deadline/i);
        assert.match(
            guidance,
            /not terminated automatically|not killed automatically/i
        );
        assert.doesNotMatch(guidance, /kill deadline|is terminated/i);
    });
});
