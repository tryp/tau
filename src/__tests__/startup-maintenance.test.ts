import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schedulePeriodicTmuxRunDirCleanup } from "../features/bash-tmux.ts";
import { resolveMaintenanceDelayMs } from "../index.ts";
import { forEachWithinTimeBudget } from "../features/tmux-orphan-reaper.ts";

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
