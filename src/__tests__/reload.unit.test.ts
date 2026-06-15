/**
 * Tests for the reload feature — registerReloadTool.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

void describe("registerReloadTool", () => {
    void it("registers a tool named 'reload'", () => {
        let registeredToolName: string | undefined;
        let registeredExecute: Function | undefined;

        const mockPi = {
            registerTool: (def: any) => {
                registeredToolName = def.name;
                registeredExecute = def.execute;
            },
        } as any;

        // Must import dynamically to avoid loading modules that depend on build output
        const { registerReloadTool } = require("../features/reload.ts");
        registerReloadTool(mockPi);

        assert.equal(registeredToolName, "reload");
        assert.equal(typeof registeredExecute, "function");
    });
});
