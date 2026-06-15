/**
 * Reload tool — lets the model trigger a full reload of keybindings,
 * extensions, skills, prompts, and themes.
 *
 * The model cannot invoke slash commands, so this exposes reload as a tool.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

/**
 * Register the reload tool.
 *
 * ctx.reload() is available directly on ExtensionContext (tools, event
 * handlers, and command handlers), so no command-handler bridge is needed.
 */
export function registerReloadTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "reload",
        label: "Reload Configuration",
        description:
            "Reload keybindings, extensions, skills, prompts, and themes. " +
            "Use when the user asks to reload, when configuration files have changed, " +
            "or after installing new extensions/skills/themes. " +
            "Equivalent to running /reload in the terminal.",
        promptSnippet:
            "Reload extensions, skills, prompts, themes, and keybindings",
        promptGuidelines: [
            "Use reload when the user mentions changes to configuration files.",
            "Use reload after installing or updating extensions, skills, or themes.",
            "Do NOT use reload to retry a failed operation — it restarts the extension runtime.",
        ],
        parameters: Type.Object({}),

        async execute(
            _toolCallId,
            _params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<undefined>> {
            // ctx.reload() is available on ExtensionContext since
            // pi v0.78.1. If the running core predates this, warn.
            if (typeof ctx.reload !== "function") {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                "Reload requires pi v0.78.1+. " +
                                "Please run /reload manually in the terminal.",
                        },
                    ],
                    details: undefined,
                };
            }

            // In non-interactive modes (print, json, rpc) the process
            // exits after the turn, so there's no point deferring. In
            // interactive (TUI) mode, wait for idle then reload.
            if (ctx.mode === "tui") {
                // Wait up to 30s for the agent to go idle.
                // After reload the runner invalidates this context, so
                // any subsequent ctx access would throw — catch silently.
                const executeReload = async () => {
                    for (let i = 0; i < 150; i++) {
                        try {
                            await new Promise<void>((r) => {
                                const t = setTimeout(r, 200);
                                t.unref();
                            });
                            if (ctx.isIdle()) {
                                await ctx.reload();
                                return;
                            }
                        } catch {
                            return;
                        }
                    }
                };
                executeReload();
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            "Reload scheduled — will fire after the current " +
                            "response completes. All configuration changes " +
                            "will be active once the reload finishes.",
                    },
                ],
                details: undefined,
            };
        },
    });
}
