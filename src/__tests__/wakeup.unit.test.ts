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
    WAKEUP_HEARTBEAT_MAX_ITEMS,
    WAKEUP_IDLE_RECHECK_MS,
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

interface TelemetryEntry {
    customType: string;
    data: Record<string, unknown>;
}

function makePi() {
    const sent: SentMessage[] = [];
    const cancelled: string[] = [];
    const entries: TelemetryEntry[] = [];
    return {
        sent,
        cancelled,
        entries,
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
            appendEntry(customType: string, data: Record<string, unknown>) {
                entries.push({ customType, data });
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

function attentionRegistry(
    provider: Record<string, unknown>,
    version = 1
): {
    version: number;
    providers: Map<string, unknown>;
} {
    return {
        version,
        providers: new Map([[provider.name as string, provider]]),
    };
}

void describe("autonomous wake evaluation", () => {
    void beforeEach(() =>
        mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] })
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

    void it("does not wake for no work or for running work before the idle interval", () => {
        const state = new TauState();
        const queue = makePi();
        assert.equal(evaluateWakeup(queue.pi, state), false);
        state.backgroundJobs.set("run", job("run", "running"));
        const now = Date.now();
        const heartbeat = {
            now: () => now,
            intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
            parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS + 1,
        };
        // A healthy run is not actionable, and a wake inside the interval would
        // interrupt a parent whose cache is still warm.
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", heartbeat),
            false
        );
        assert.equal(evaluateWakeup(queue.pi, state), false);
        assert.equal(queue.sent.length, 0);
    });

    void it("heartbeats running work once the parent has idled a full interval", () => {
        const state = new TauState();
        state.backgroundJobs.set("run", job("run", "running"));
        const queue = makePi();
        const now = Date.now();
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                now: () => now,
                intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
            }),
            true
        );
        assert.equal(queue.sent.length, 1);
        assert.equal(queue.sent[0].options.queueKey, WAKEUP_QUEUE_KEY);
        assert.equal(queue.sent[0].options.triggerTurn, true);
        assert.match(
            queue.sent[0].message.content,
            /Autonomous heartbeat: 1 background item still running/
        );
        assert.match(
            queue.sent[0].message.content,
            /job run: echo test \| running/
        );
        assert.match(
            queue.sent[0].message.content,
            /No action needed unless one looks stuck/
        );
        assert.match(queue.sent[0].message.content, /Next heartbeat in 4m0s/);
        assert.equal(state.wakeupLastHeartbeatAt, now);
        // The heartbeat must not consume the attention signature.
        assert.equal(state.wakeupLastSignature, undefined);
        assert.deepEqual(
            queue.entries.map((entry) => entry.data.event),
            ["heartbeat-sent"]
        );
    });

    void it("records provider session identity mismatches once per idle gap", () => {
        const restore = installBackgroundWorkRegistry(
            attentionRegistry({
                name: "subagents",
                listActiveWork: () => [
                    { id: "child", sessionId: "/sessions/other.jsonl" },
                ],
            })
        );
        try {
            const queue = makePi();
            const state = new TauState();
            const now = Date.now();
            const options = {
                now: () => now,
                intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
            };
            assert.equal(
                evaluateWakeup(
                    queue.pi,
                    state,
                    "/sessions/current.jsonl",
                    options
                ),
                false
            );
            assert.equal(
                evaluateWakeup(
                    queue.pi,
                    state,
                    "/sessions/current.jsonl",
                    options
                ),
                false
            );
            const mismatchEntries = queue.entries.filter(
                (entry) => entry.data.event === "heartbeat-skip-no-sources"
            );
            assert.equal(mismatchEntries.length, 1);
            assert.equal(mismatchEntries[0].data.providerItems, 1);
            assert.equal(
                mismatchEntries[0].data.unmatchedSessionIdKind,
                "path"
            );
            assert.equal(queue.sent.length, 0);
        } finally {
            restore();
        }

        const restoreEmpty = installBackgroundWorkRegistry(
            attentionRegistry({
                name: "subagents",
                listActiveWork: () => [],
            })
        );
        try {
            const queue = makePi();
            const now = Date.now();
            assert.equal(
                evaluateWakeup(queue.pi, new TauState(), "session", {
                    now: () => now,
                    intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                    parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
                }),
                false
            );
            assert.equal(
                queue.entries.some(
                    (entry) => entry.data.event === "heartbeat-skip-no-sources"
                ),
                false
            );
        } finally {
            restoreEmpty();
        }
    });

    void it("heartbeats provider active work using its v2 summary", () => {
        const restore = installBackgroundWorkRegistry(
            attentionRegistry(
                {
                    name: "subagents",
                    listActiveWork: () => [
                        {
                            id: "run-1",
                            sessionId: "session",
                            summary:
                                "run-1 | running | 12m | step 1/2 | active 4s ago",
                        },
                        {
                            id: "run-2",
                            sessionId: "other",
                            summary: "other run",
                        },
                    ],
                },
                2
            )
        );
        try {
            const queue = makePi();
            const now = Date.now();
            assert.equal(
                evaluateWakeup(queue.pi, new TauState(), "session", {
                    now: () => now,
                    intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                    parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
                }),
                true
            );
            assert.match(
                queue.sent[0].message.content,
                /subagents\/run-1: run-1 \| running \| 12m \| step 1\/2 \| active 4s ago/
            );
            assert.doesNotMatch(queue.sent[0].message.content, /other run/);
            assert.equal(
                queue.entries.some(
                    (entry) => entry.data.event === "heartbeat-skip-no-sources"
                ),
                false
            );
        } finally {
            restore();
        }
    });

    void it("keeps a v1 provider readable but refuses a summary it cannot declare", () => {
        const restoreOne = installBackgroundWorkRegistry(
            attentionRegistry({
                name: "subagents",
                listActiveWork: () => [{ id: "run-1", sessionId: "session" }],
            })
        );
        try {
            const queue = makePi();
            const now = Date.now();
            assert.equal(
                evaluateWakeup(queue.pi, new TauState(), "session", {
                    now: () => now,
                    intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                    parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
                }),
                true
            );
            assert.match(
                queue.sent[0].message.content,
                /subagents\/run-1: running/
            );
        } finally {
            restoreOne();
        }

        const restoreTwo = installBackgroundWorkRegistry(
            attentionRegistry(
                {
                    name: "subagents",
                    listActiveWork: () => [
                        {
                            id: "run-1",
                            sessionId: "session",
                            summary: "line one\nline two",
                        },
                    ],
                },
                2
            )
        );
        try {
            const state = new TauState();
            const queue = makePi();
            const now = Date.now();
            assert.equal(
                evaluateWakeup(queue.pi, state, "session", {
                    now: () => now,
                    intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                    parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
                }),
                false
            );
            assert.equal(queue.sent.length, 0);
            const [failure] = queue.entries;
            assert.equal(failure?.customType, "tau_wakeup_telemetry");
            assert.deepEqual(
                {
                    event: failure?.data.event,
                    failure: failure?.data.failure,
                },
                { event: "registry-failure", failure: "malformed-item" }
            );
        } finally {
            restoreTwo();
        }
    });

    void it("keeps an attention wake ahead of the heartbeat", () => {
        const state = new TauState();
        state.backgroundJobs.set("run", job("run", "running"));
        state.recentTerminalJobs.push(job("done", "failed"));
        const queue = makePi();
        const now = Date.now();
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                now: () => now,
                intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
            }),
            true
        );
        assert.equal(queue.sent.length, 1);
        assert.match(queue.sent[0].message.content, /need attention/);
        assert.doesNotMatch(
            queue.sent[0].message.content,
            /Autonomous heartbeat/
        );
    });

    void it("bounds the heartbeat item list and counts the remainder", () => {
        const state = new TauState();
        for (let index = 0; index < WAKEUP_HEARTBEAT_MAX_ITEMS + 3; index++) {
            state.backgroundJobs.set(
                `run-${index}`,
                job(`run-${index}`, "running")
            );
        }
        const queue = makePi();
        const now = Date.now();
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                now: () => now,
                intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
                parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
            }),
            true
        );
        const content = queue.sent[0].message.content;
        assert.match(content, /11 background items still running/);
        assert.match(content, /- and 3 more/);
        assert.ok(content.length <= WAKEUP_MESSAGE_MAX_CHARS);
    });

    void it("replaces the queued heartbeat on the next interval instead of stacking", () => {
        const state = new TauState();
        state.backgroundJobs.set("run", job("run", "running"));
        const queue = makePi();
        // Ordered log: what matters is that no send can happen while an earlier
        // wake is still queued, which send counts alone cannot show.
        const log: string[] = [];
        const instrumented = queue.pi as unknown as {
            sendMessage: (
                message: SentMessage["message"],
                options: SentMessage["options"]
            ) => void;
            cancelQueuedMessage: (key: string) => void;
        };
        const sendOriginal = instrumented.sendMessage;
        const cancelOriginal = instrumented.cancelQueuedMessage;
        instrumented.sendMessage = (message, options) => {
            log.push("send");
            sendOriginal(message, options);
        };
        instrumented.cancelQueuedMessage = (key) => {
            log.push("cancel");
            cancelOriginal(key);
        };
        const first = Date.now();
        const anchor = first - WAKEUP_DEFAULT_INTERVAL_MS;
        const options = {
            intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
            parentRequestStartedAt: anchor,
        };
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                ...options,
                now: () => first,
            }),
            true
        );
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                ...options,
                now: () => first + WAKEUP_DEFAULT_INTERVAL_MS,
            }),
            true
        );
        assert.deepEqual(
            queue.sent.map((sent) => sent.options.queueKey),
            [WAKEUP_QUEUE_KEY, WAKEUP_QUEUE_KEY]
        );
        // The host queue appends by key, so "one wake in flight" only holds if
        // each send retracts the previous one first. Two consecutive sends in
        // this log is the stacking bug.
        const sendPositions = log.flatMap((entry, index) =>
            entry === "send" ? [index] : []
        );
        assert.equal(sendPositions.length, 2);
        assert.ok(log.slice(0, sendPositions[1]).includes("cancel"));
        assert.equal(state.wakeupQueuedKind, "heartbeat");
        assert.equal(
            queue.entries.filter(
                (entry) => entry.data.event === "heartbeat-sent"
            ).length,
            2
        );
    });

    void it("retracts a queued heartbeat before replacing it with an attention wake", () => {
        const state = new TauState();
        state.backgroundJobs.set("run", job("run", "running"));
        const queue = makePi();
        const now = Date.now();
        const options = {
            intervalMs: WAKEUP_DEFAULT_INTERVAL_MS,
            parentRequestStartedAt: now - WAKEUP_DEFAULT_INTERVAL_MS,
        };
        // Heartbeat only: nothing is actionable yet.
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                ...options,
                now: () => now,
            }),
            true
        );
        assert.equal(queue.sent.length, 1);
        assert.equal(state.wakeupQueuedKind, "heartbeat");
        const cancelledAfterHeartbeat = queue.cancelled.length;
        assert.ok(cancelledAfterHeartbeat >= 1);

        // A failure lands while the heartbeat is still queued. The attention
        // wake must retract that heartbeat, or the session runs two turns.
        state.recentTerminalJobs.push(job("done", "failed"));
        assert.equal(
            evaluateWakeup(queue.pi, state, "session", {
                ...options,
                now: () => now + 1_000,
            }),
            true
        );
        assert.equal(queue.sent.length, 2);
        assert.match(queue.sent[1].message.content, /need attention/);
        assert.equal(queue.cancelled.at(-1), WAKEUP_QUEUE_KEY);
        assert.ok(queue.cancelled.length > cancelledAfterHeartbeat);
        assert.equal(state.wakeupQueuedKind, "attention");
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

    void it("fails closed for actual NUL characters in provider input", () => {
        const nul = String.fromCharCode(0);
        const state = new TauState();
        state.recentTerminalJobs.push(job("local", "failed"));
        const restore = installBackgroundWorkRegistry(
            attentionRegistry({
                name: `bad${nul}provider`,
                listActiveWork: () => [],
                listAttentionWork: () => [{ id: "item", sessionId: "session" }],
            })
        );
        try {
            const queue = makePi();
            assert.equal(evaluateWakeup(queue.pi, state, "session"), true);
            assert.match(queue.sent[0].message.content, /local/);
            assert.doesNotMatch(queue.sent[0].message.content, /bad/);
        } finally {
            restore();
        }

        const itemProvider = {
            name: "provider",
            listActiveWork: () => [],
            listAttentionWork: () => [
                { id: `bad${nul}item`, sessionId: "session" },
            ],
        };
        const itemState = new TauState();
        itemState.recentTerminalJobs.push(job("local", "failed"));
        const restoreItem = installBackgroundWorkRegistry(
            attentionRegistry(itemProvider)
        );
        try {
            const queue = makePi();
            assert.equal(evaluateWakeup(queue.pi, itemState, "session"), true);
            assert.match(queue.sent[0].message.content, /local/);
            assert.doesNotMatch(queue.sent[0].message.content, /bad/);
        } finally {
            restoreItem();
        }
    });

    void it("keeps provider and item identifiers distinct when they contain colons", () => {
        const providers = new Map([
            [
                "a:b",
                {
                    name: "a:b",
                    listActiveWork: () => [],
                    listAttentionWork: () => [
                        { id: "c", sessionId: "session" },
                    ],
                },
            ],
            [
                "a",
                {
                    name: "a",
                    listActiveWork: () => [],
                    listAttentionWork: () => [
                        { id: "b:c", sessionId: "session" },
                    ],
                },
            ],
        ]);
        const restore = installBackgroundWorkRegistry({
            version: 1,
            providers,
        });
        try {
            const queue = makePi();
            assert.equal(
                evaluateWakeup(queue.pi, new TauState(), "session"),
                true
            );
            assert.match(queue.sent[0].message.content, /a:b\/c/);
            assert.match(queue.sent[0].message.content, /a\/b:c/);
        } finally {
            restore();
        }
    });

    void it("fails closed before iterating an oversized provider registry", () => {
        let calls = 0;
        const providers = new Map(
            Array.from({ length: 101 }, (_, index) => {
                const name = `provider-${index}`;
                return [
                    name,
                    {
                        name,
                        listActiveWork: () => [],
                        listAttentionWork: () => {
                            calls++;
                            return [];
                        },
                    },
                ];
            })
        );
        const restore = installBackgroundWorkRegistry({
            version: 1,
            providers,
        });
        try {
            const state = new TauState();
            state.recentTerminalJobs.push(job("local", "failed"));
            const queue = makePi();
            assert.equal(evaluateWakeup(queue.pi, state, "session"), true);
            assert.equal(calls, 0);
            assert.match(queue.sent[0].message.content, /local/);
        } finally {
            restore();
        }
    });

    void it("fails closed before iterating an oversized provider item list", () => {
        let itemAccesses = 0;
        const items = Array<{ id: string; sessionId: string }>(10_001);
        Object.defineProperty(items, "0", {
            enumerable: true,
            get: () => {
                itemAccesses++;
                return { id: "item", sessionId: "session" };
            },
        });
        const restore = installBackgroundWorkRegistry(
            attentionRegistry({
                name: "provider",
                listActiveWork: () => [],
                listAttentionWork: () => items,
            })
        );
        try {
            const state = new TauState();
            state.recentTerminalJobs.push(job("local", "failed"));
            const queue = makePi();
            assert.equal(evaluateWakeup(queue.pi, state, "session"), true);
            assert.equal(itemAccesses, 0);
            assert.match(queue.sent[0].message.content, /local/);
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
        // One retraction before each send: the host queue appends by key.
        assert.deepEqual(queue.cancelled, [WAKEUP_QUEUE_KEY, WAKEUP_QUEUE_KEY]);
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
        // One retraction before the send (the queue appends, it does not
        // replace) and one after the acknowledgement cleared the state.
        assert.deepEqual(queue.cancelled, [WAKEUP_QUEUE_KEY, WAKEUP_QUEUE_KEY]);
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

    void it("does not evaluate or reschedule a timer tick after shutdown begins", async () => {
        const session = await startTimerSession({
            initialState: (state) =>
                state.recentTerminalJobs.push(job("failed", "failed")),
        });
        try {
            session.state.wakeupShutdownBegun = true;
            assert.equal(
                evaluateWakeup(
                    session.queue.pi,
                    session.state,
                    "session-current"
                ),
                false
            );
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS);
            assert.equal(session.queue.sent.length, 0);

            // If the shutdown-time tick re-armed itself, clearing the fence for
            // this assertion would let the next interval expose that timer.
            session.state.wakeupShutdownBegun = false;
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS * 2);
            assert.equal(session.queue.sent.length, 0);
        } finally {
            await session.cleanup();
        }
    });

    /** Register the wakeup timer against a temp cwd and a scripted parent. */
    async function startTimerSession(options: {
        settings?: Record<string, unknown>;
        initialState?: (state: TauState) => void;
        isIdle?: () => boolean;
        sessionId?: string;
        sessionFile?: string;
        provider?: Record<string, unknown>;
    }) {
        const cwd = mkdtempSync(join("/tmp", "pi-tau-wakeup-"));
        mkdirSync(join(cwd, ".pi"));
        writeFileSync(
            join(cwd, ".pi", "settings.json"),
            JSON.stringify(options.settings ?? {})
        );
        const state = new TauState();
        options.initialState?.(state);
        const queue = makePi();
        const restoreRegistry = options.provider
            ? installBackgroundWorkRegistry(attentionRegistry(options.provider))
            : (): void => {};
        const handlers = new Map<
            string,
            (event: unknown, ctx: Record<string, unknown>) => unknown
        >();
        (
            queue.pi as unknown as {
                on: (
                    event: string,
                    fn: (
                        event: unknown,
                        ctx: Record<string, unknown>
                    ) => unknown
                ) => void;
            }
        ).on = (event, fn) => handlers.set(event, fn);
        registerWakeup(queue.pi, state);
        const sessionContext = {
            cwd,
            sessionManager: {
                getSessionId: () => options.sessionId ?? "session-current",
                ...(options.sessionFile === undefined
                    ? {}
                    : { getSessionFile: () => options.sessionFile }),
            },
            isIdle: options.isIdle ?? (() => true),
        };
        await handlers.get("session_start")?.({}, sessionContext);
        return {
            state,
            queue,
            handlers,
            sessionContext,
            cleanup: async (): Promise<void> => {
                await handlers.get("session_shutdown")?.({}, sessionContext);
                restoreRegistry();
                rmSync(cwd, { recursive: true, force: true });
            },
        };
    }

    void it("matches provider work against the path-first session file identity", async () => {
        const session = await startTimerSession({
            sessionFile: "/sessions/current.jsonl",
            provider: {
                name: "subagents",
                listActiveWork: () => [
                    { id: "child", sessionId: "/sessions/current.jsonl" },
                ],
                listAttentionWork: () => [],
            },
        });
        try {
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS);
            assert.equal(session.queue.sent.length, 1);
            assert.match(
                session.queue.sent[0].message.content,
                /subagents\/child: running/
            );
            assert.equal(
                session.queue.entries.some(
                    (entry) => entry.data.event === "heartbeat-sent"
                ),
                true
            );
        } finally {
            await session.cleanup();
        }
    });

    void it("falls back to UUID session identity when no session file exists", async () => {
        const sessionId = "f6a1e9ef-d6ad-4aa8-a7ad-d61ee99f80ce";
        const session = await startTimerSession({
            sessionId,
            provider: {
                name: "subagents",
                listActiveWork: () => [{ id: "child", sessionId }],
                listAttentionWork: () => [],
            },
        });
        try {
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS);
            assert.equal(session.queue.sent.length, 1);
            assert.match(
                session.queue.sent[0].message.content,
                /subagents\/child: running/
            );
        } finally {
            await session.cleanup();
        }
    });

    void it("heartbeats a running job from the timer without any configuration", async () => {
        const session = await startTimerSession({
            initialState: (state) =>
                state.backgroundJobs.set("run", job("run", "running")),
        });
        try {
            // No tau.wakeup block: both rules are on by default.
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS - 1);
            assert.equal(session.queue.sent.length, 0);
            mock.timers.tick(1);
            assert.equal(session.queue.sent.length, 1);
            assert.match(
                session.queue.sent[0].message.content,
                /Autonomous heartbeat: 1 background item still running/
            );
            assert.equal(session.state.wakeupLastHeartbeatAt, Date.now());
        } finally {
            await session.cleanup();
        }
    });

    void it("resamples a busy parent instead of waking it", async () => {
        let idle = false;
        const session = await startTimerSession({
            isIdle: () => idle,
            initialState: (state) =>
                state.backgroundJobs.set("run", job("run", "running")),
        });
        try {
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS);
            assert.equal(session.queue.sent.length, 0);
            assert.deepEqual(
                session.queue.entries.map((entry) => entry.data.event),
                ["heartbeat-resampled"]
            );
            idle = true;
            mock.timers.tick(WAKEUP_IDLE_RECHECK_MS);
            assert.equal(session.queue.sent.length, 1);
        } finally {
            await session.cleanup();
        }
    });

    void it("re-anchors the deadline to each new parent request", async () => {
        const session = await startTimerSession({
            initialState: (state) =>
                state.backgroundJobs.set("run", job("run", "running")),
        });
        try {
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS - 1);
            await session.handlers.get("message_start")?.(
                { message: { role: "assistant" } },
                session.sessionContext
            );
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS - 1);
            assert.equal(session.queue.sent.length, 0);
            mock.timers.tick(1);
            assert.equal(session.queue.sent.length, 1);
        } finally {
            await session.cleanup();
        }
    });

    void it("retracts a queued heartbeat when a parent request starts", async () => {
        const session = await startTimerSession({
            // Idle for the probe but settling underneath: the host queues the
            // follow-up instead of delivering it, which is the window where a
            // heartbeat can go stale.
            isIdle: () => true,
            initialState: (state) =>
                state.backgroundJobs.set("run", job("run", "running")),
        });
        try {
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS);
            assert.equal(session.queue.sent.length, 1);
            assert.equal(session.state.wakeupQueuedKind, "heartbeat");
            const cancelledBefore = session.queue.cancelled.length;
            await session.handlers.get("message_start")?.(
                { message: { role: "assistant" } },
                session.sessionContext
            );
            // The request that just started is the news the heartbeat wanted
            // to deliver, so it must be retracted rather than spend a turn.
            assert.equal(session.queue.cancelled.length, cancelledBefore + 1);
            assert.equal(session.queue.cancelled.at(-1), WAKEUP_QUEUE_KEY);
            assert.equal(session.state.wakeupQueuedKind, undefined);
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS - 1);
            assert.equal(session.queue.sent.length, 1);
        } finally {
            await session.cleanup();
        }
    });

    void it("honours an explicit opt-out", async () => {
        const session = await startTimerSession({
            settings: { tau: { wakeup: { enabled: false } } },
            initialState: (state) =>
                state.backgroundJobs.set("run", job("run", "running")),
        });
        try {
            mock.timers.tick(WAKEUP_DEFAULT_INTERVAL_MS * 3);
            assert.equal(session.queue.sent.length, 0);
        } finally {
            await session.cleanup();
        }
    });
});
