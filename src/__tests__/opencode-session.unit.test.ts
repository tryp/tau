import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { opencodeSessionOptions } from "../features/opencode-session.ts";

void describe("OpenCode complete request options", () => {
    const model = { provider: "openai", baseUrl: "https://api.example.com" };

    void it("adds session and client headers for exact provider IDs", () => {
        for (const provider of ["opencode", "opencode-go"]) {
            const result = opencodeSessionOptions(
                { ...model, provider },
                "session-1"
            );
            assert.deepEqual(result, {
                model: { ...model, provider },
                headers: {
                    "x-opencode-session": "session-1",
                    "x-opencode-client": "pi",
                },
                sessionId: "session-1",
            });
        }
    });

    void it("supports only the exact OpenCode hostname", () => {
        assert.deepEqual(
            opencodeSessionOptions(
                { ...model, baseUrl: "https://opencode.ai/v1" },
                "s"
            ),
            {
                model: { ...model, baseUrl: "https://opencode.ai/v1" },
                headers: {
                    "x-opencode-session": "s",
                    "x-opencode-client": "pi",
                },
                sessionId: "s",
            }
        );
        for (const baseUrl of [
            "https://notopencode.ai/v1",
            "https://opencode.ai.attacker.test/v1",
            "not a URL",
        ]) {
            const ordinaryModel = { ...model, baseUrl };
            assert.deepEqual(opencodeSessionOptions(ordinaryModel, "s"), {
                model: ordinaryModel,
                headers: undefined,
                sessionId: "s",
            });
        }
    });

    void it("does not fabricate a session ID and preserves ordinary provider inputs", () => {
        const openCodeModel = { ...model, provider: "opencode" };
        assert.deepEqual(opencodeSessionOptions(openCodeModel, undefined), {
            model: openCodeModel,
            headers: { "x-opencode-client": "pi" },
        });
        const headers = { Authorization: "Bearer secret" };
        const result = opencodeSessionOptions(model, "s", headers);
        assert.equal(result.model, model);
        assert.equal(result.headers, headers);
        assert.deepEqual(result, { model, headers, sessionId: "s" });
    });

    void it("merges mixed-case auth headers over model headers without mutation", () => {
        const headers = {
            AUTHORIZATION: "Bearer secret",
            "x-opencode-session": "auth-session",
            "X-OPENCODE-CLIENT": "auth-client",
        };
        const originalModelHeaders = {
            "X-OpenCode-Session": "model-session",
            "X-OpenCode-Client": "model-client",
        };
        const sourceModel = {
            ...model,
            provider: "opencode",
            headers: originalModelHeaders,
        };
        const result = opencodeSessionOptions(
            sourceModel,
            "runtime-session",
            headers
        );
        assert.deepEqual(result.headers, {
            AUTHORIZATION: "Bearer secret",
            "x-opencode-session": "auth-session",
            "X-OPENCODE-CLIENT": "auth-client",
        });
        assert.deepEqual(result.model, { ...model, provider: "opencode" });
        assert.deepEqual(sourceModel.headers, originalModelHeaders);
        assert.deepEqual(headers, {
            AUTHORIZATION: "Bearer secret",
            "x-opencode-session": "auth-session",
            "X-OPENCODE-CLIENT": "auth-client",
        });
    });

    void it("preserves model null suppression and uses each invocation's current session", () => {
        const sourceModel = {
            ...model,
            provider: "opencode",
            headers: { "X-OpenCode-Session": null },
        };
        const first = opencodeSessionOptions(sourceModel, "first");
        const second = opencodeSessionOptions(sourceModel, "second");
        assert.equal(first.sessionId, "first");
        assert.deepEqual(first.headers, {
            "X-OpenCode-Session": null,
            "x-opencode-client": "pi",
        });
        assert.equal(second.sessionId, "second");
        assert.deepEqual(second.headers, {
            "X-OpenCode-Session": null,
            "x-opencode-client": "pi",
        });
        assert.deepEqual(sourceModel.headers, { "X-OpenCode-Session": null });
    });
});
