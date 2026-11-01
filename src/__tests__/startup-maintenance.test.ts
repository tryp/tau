import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { scheduleBackgroundJobRestore } from "../features/startup-maintenance.ts";
import { schedulePeriodicTmuxRunDirCleanup } from "../features/bash-tmux.ts";
import { scheduleSidecarPurge } from "../features/sidecar.ts";

void describe("deferred startup maintenance", () => {
    afterEach(() => mock.timers.reset());

    void it("defers and unrefs sidecar purge and background-job restore", () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        let purges = 0;
        let restores = 0;
        const purgeTimer = scheduleSidecarPurge(() => purges++);
        const restoreTimer = scheduleBackgroundJobRestore(() => restores++);

        assert.equal(purges, 0);
        assert.equal(restores, 0);
        assert.equal(typeof purgeTimer.unref, "function");
        assert.equal(typeof restoreTimer.unref, "function");
        mock.timers.tick(100);
        assert.equal(restores, 1);
        assert.equal(purges, 0);
        mock.timers.tick(4_900);
        assert.equal(purges, 1);
    });

    void it("runs the first reaper and run-dir sweep only after its deferred timer", async () => {
        mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
        const calls: string[] = [];
        const timer = schedulePeriodicTmuxRunDirCleanup({
            firstRunDelayMs: 5_000,
            intervalMs: 60 * 60 * 1000,
            isTestRunner: false,
            reapOrphans: async () => {
                calls.push("reaper");
                return {
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
                };
            },
            cleanup: () => {
                calls.push("sweep");
                return {
                    examined: 0,
                    removed: 0,
                    keptAlive: 0,
                    keptUnknown: 0,
                };
            },
            log: () => {},
        });
        assert.ok(timer);
        assert.equal(typeof timer.unref, "function");
        assert.deepEqual(calls, []);
        mock.timers.tick(4_999);
        assert.deepEqual(calls, []);
        mock.timers.tick(1);
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
        assert.deepEqual(calls, ["reaper", "sweep"]);
    });
});
