import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";
import {
    evaluateWakeup,
    registerWakeup,
    WAKEUP_DEFAULT_INTERVAL_MS,
    WAKEUP_MAX_INTERVAL_MS,
    WAKEUP_MESSAGE_MAX_CHARS,
    WAKEUP_MIN_INTERVAL_MS,
    WAKEUP_QUEUE_KEY,
    parseWakeupConfig,
} from "../features/wakeup.ts";

interface SentMessage {
    message: { customType: string; content: string; display: boolean };
    options: { deliverAs: string; triggerTurn: boolean; queueKey: string };
}

function makePi() {
    const sent: SentMessage[] = [];
    const cancelled: string[] = [];
    return {
        sent,
        cancelled,
        pi: {
            sendMessage(
                message: SentMessage["message"],
                options: SentMessage["options"]
            ) {
                sent.push({ message, options });
            },
            cancelQueuedMessage(key: string) {
                cancelled.push(key);
            },
            on() {},
        } as never,
    };
}

function job(id: string, status: BackgroundJob["status"]): BackgroundJob {
    return {
        id,
        command: "echo test",
        pid: 1,
        startTime: Date.now(),
        status,
        logPath: `/tmp/${id}.log`,
        toolCallId: `tc-${id}`,
        isBackgrounded: true,
    };
}

const BACKGROUND_WORK_REGISTRY_KEY = Symbol.for(
    "pi-subagents.background-work.v1"
);

function installBackgroundWorkRegistry(value: unknown): () => void {
    const globalObject = globalThis as Record<PropertyKey, unknown>;
    const previous = globalObject[BACKGROUND_WORK_REGISTRY_KEY];
    globalObject[BACKGROUND_WORK_REGISTRY_KEY] = value;
    return () => {
        if (previous === undefined)
            delete globalObject[BACKGROUND_WORK_REGISTRY_KEY];
        else globalObject[BACKGROUND_WORK_REGISTRY_KEY] = previous;
    };
}

function attentionRegistry(provider: Record<string, unknown>): {
    version: number;
    providers: Map<string, unknown>;
} {
    return {
        version: 1,
        providers: new Map([[provider.name as string, provider]]),
    };
}

void describe("autonomous wake evaluation", () => {
    void beforeEach(() =>
        mock.timers.enable({ apis: ["setInterval", "Date"] })
    );
    void afterEach(() => mock.timers.reset());

    void it("parses opt-in settings and clamps explicit interval bounds", () => {
        assert.deepEqual(parseWakeupConfig({ enabled: true }), {
            enabled: true,
            intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
        });
        assert.equal(
            parseWakeupConfig({ enabled: true, intervalMs: 1 })?.intervalMs,
            WAKEUP_MIN_INTERVAL_MS
        );
        assert.equal(
            parseWakeupConfig({ enabled: true, intervalMs: Infinity })
                ?.intervalMs,
            WAKEUP_DEFAULT_INTERVAL_MS
        );
        assert.equal(
            parseWakeupConfig({ enabled: true, intervalMs: Number.MAX_VALUE })
                ?.intervalMs,
            WAKEUP_MAX_INTERVAL_MS
        );
    });

    void it("does not wake for no work or a healthy running job", () => {
        const state = new TauState();
        const queue = makePi();
        assert.equal(evaluateWakeup(queue.pi, state), false);
        state.backgroundJobs.set("run", job("run", "running"));
        assert.equal(evaluateWakeup(queue.pi, state), false);
        assert.equal(queue.sent.length, 0);
    });

    void it("fails closed for an absent or malformed provider registry", () => {
        const state = new TauState();
        const queue = makePi();
        const restoreAbsent = installBackgroundWorkRegistry(undefined);
        try {
            assert.equal(evaluateWakeup(queue.pi, state, "session"), false);
        } finally {
            restoreAbsent();
        }

        const restoreMalformedRegistry = installBackgroundWorkRegistry({
            version: 1,
            providers: [],
        });
        try {
            assert.equal(evaluateWakeup(queue.pi, state, "session"), false);
        } finally {
            restoreMalformedRegistry();
        }

        state.recentTerminalJobs.push(job("done", "failed"));
        const restoreMalformedProvider = installBackgroundWorkRegistry({
            version: 1,
            providers: new Map([
                ["bad", { name: "bad", listAttentionWork: 1 }],
            ]),
        });
        try {
            assert.equal(evaluateWakeup(queue.pi, state, "session"), true);
            assert.match(queue.sent[0].message.content, /done/);
        } finally {
            restoreMalformedProvider();
        }
    });

    void it("filters provider attention to the exact session", () => {
        const provider = {
            name: "subagents",
            listActiveWork: () => [{ id: "running", sessionId: "current" }],
            listAttentionWork: () => [
                { id: "other", sessionId: "other-session" },
                { id: "current", sessionId: "current-session" },
            ],
        };
        const restore = installBackgroundWorkRegistry(
            attentionRegistry(provider)
        );
        try {
            const queue = makePi();
            assert.equal(
                evaluateWakeup(queue.pi, new TauState(), "current-session"),
                true
            );
            assert.match(queue.sent[0].message.content, /subagents\/current/);
            assert.doesNotMatch(queue.sent[0].message.content, /other/);
        } finally {
            restore();
        }
    });

    void it("includes and deduplicates provider attention without waking for active work", () => {
        let activeCalls = 0;
        const provider = {
            name: "subagents",
            listActiveWork: () => {
                activeCalls++;
                return [{ id: "healthy", sessionId: "session" }];
            },
            listAttentionWork: () => [
                { id: "needs-review", sessionId: "session" },
                { id: "needs-review", sessionId: "session" },
            ],
        };
        const restore = installBackgroundWorkRegistry(
            attentionRegistry(provider)
        );
        try {
            const queue = makePi();
            assert.equal(
                evaluateWakeup(queue.pi, new TauState(), "session"),
                true
            );
            assert.equal(activeCalls, 0);
            assert.equal(
                (queue.sent[0].message.content.match(/needs-review/g) ?? [])
                    .length,
                1
            );
        } finally {
            restore();
        }
    });

    void it("fails closed when a provider throws", () => {
        const provider = {
            name: "broken",
            listActiveWork: () => [],
            listAttentionWork: () => {
                throw new Error("provider unavailable");
            },
        };
        const restore = installBackgroundWorkRegistry(
            attentionRegistry(provider)
        );
        try {
            const state = new TauState();
            const queue = makePi();
            assert.equal(evaluateWakeup(queue.pi, state, "session"), false);
            state.recentTerminalJobs.push(job("local", "failed"));
            assert.equal(evaluateWakeup(queue.pi, state, "session"), true);
            assert.doesNotMatch(
                queue.sent[0].message.content,
                /provider unavailable/
            );
        } finally {
            restore();
        }
    });

    void it("does not enqueue a duplicate wake for an unchanged provider item", () => {
        const provider = {
            name: "subagents",
            listActiveWork: () => [],
            listAttentionWork: () => [
                { id: "needs-review", sessionId: "session" },
            ],
        };
        const restore = installBackgroundWorkRegistry(
            attentionRegistry(provider)
        );
        try {
            const queue = makePi();
            const state = new TauState();
            assert.equal(evaluateWakeup(queue.pi, state, "session"), true);
            assert.equal(evaluateWakeup(queue.pi, state, "session"), false);
            assert.equal(queue.sent.length, 1);
        } finally {
            restore();
        }
    });

    void it("delivers one keyed follow-up across busy, settlement, and idle boundaries", () => {
        const state = new TauState();
        state.recentTerminalJobs.push(job("done", "failed"));
        let busy = true;
        const queued: SentMessage[] = [];
        const delivered: SentMessage[] = [];
        const queue = makePi();
        (
            queue.pi as unknown as {
                sendMessage: (
                    message: SentMessage["message"],
                    options: SentMessage["options"]
                ) => void;
            }
        ).sendMessage = (message, options) => {
            const item = { message, options };
            if (busy) queued.push(item);
            else delivered.push(item);
        };
        assert.equal(evaluateWakeup(queue.pi, state), true);
        assert.equal(queued.length, 1);
        busy = false;
        delivered.push(...queued.splice(0));
        assert.equal(delivered[0]?.options.queueKey, WAKEUP_QUEUE_KEY);
        state.recentTerminalJobs.push(job("done-2", "failed"));
        evaluateWakeup(queue.pi, state);
        assert.equal(delivered.length, 2);
    });

    void it("wakes for actionable decisions, failed jobs, paused state, and queued agents", () => {
        const state = new TauState();
        const queue = makePi();
        const pending = job("decide", "running");
        state.backgroundJobs.set(pending.id, pending);
        state.pendingDecisionJobId = pending.id;
        state.recentTerminalJobs.push(job("failed", "failed"));
        state.agentBackgrounded = true;
        state.pendingBackgroundAgents.set("agent", {
            jobId: "agent",
            promptFile: "/tmp/prompt",
            execCwd: "/tmp",
            conversationBytes: 1,
            contextWindowTokens: 1,
        });

        assert.equal(evaluateWakeup(queue.pi, state), true);
        assert.equal(queue.sent.length, 1);
        assert.equal(queue.sent[0].message.customType, "tau-autonomous-wake");
        assert.equal(queue.sent[0].options.deliverAs, "followUp");
        assert.equal(queue.sent[0].options.triggerTurn, true);
        assert.equal(queue.sent[0].options.queueKey, WAKEUP_QUEUE_KEY);
        assert.ok(
            queue.sent[0].message.content.length <= WAKEUP_MESSAGE_MAX_CHARS
        );
    });

    void it("replaces the queued wake when the actionable snapshot changes", () => {
        const state = new TauState();
        const queue = makePi();
        const queued: SentMessage[] = [];
        (
            queue.pi as unknown as {
                sendMessage: (
                    message: SentMessage["message"],
                    options: SentMessage["options"]
                ) => void;
                cancelQueuedMessage: (key: string) => void;
            }
        ).sendMessage = (message, options) => queued.push({ message, options });
        (
            queue.pi as unknown as {
                cancelQueuedMessage: (key: string) => void;
            }
        ).cancelQueuedMessage = (key) => {
            queue.cancelled.push(key);
            for (let i = queued.length - 1; i >= 0; i--) {
                if (queued[i].options.queueKey === key) queued.splice(i, 1);
            }
        };
        state.recentTerminalJobs.push(job("done", "completed"));
        assert.equal(evaluateWakeup(queue.pi, state), true);
        assert.equal(evaluateWakeup(queue.pi, state), false);
        state.recentTerminalJobs.push(job("done-2", "completed"));
        assert.equal(evaluateWakeup(queue.pi, state), true);
        assert.equal(queued.length, 1);
        assert.match(queued[0].message.content, /done-2/);
        assert.deepEqual(queue.cancelled, [WAKEUP_QUEUE_KEY]);
    });

    void it("disables autonomous delivery on hosts without queue cancellation", () => {
        const state = new TauState();
        const queue = makePi();
        delete (queue.pi as unknown as { cancelQueuedMessage?: unknown })
            .cancelQueuedMessage;
        state.recentTerminalJobs.push(job("done", "completed"));
        assert.equal(evaluateWakeup(queue.pi, state), false);
        state.recentTerminalJobs.push(job("done-2", "completed"));
        assert.equal(evaluateWakeup(queue.pi, state), false);
        assert.equal(queue.sent.length, 0);
    });

    void it("cancels queued wake state after terminal work is acknowledged", () => {
        const state = new TauState();
        const queue = makePi();
        const done = job("done", "completed");
        state.recentTerminalJobs.push(done);
        evaluateWakeup(queue.pi, state);
        done.outputConsumed = true;
        assert.equal(evaluateWakeup(queue.pi, state), false);
        assert.deepEqual(queue.cancelled, [WAKEUP_QUEUE_KEY]);
    });

    void it("starts on session_start only when enabled and stops on shutdown", async () => {
        const cwd = mkdtempSync(join("/tmp", "pi-tau-wakeup-"));
        let restoreRegistry = (): void => {};
        try {
            mkdirSync(join(cwd, ".pi"));
            writeFileSync(
                join(cwd, ".pi", "settings.json"),
                JSON.stringify({
                    tau: {
                        wakeup: {
                            enabled: true,
                            intervalMs: WAKEUP_MIN_INTERVAL_MS,
                        },
                    },
                })
            );
            const state = new TauState();
            state.recentTerminalJobs.push(job("done", "failed"));
            const queue = makePi();
            restoreRegistry = installBackgroundWorkRegistry(
                attentionRegistry({
                    name: "subagents",
                    listActiveWork: () => [],
                    listAttentionWork: () => [
                        { id: "session-item", sessionId: "session-current" },
                    ],
                })
            );
            const handlers = new Map<
                string,
                (
                    event: unknown,
                    ctx: {
                        cwd: string;
                        sessionManager: { getSessionId(): string };
                    }
                ) => unknown
            >();
            (
                queue.pi as unknown as {
                    on: (
                        event: string,
                        fn: (
                            event: unknown,
                            ctx: {
                                cwd: string;
                                sessionManager: { getSessionId(): string };
                            }
                        ) => unknown
                    ) => void;
                }
            ).on = (event, fn) => handlers.set(event, fn);
            registerWakeup(queue.pi, state);
            const sessionContext = {
                cwd,
                sessionManager: { getSessionId: () => "session-current" },
            };
            await handlers.get("session_start")?.({}, sessionContext);
            mock.timers.tick(WAKEUP_MIN_INTERVAL_MS);
            assert.equal(queue.sent.length, 1);
            await handlers.get("session_shutdown")?.({}, sessionContext);
            assert.ok(queue.cancelled.includes(WAKEUP_QUEUE_KEY));
            mock.timers.tick(WAKEUP_MIN_INTERVAL_MS * 2);
            assert.equal(queue.sent.length, 1);
        } finally {
            restoreRegistry();
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
