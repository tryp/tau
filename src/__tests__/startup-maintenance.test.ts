import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schedulePeriodicTmuxRunDirCleanup } from "../features/bash-tmux.ts";
import {
    canRunSidecarPurge,
    scheduleSidecarPurge,
} from "../features/sidecar.ts";
import registerTau, { resolveMaintenanceDelayMs } from "../index.ts";
import { forEachWithinTimeBudget } from "../features/tmux-orphan-reaper.ts";
import { scheduleBackgroundJobRestore } from "../features/startup-maintenance.ts";

const realSetTimeout = globalThis.setTimeout;

interface TimerRecord {
    due: number;
    interval: number;
    callback: (...args: unknown[]) => void;
    unrefCalled: boolean;
    cleared: boolean;
    handle: ReturnType<typeof setTimeout>;
}

class FakeTimers {
    now = 0;
    readonly records: TimerRecord[] = [];

    private schedule(
        callback: (...args: unknown[]) => void,
        delay: number,
        interval: number
    ): ReturnType<typeof setTimeout> {
        const record: TimerRecord = {
            due: this.now + Math.max(0, delay),
            interval,
            callback,
            unrefCalled: false,
            cleared: false,
            handle: undefined as unknown as ReturnType<typeof setTimeout>,
        };
        record.handle = {
            unref: () => {
                record.unrefCalled = true;
                return record.handle;
            },
            ref: () => record.handle,
            hasRef: () => !record.unrefCalled,
            refresh: () => record.handle,
        } as unknown as ReturnType<typeof setTimeout>;
        this.records.push(record);
        return record.handle;
    }

    setTimeout = (
        callback: (...args: unknown[]) => void,
        delay = 0
    ): ReturnType<typeof setTimeout> => this.schedule(callback, delay, 0);

    setInterval = (
        callback: (...args: unknown[]) => void,
        delay = 0
    ): ReturnType<typeof setInterval> =>
        this.schedule(callback, delay, Math.max(1, delay));

    clear = (handle: ReturnType<typeof setTimeout>) => {
        const record = this.records.find((entry) => entry.handle === handle);
        if (record) record.cleared = true;
    };

    advance(ms: number): void {
        const target = this.now + ms;
        while (true) {
            const next = this.records
                .filter((record) => !record.cleared && record.due <= target)
                .sort((left, right) => left.due - right.due)[0];
            if (!next) break;
            this.now = next.due;
            if (next.interval === 0) next.cleared = true;
            else next.due += next.interval;
            next.callback();
        }
        this.now = target;
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
    }
    assert.ok(predicate(), "deferred startup maintenance did not run");
}

void describe("deferred startup maintenance", () => {
    void it("permits sidecar purge only after the turn is idle long enough", () => {
        assert.equal(canRunSidecarPurge(true, 0, 10_000), false);
        assert.equal(canRunSidecarPurge(false, 5_001, 10_000), false);
        assert.equal(canRunSidecarPurge(false, 5_000, 10_000), true);
    });

    void it("defers and unrefs sidecar purge and background-job restore", () => {
        const fakeTimers = new FakeTimers();
        const oldSetTimeout = globalThis.setTimeout;
        const oldClearTimeout = globalThis.clearTimeout;
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        let purges = 0;
        let restores = 0;
        try {
            scheduleSidecarPurge(() => {
                purges++;
            }, 5_000);
            scheduleBackgroundJobRestore(() => {
                restores++;
            });
            assert.equal(purges, 0);
            assert.equal(restores, 0);
            assert.equal(fakeTimers.records.length, 2);
            assert.ok(fakeTimers.records.every((timer) => timer.unrefCalled));
            assert.ok(
                fakeTimers.records.every((timer) => timer.due > fakeTimers.now)
            );
            fakeTimers.advance(99);
            assert.equal(purges, 0);
            assert.equal(restores, 0);
            fakeTimers.advance(1);
            assert.equal(restores, 1);
            assert.equal(purges, 0);
            fakeTimers.advance(4_900);
            assert.equal(purges, 1);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.clearTimeout = oldClearTimeout;
        }
    });

    void it("bounds configured maintenance delays to safe timer values", () => {
        assert.equal(resolveMaintenanceDelayMs(30_000), 30_000);
        assert.equal(resolveMaintenanceDelayMs(86_400_000), 86_400_000);
        assert.equal(resolveMaintenanceDelayMs(100_000_000), 86_400_000);
        assert.equal(resolveMaintenanceDelayMs(2_147_483_647), 86_400_000);
        assert.equal(resolveMaintenanceDelayMs(2_147_483_648), 30_000);
        assert.equal(resolveMaintenanceDelayMs(Number.NaN), 30_000);
    });

    void it("runs deferred tmux sweep only after idle and does not log to console", async () => {
        const fakeTimers = new FakeTimers();
        let idle = false;
        let runs = 0;
        const oldSetTimeout = globalThis.setTimeout;
        const oldSetInterval = globalThis.setInterval;
        const oldClearTimeout = globalThis.clearTimeout;
        const oldClearInterval = globalThis.clearInterval;
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.setInterval = fakeTimers.setInterval as typeof setInterval;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        globalThis.clearInterval = fakeTimers.clear as typeof clearInterval;
        try {
            schedulePeriodicTmuxRunDirCleanup({
                firstRunDelayMs: 30_000,
                isTestRunner: false,
                isIdle: () => idle,
                reapOrphans: async () => ({
                    examined: 0,
                    orphaned: 0,
                    killed: 0,
                    keptLive: 0,
                    keptFinished: 0,
                    keptGrowing: 0,
                    keptQuiet: 0,
                    keptUnverified: 0,
                    skippedBootMismatch: 0,
                    killEscalated: 0,
                    wouldKill: [],
                    wouldKillOmitted: 0,
                    intervalNotElapsed: 0,
                    chainAbandoned: 0,
                    stuckChainCount: 0,
                    stuckChains: [],
                }),
                cleanup: async () => {
                    runs++;
                    return {
                        examined: 0,
                        removed: 0,
                        keptAlive: 0,
                        keptUnknown: 0,
                    };
                },
            });
            fakeTimers.advance(30_000);
            assert.equal(runs, 0);
            idle = true;
            fakeTimers.advance(1_000);
            await waitFor(() => runs === 1);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
        }
    });

    void it("runs the deferred pass once and schedules recurring sweeps", async () => {
        const fakeTimers = new FakeTimers();
        const oldSetTimeout = globalThis.setTimeout;
        const oldSetInterval = globalThis.setInterval;
        const oldClearTimeout = globalThis.clearTimeout;
        const oldClearInterval = globalThis.clearInterval;
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.setInterval = fakeTimers.setInterval as typeof setInterval;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        globalThis.clearInterval = fakeTimers.clear as typeof clearInterval;
        let runs = 0;
        try {
            schedulePeriodicTmuxRunDirCleanup({
                firstRunDelayMs: 1,
                intervalMs: 10,
                isTestRunner: false,
                isIdle: () => true,
                reapOrphans: async () => ({
                    examined: 0,
                    orphaned: 0,
                    killed: 0,
                    keptLive: 0,
                    keptFinished: 0,
                    keptGrowing: 0,
                    keptQuiet: 0,
                    keptUnverified: 0,
                    skippedBootMismatch: 0,
                    killEscalated: 0,
                    wouldKill: [],
                    wouldKillOmitted: 0,
                    intervalNotElapsed: 0,
                    chainAbandoned: 0,
                    stuckChainCount: 0,
                    stuckChains: [],
                }),
                cleanup: async () => {
                    runs++;
                    return {
                        examined: 0,
                        removed: 0,
                        keptAlive: 0,
                        keptUnknown: 0,
                    };
                },
            });
            fakeTimers.advance(1);
            await waitFor(() => runs === 1);
            fakeTimers.advance(10);
            await waitFor(() => runs === 2);
            assert.equal(runs, 2);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
        }
    });

    void it("re-arms the retry ladder after a worker timeout rejection", async () => {
        const fakeTimers = new FakeTimers();
        const oldSetTimeout = globalThis.setTimeout;
        const oldSetInterval = globalThis.setInterval;
        const oldClearTimeout = globalThis.clearTimeout;
        const oldClearInterval = globalThis.clearInterval;
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.setInterval = fakeTimers.setInterval as typeof setInterval;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        globalThis.clearInterval = fakeTimers.clear as typeof clearInterval;
        try {
            schedulePeriodicTmuxRunDirCleanup({
                firstRunDelayMs: 1,
                isTestRunner: false,
                runSweep: async () => {
                    throw new Error("worker deadline");
                },
                isIdle: () => true,
                record: () => {},
            });
            fakeTimers.advance(1);
            await waitFor(() =>
                fakeTimers.records.some(
                    (timer) => timer.due === fakeTimers.now + 5_000
                )
            );
            assert.ok(
                fakeTimers.records.some(
                    (timer) => timer.interval === 0 && timer.due === 5_001
                )
            );
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
        }
    });

    void it("timer callbacks never write directly to console", async () => {
        const fakeTimers = new FakeTimers();
        const originals = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
        };
        let writes = 0;
        let complete = false;
        for (const method of Object.keys(originals) as Array<
            keyof typeof originals
        >) {
            console[method] = (() => {
                writes++;
            }) as (typeof console)[typeof method];
        }
        const oldSetTimeout = globalThis.setTimeout;
        const oldSetInterval = globalThis.setInterval;
        const oldClearTimeout = globalThis.clearTimeout;
        const oldClearInterval = globalThis.clearInterval;
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.setInterval = fakeTimers.setInterval as typeof setInterval;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        globalThis.clearInterval = fakeTimers.clear as typeof clearInterval;
        try {
            schedulePeriodicTmuxRunDirCleanup({
                firstRunDelayMs: 30_000,
                isTestRunner: false,
                reapOrphans: async () => ({
                    examined: 0,
                    orphaned: 0,
                    killed: 0,
                    keptLive: 0,
                    keptFinished: 0,
                    keptGrowing: 0,
                    keptQuiet: 0,
                    keptUnverified: 0,
                    skippedBootMismatch: 0,
                    killEscalated: 0,
                    wouldKill: [],
                    wouldKillOmitted: 0,
                    intervalNotElapsed: 0,
                    chainAbandoned: 0,
                    stuckChainCount: 0,
                    stuckChains: [],
                }),
                cleanup: async () => {
                    complete = true;
                    return {
                        examined: 0,
                        removed: 0,
                        keptAlive: 0,
                        keptUnknown: 0,
                    };
                },
            });
            fakeTimers.advance(30_000);
            await waitFor(() => complete);
            assert.equal(writes, 0);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
            Object.assign(console, originals);
        }
    });

    void it("keeps the real extension startup path nonblocking for maintenance", async () => {
        const fakeTimers = new FakeTimers();
        const oldSetTimeout = globalThis.setTimeout;
        const oldSetInterval = globalThis.setInterval;
        const oldClearTimeout = globalThis.clearTimeout;
        const oldClearInterval = globalThis.clearInterval;
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.setInterval = fakeTimers.setInterval as typeof setInterval;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        globalThis.clearInterval = fakeTimers.clear as typeof clearInterval;
        const events = new Map<
            string,
            Array<(...args: unknown[]) => unknown>
        >();
        const pi = new Proxy(
            {
                on: (event: string, handler: (...args: unknown[]) => unknown) =>
                    events.set(event, [...(events.get(event) ?? []), handler]),
                appendEntry: () => {},
                getAllTools: () => [],
                getActiveTools: () => [],
                getFlag: () => undefined,
                sendMessage: () => {},
                sendUserMessage: () => {},
                cancelQueuedMessage: () => false,
                registerMessageRenderer: () => {},
                registerTool: () => {},
                getSessionName: () => "test",
            },
            {
                get: (target, key: string) =>
                    key in target
                        ? target[key as keyof typeof target]
                        : () => {},
            }
        );
        const ctx = {
            cwd: process.cwd(),
            hasUI: false,
            ui: {
                setStatus() {},
                notify() {},
                setWidget() {},
                setTitle() {},
                theme: { fg: (_: string, text: string) => text },
            },
            sessionManager: {
                getEntries: () => [],
                getBranch: () => [],
                getSessionFile: () => "test.jsonl",
                getSessionId: () => "test",
            },
        };
        try {
            registerTau(pi as never);
            const start = events.get("session_start")?.at(-1);
            assert.ok(start);
            await start({}, ctx);
            assert.ok(fakeTimers.records.length > 0);
            assert.ok(
                fakeTimers.records.every((timer) => timer.unrefCalled),
                "real extension startup schedules all maintenance timers unref'd"
            );
            assert.equal(
                fakeTimers.records.some(
                    (timer) => timer.due <= fakeTimers.now && !timer.cleared
                ),
                false
            );
            for (const shutdown of events.get("session_shutdown") ?? [])
                await shutdown({}, ctx);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
        }
    });

    void it("uses elapsed-time slices instead of fixed item counts", async () => {
        let now = 0;
        let yields = 0;
        let visits = 0;
        await forEachWithinTimeBudget(
            Array.from({ length: 10 }),
            () => {
                visits++;
                now += 3;
            },
            {
                budgetMs: 8,
                now: () => now,
                yield: async () => {
                    yields++;
                },
            }
        );
        assert.equal(visits, 10);
        assert.equal(yields, 3);
    });
});
