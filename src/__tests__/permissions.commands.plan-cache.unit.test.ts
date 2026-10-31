import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPermissions } from "../features/permissions/commands.ts";
import { TauState } from "../state.ts";

type Command = {
    handler: (args: string, ctx: unknown) => Promise<void> | void;
};

void describe("permission mode tool-schema stability", () => {
    void it("changes plan authorization without replacing active tools", async () => {
        const state = new TauState();
        const commands = new Map<string, Command>();
        const activeToolUpdates: string[][] = [];
        const pi = {
            registerCommand(name: string, command: Command) {
                commands.set(name, command);
            },
            registerShortcut() {},
            setActiveTools(names: string[]) {
                activeToolUpdates.push(names);
            },
            getThinkingLevel: () => "off",
            setThinkingLevel() {},
        } as unknown as ExtensionAPI;
        const ctx = {
            hasUI: false,
            cwd: "/tmp",
            ui: { notify() {} },
        };

        registerPermissions(pi, state);
        const permissionCommand = commands.get("perm");
        assert.ok(permissionCommand);

        await permissionCommand.handler("plan", ctx);
        assert.equal(state.permissionMode, "plan");
        assert.deepEqual(activeToolUpdates, []);

        await permissionCommand.handler("allow", ctx);
        assert.equal(state.permissionMode, "allow");
        assert.equal(state.planModeExitNoticePending, true);
        assert.deepEqual(activeToolUpdates, []);
    });
});
