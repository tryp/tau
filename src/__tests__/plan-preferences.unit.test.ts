import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlanPreferences } from "../features/plan-preferences.ts";

void describe("parsePlanPreferences", () => {
    void it("parses automation preferences", () => {
        assert.deepEqual(
            parsePlanPreferences({
                tau: {
                    plan: {
                        reviewMode: "agent",
                        autoApprove: true,
                        defaultExecutionMode: "parallel",
                    },
                },
            }),
            {
                reviewMode: "agent",
                autoApprove: true,
                defaultExecutionMode: "parallel",
            }
        );
    });

    void it("ignores invalid preference values", () => {
        assert.deepEqual(
            parsePlanPreferences({
                tau: {
                    plan: {
                        reviewMode: "reviewer",
                        autoApprove: "yes",
                        defaultExecutionMode: "sideways",
                    },
                },
            }),
            {}
        );
    });

    void it("ignores malformed settings structures", () => {
        assert.deepEqual(parsePlanPreferences(null), {});
        assert.deepEqual(parsePlanPreferences({ tau: [] }), {});
        assert.deepEqual(parsePlanPreferences({ tau: { plan: [] } }), {});
    });
});
