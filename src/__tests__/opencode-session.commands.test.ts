import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { complete } from "@earendil-works/pi-ai";
import { registerHandoff } from "../features/handoff.ts";
import { registerSummarize } from "../features/summarize.ts";
import { TauState } from "../state.ts";

type Invocation = {
    model: unknown;
    context: unknown;
    options: Record<string, unknown>;
};
const response = {
    role: "assistant",
    content: [{ type: "text", text: "generated text" }],
    api: "openai-completions",
    provider: "opencode",
    model: "test-model",
    usage: { input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
} as never;

function commandRegistrar() {
    const handlers = new Map<string, (...args: never[]) => Promise<unknown>>();
    return {
        handlers,
        pi: {
            registerCommand(
                name: string,
                command: { handler: (...args: never[]) => Promise<unknown> }
            ) {
                handlers.set(name, command.handler);
            },
        } as never,
    };
}

function completeCapture(invocations: Invocation[]) {
    const completeRequest = async (
        model: unknown,
        context: unknown,
        options: Record<string, unknown>
    ) => {
        invocations.push({ model, context, options });
        return response;
    };
    return completeRequest as typeof complete;
}

function sessionAssertions(invocation: Invocation, id: string, client = "pi") {
    assert.equal(invocation.options.sessionId, id);
    const headers = invocation.options.headers as Record<string, string>;
    assert.equal(headers["x-opencode-session"], id);
    assert.equal(
        Object.entries(headers).find(
            ([name]) => name.toLowerCase() === "x-opencode-client"
        )?.[1],
        client
    );
    assert.equal(headers.Authorization, "Bearer test");
}

void describe("OpenCode command completion wiring", () => {
    void it("summarize passes each invocation's session and merged headers to complete", async () => {
        const invocations: Invocation[] = [];
        let currentSession = "source-one";
        let authHeaders: Record<string, string> = {
            Authorization: "Bearer test",
        };
        const model = {
            provider: "opencode",
            id: "test-model",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
            headers: {},
        };
        const { pi, handlers } = commandRegistrar();
        registerSummarize(pi, new TauState(), {
            complete: completeCapture(invocations),
            getModel: (() => model) as never,
        });
        const handler = handlers.get("summarize")!;
        const ctx = {
            hasUI: false,
            sessionManager: {
                getSessionId: () => currentSession,
                getBranch: () => [
                    {
                        type: "message",
                        message: { role: "user", content: "hello" },
                    },
                ],
            },
            modelRegistry: {
                getApiKeyAndHeaders: async () => ({
                    ok: true,
                    apiKey: "fake-key",
                    headers: authHeaders,
                }),
            },
            ui: { notify() {} },
        } as never;

        await handler("" as never, ctx);
        currentSession = "source-two";
        await handler("" as never, ctx);
        currentSession = "source-three";
        model.headers = {
            "X-OpenCode-Session": "model-session",
            "X-OpenCode-Client": "model-client",
        };
        authHeaders = {
            Authorization: "Bearer test",
            "x-opencode-session": "auth-session",
            "x-OPENCode-client": "auth-client",
        };
        await handler("" as never, ctx);

        assert.equal(invocations.length, 3);
        sessionAssertions(invocations[0], "source-one");
        sessionAssertions(invocations[1], "source-two");
        const request = invocations[2];
        assert.equal(request.options.sessionId, "source-three");
        assert.deepEqual(request.options.headers, {
            Authorization: "Bearer test",
            "x-opencode-session": "auth-session",
            "x-OPENCode-client": "auth-client",
        });
        assert.deepEqual(request.model, {
            provider: "opencode",
            id: "test-model",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
        });
        assert.deepEqual(model.headers, {
            "X-OpenCode-Session": "model-session",
            "X-OpenCode-Client": "model-client",
        });
    });

    void it("handoff captures source session before the destination session switch", async () => {
        const invocations: Invocation[] = [];
        let currentSession = "handoff-source";
        const model = {
            provider: "opencode-go",
            id: "test-model",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
            headers: {
                "X-OpenCode-Session": null,
                "X-OpenCode-Client": "model-client",
            },
        };
        const { pi, handlers } = commandRegistrar();
        registerHandoff(
            pi,
            new TauState(),
            completeCapture(invocations),
            () => ({ signal: new AbortController().signal }) as never
        );
        const handler = handlers.get("handoff")!;
        const ctx = {
            hasUI: true,
            cwd: "/tmp",
            model,
            sessionManager: {
                getSessionId: () => currentSession,
                getBranch: () => [
                    {
                        type: "message",
                        id: "entry-1",
                        parentId: null,
                        timestamp: new Date().toISOString(),
                        message: {
                            role: "user",
                            content: "hello",
                            timestamp: Date.now(),
                        },
                    },
                ],
                getSessionFile: () => "/tmp/source-session.jsonl",
            },
            modelRegistry: {
                getApiKeyAndHeaders: async () => ({
                    ok: true,
                    apiKey: "fake-key",
                    headers: {
                        Authorization: "Bearer test",
                        "x-opencode-client": "auth-client",
                    },
                }),
            },
            ui: {
                notify() {},
                custom: async (
                    factory: (
                        tui: unknown,
                        theme: unknown,
                        kb: unknown,
                        done: (value: string | null) => void
                    ) => unknown
                ) =>
                    new Promise<string | null>((resolve, reject) => {
                        let component: { dispose?: () => void } | undefined;
                        const done = (value: string | null) => {
                            component?.dispose?.();
                            resolve(value);
                        };
                        try {
                            component = factory(
                                { requestRender() {} },
                                {
                                    fg: (_color: string, text: string) => text,
                                    bold: (text: string) => text,
                                },
                                {},
                                done
                            ) as { dispose?: () => void };
                        } catch (error) {
                            reject(
                                error instanceof Error
                                    ? error
                                    : new Error(String(error))
                            );
                        }
                    }),
                editor: async (_label: string, value: string) => value,
                setEditorText() {},
            },
            newSession: async (options: {
                withSession: (ctx: unknown) => Promise<void>;
            }) => {
                currentSession = "destination-session";
                await options.withSession({
                    ui: { setEditorText() {}, notify() {} },
                });
                return { cancelled: false };
            },
        } as never;

        await handler("transfer this" as never, ctx);

        assert.equal(invocations.length, 1);
        const request = invocations[0];
        assert.equal(request.options.sessionId, "handoff-source");
        assert.deepEqual(request.options.headers, {
            Authorization: "Bearer test",
            "X-OpenCode-Session": null,
            "x-opencode-client": "auth-client",
        });
        assert.deepEqual(request.model, {
            provider: "opencode-go",
            id: "test-model",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
        });
        assert.deepEqual(model.headers, {
            "X-OpenCode-Session": null,
            "X-OpenCode-Client": "model-client",
        });
        assert.equal(currentSession, "destination-session");
    });

    void it("ordinary providers receive no OpenCode tracking options", async () => {
        const invocations: Invocation[] = [];
        const model = {
            provider: "openai",
            id: "test-model",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            headers: {},
        };
        const { pi, handlers } = commandRegistrar();
        registerSummarize(pi, new TauState(), {
            complete: completeCapture(invocations),
            getModel: (() => model) as never,
        });
        await handlers.get("summarize")!(
            "" as never,
            {
                hasUI: false,
                sessionManager: {
                    getSessionId: () => "ordinary-session",
                    getBranch: () => [
                        {
                            type: "message",
                            message: { role: "user", content: "hello" },
                        },
                    ],
                },
                modelRegistry: {
                    getApiKeyAndHeaders: async () => ({
                        ok: true,
                        apiKey: "fake-key",
                        headers: { Authorization: "Bearer test" },
                    }),
                },
                ui: { notify() {} },
            } as never
        );

        assert.equal(invocations.length, 1);
        assert.equal(invocations[0].options.sessionId, "ordinary-session");
        assert.deepEqual(invocations[0].options.headers, {
            Authorization: "Bearer test",
        });
    });
});
