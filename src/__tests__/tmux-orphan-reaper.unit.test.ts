import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ORPHAN_REAPER_DISABLE_ENV,
    ORPHAN_REAPER_ENABLE_ENV,
    ORPHAN_REAPER_METADATA_SUFFIX,
    ORPHAN_REAPER_MIN_INTERVAL_MS,
    ORPHAN_REAPER_STATE_SUFFIX,
    formatOrphanReaperLog,
    reapOrphanedTmuxProcesses,
    startOrphanReaper,
    type ProcessIdentity,
    type ReaperProcReader,
    type TmuxJobOwnership,
} from "../features/tmux-orphan-reaper.ts";

const BOOT = "boot-a";
const ROOT = "/fake/tmp";

class FakeProc implements ReaperProcReader {
    identities = new Map<number, ProcessIdentity>();
    identityCalls = new Map<number, number>();
    identityHook?: (
        pid: number,
        call: number,
        current: ProcessIdentity | null
    ) => ProcessIdentity | null | undefined;
    listedPids: number[] = [];
    files = new Map<string, string>();
    directories = new Set<string>([ROOT]);
    bytes = new Map<string, number>();
    signals: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
    cpus = new Map<number, number>([
        [20, 1],
        [21, 2],
    ]);
    pipeProof = new Map<
        number,
        "not-blocked" | "blocked-no-peer" | "blocked-peer" | null
    >([
        [20, "blocked-no-peer"],
        [21, "not-blocked"],
    ]);
    boot: string | null = BOOT;
    pidsAsync = async (): Promise<number[]> => this.pids();
    pids(): number[] {
        return this.listedPids.length
            ? [...this.listedPids]
            : [...this.identities.keys()];
    }
    identity(pid: number): ProcessIdentity | null {
        const call = (this.identityCalls.get(pid) ?? 0) + 1;
        this.identityCalls.set(pid, call);
        const current = this.identities.get(pid) ?? null;
        const hooked = this.identityHook?.(pid, call, current);
        return hooked === undefined ? current : hooked;
    }
    cpuTime(pid: number): number | null {
        return this.cpus.get(pid) ?? null;
    }
    pipeState(
        pid: number
    ): "not-blocked" | "blocked-no-peer" | "blocked-peer" | null {
        return this.pipeProof.has(pid)
            ? this.pipeProof.get(pid)!
            : "not-blocked";
    }
    bootId(): string | null {
        return this.boot;
    }
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
        this.signals.push([pid, signal]);
        return true;
    }
    sleep(): Promise<void> {
        return Promise.resolve();
    }
    outputBytes(path: string): number | null {
        return this.bytes.get(path) ?? null;
    }
    readText(path: string): string | null {
        return this.files.get(path) ?? null;
    }
    writeText(path: string, value: string): void {
        this.files.set(path, value);
    }
    rename(from: string, to: string): void {
        const value = this.files.get(from);
        if (value !== undefined) this.files.set(to, value);
        this.files.delete(from);
    }
    list(path: string): string[] {
        if (path === ROOT)
            return [...this.directories]
                .filter((x) => x !== ROOT)
                .map((x) => x.split("/").pop()!);
        return [...this.files.keys()]
            .filter((x) => x.startsWith(`${path}/`))
            .map((x) => x.slice(path.length + 1));
    }
    exists(path: string): boolean {
        return this.files.has(path);
    }
}

function identity(
    pid: number,
    ppid: number,
    startTicks: string,
    bootId = BOOT
): ProcessIdentity {
    return { pid, ppid, startTicks, bootId };
}

function seedStableObservation(
    reader: FakeProc,
    outputFile: string,
    observedAt: number
) {
    const metadataPath = `${ROOT}/pi-tmux-1/job${ORPHAN_REAPER_METADATA_SUFFIX}`;
    reader.files.set(
        metadataPath.replace(
            ORPHAN_REAPER_METADATA_SUFFIX,
            ORPHAN_REAPER_STATE_SUFFIX
        ),
        JSON.stringify({ bytes: 123, cpuTime: 3, observedAt })
    );
    reader.bytes.set(outputFile, 123);
}

function fixture(
    options: {
        ownerAlive?: boolean;
        exit?: boolean;
        wrapperTicks?: string;
        actualWrapperTicks?: string;
        ownerBoot?: string;
    } = {}
) {
    const reader = new FakeProc();
    const owner = identity(10, 1, "100", options.ownerBoot ?? BOOT);
    const wrapper = identity(20, 1, options.wrapperTicks ?? "200");
    const child = identity(21, 20, "210");
    if (options.ownerAlive) reader.identities.set(10, owner);
    reader.identities.set(
        20,
        identity(20, 1, options.actualWrapperTicks ?? wrapper.startTicks)
    );
    reader.identities.set(21, child);
    const runDir = `${ROOT}/pi-tmux-1`;
    reader.directories.add(runDir);
    const outputFile = `${runDir}/job.out`;
    const exitCodeFile = `${runDir}/job.exit`;
    const ownership: TmuxJobOwnership = {
        schemaVersion: 1,
        owner,
        wrapper,
        outputFile,
        exitCodeFile,
    };
    reader.files.set(
        `${runDir}/job${ORPHAN_REAPER_METADATA_SUFFIX}`,
        JSON.stringify(ownership)
    );
    if (options.exit) reader.files.set(exitCodeFile, "0");
    reader.bytes.set(outputFile, 123);
    return { reader, outputFile };
}

async function twoObservations(
    reader: FakeProc,
    options: Partial<Parameters<typeof reapOrphanedTmuxProcesses>[0]> = {}
) {
    const fullOptions = {
        rootDir: ROOT,
        reader,
        minimumObservationIntervalMs: 0,
        ...options,
    };
    await reapOrphanedTmuxProcesses(fullOptions);
    return reapOrphanedTmuxProcesses(fullOptions);
}

void describe("tmux orphan process reaper", () => {
    void it("uses asynchronous process enumeration when the reader provides it", async () => {
        const { reader } = fixture();
        let asyncEnumerations = 0;
        reader.pidsAsync = async () => {
            asyncEnumerations++;
            return reader.pids();
        };
        await reapOrphanedTmuxProcesses({
            rootDir: ROOT,
            reader,
            minimumObservationIntervalMs: 0,
        });
        assert.equal(asyncEnumerations, 1);
    });

    void it("reaps a dead-owner frozen chain with TERM then KILL and pinned counters", async () => {
        const { reader, outputFile } = fixture();
        const previousEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        process.env[ORPHAN_REAPER_ENABLE_ENV] = "1";
        seedStableObservation(
            reader,
            outputFile,
            Date.now() - ORPHAN_REAPER_MIN_INTERVAL_MS
        );
        const stats = await reapOrphanedTmuxProcesses({
            rootDir: ROOT,
            reader,
        });
        assert.deepEqual(reader.signals, [
            [20, "SIGTERM"],
            [21, "SIGTERM"],
            [20, "SIGKILL"],
            [21, "SIGKILL"],
        ]);
        if (previousEnable === undefined)
            delete process.env[ORPHAN_REAPER_ENABLE_ENV];
        else process.env[ORPHAN_REAPER_ENABLE_ENV] = previousEnable;
        assert.deepEqual(stats, {
            examined: 1,
            orphaned: 1,
            killed: 2,
            keptLive: 0,
            keptFinished: 0,
            keptGrowing: 0,
            keptQuiet: 0,
            keptUnverified: 0,
            skippedBootMismatch: 0,
            killEscalated: 1,
            wouldKill: [],
            wouldKillOmitted: 0,
            intervalNotElapsed: 0,
            chainAbandoned: 0,
            stuckChainCount: 0,
            stuckChains: [],
        });
    });

    void it("defaults to classification-only even for a fully eligible candidate", async () => {
        const { reader, outputFile } = fixture();
        const previousEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        delete process.env[ORPHAN_REAPER_ENABLE_ENV];
        seedStableObservation(
            reader,
            outputFile,
            Date.now() - ORPHAN_REAPER_MIN_INTERVAL_MS
        );
        try {
            const stats = await reapOrphanedTmuxProcesses({
                rootDir: ROOT,
                reader,
                minimumObservationIntervalMs: 1,
            });
            assert.deepEqual(reader.signals, []);
            assert.equal(stats.orphaned, 1);
            assert.deepEqual(stats.wouldKill, [
                "pi-tmux-1/job.owner.json:wrapper=20",
            ]);
        } finally {
            if (previousEnable === undefined)
                delete process.env[ORPHAN_REAPER_ENABLE_ENV];
            else process.env[ORPHAN_REAPER_ENABLE_ENV] = previousEnable;
        }
    });

    void it("does not kill until the persisted stability interval elapses", async () => {
        const { reader, outputFile } = fixture();
        seedStableObservation(reader, outputFile, Date.now() - 1_000);
        const stats = await reapOrphanedTmuxProcesses({
            rootDir: ROOT,
            reader,
            minimumObservationIntervalMs: ORPHAN_REAPER_MIN_INTERVAL_MS,
        });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.intervalNotElapsed, 1);
    });

    void it("explicit disable takes precedence over explicit enable", async () => {
        const { reader } = fixture();
        const oldEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        const oldDisable = process.env[ORPHAN_REAPER_DISABLE_ENV];
        process.env[ORPHAN_REAPER_ENABLE_ENV] = "1";
        process.env[ORPHAN_REAPER_DISABLE_ENV] = "1";
        try {
            const stats = await twoObservations(reader);
            assert.deepEqual(reader.signals, []);
            assert.equal(stats.examined, 0);
        } finally {
            if (oldEnable === undefined)
                delete process.env[ORPHAN_REAPER_ENABLE_ENV];
            else process.env[ORPHAN_REAPER_ENABLE_ENV] = oldEnable;
            if (oldDisable === undefined)
                delete process.env[ORPHAN_REAPER_DISABLE_ENV];
            else process.env[ORPHAN_REAPER_DISABLE_ENV] = oldDisable;
        }
    });

    void it("startup reporting catches a reaper failure without throwing", async () => {
        const reader = new FakeProc();
        reader.boot = null;
        let errorReported = false;
        startOrphanReaper(
            { rootDir: ROOT, reader },
            () => assert.fail("unexpected success"),
            () => {
                errorReported = true;
            }
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(errorReported, true);
    });

    void it("abandons the whole chain when wrapper identity changes before TERM", async () => {
        const { reader, outputFile } = fixture();
        seedStableObservation(
            reader,
            outputFile,
            Date.now() - ORPHAN_REAPER_MIN_INTERVAL_MS
        );
        const previousEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        process.env[ORPHAN_REAPER_ENABLE_ENV] = "1";
        reader.identityHook = (pid, call, current) =>
            pid === 20 && call === 3 && current
                ? { ...current, startTicks: "recycled" }
                : current;
        try {
            const stats = await reapOrphanedTmuxProcesses({
                rootDir: ROOT,
                reader,
            });
            assert.deepEqual(reader.signals, []);
            assert.equal(stats.chainAbandoned, 1);
        } finally {
            if (previousEnable === undefined)
                delete process.env[ORPHAN_REAPER_ENABLE_ENV];
            else process.env[ORPHAN_REAPER_ENABLE_ENV] = previousEnable;
        }
    });

    void it("abandons the whole chain when any non-root member is unverified", async () => {
        const { reader, outputFile } = fixture();
        seedStableObservation(
            reader,
            outputFile,
            Date.now() - ORPHAN_REAPER_MIN_INTERVAL_MS
        );
        const previousEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        process.env[ORPHAN_REAPER_ENABLE_ENV] = "1";
        reader.identityHook = (pid, call, current) =>
            pid === 21 && call === 2 ? null : current;
        try {
            const stats = await reapOrphanedTmuxProcesses({
                rootDir: ROOT,
                reader,
            });
            assert.deepEqual(reader.signals, []);
            assert.equal(stats.chainAbandoned, 1);
        } finally {
            if (previousEnable === undefined)
                delete process.env[ORPHAN_REAPER_ENABLE_ENV];
            else process.env[ORPHAN_REAPER_ENABLE_ENV] = previousEnable;
        }
    });

    void it("rechecks boot identity for both TERM and KILL signal passes", async () => {
        const previousEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        process.env[ORPHAN_REAPER_ENABLE_ENV] = "1";
        try {
            for (const mismatchCall of [3, 4]) {
                const { reader, outputFile } = fixture();
                seedStableObservation(
                    reader,
                    outputFile,
                    Date.now() - ORPHAN_REAPER_MIN_INTERVAL_MS
                );
                reader.identityHook = (pid, call, current) =>
                    pid === 20 && call === mismatchCall && current
                        ? { ...current, bootId: "other-boot" }
                        : current;
                const stats = await reapOrphanedTmuxProcesses({
                    rootDir: ROOT,
                    reader,
                });
                assert.deepEqual(
                    reader.signals,
                    mismatchCall === 3
                        ? []
                        : [
                              [20, "SIGTERM"],
                              [21, "SIGTERM"],
                          ]
                );
                assert.equal(stats.chainAbandoned, 1);
            }
        } finally {
            if (previousEnable === undefined)
                delete process.env[ORPHAN_REAPER_ENABLE_ENV];
            else process.env[ORPHAN_REAPER_ENABLE_ENV] = previousEnable;
        }
    });

    void it("does not exceed the per-sweep process cap", async () => {
        const { reader } = fixture();
        const previousEnable = process.env[ORPHAN_REAPER_ENABLE_ENV];
        process.env[ORPHAN_REAPER_ENABLE_ENV] = "1";
        try {
            await reapOrphanedTmuxProcesses({
                rootDir: ROOT,
                reader,
                minimumObservationIntervalMs: 0,
            });
            const stats = await reapOrphanedTmuxProcesses({
                rootDir: ROOT,
                reader,
                minimumObservationIntervalMs: 0,
                maxProcesses: 1,
            });
            assert.deepEqual(reader.signals, []);
            assert.equal(stats.orphaned, 1);
            assert.equal(stats.keptUnverified, 1);
        } finally {
            if (previousEnable === undefined)
                delete process.env[ORPHAN_REAPER_ENABLE_ENV];
            else process.env[ORPHAN_REAPER_ENABLE_ENV] = previousEnable;
        }
    });

    void it("never touches a run whose owner identity is live", async () => {
        const { reader } = fixture({ ownerAlive: true });
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.keptLive, 1);
        assert.equal(stats.killed, 0);
    });

    void it("treats output growth since the prior observation as live", async () => {
        const { reader, outputFile } = fixture();
        await reapOrphanedTmuxProcesses({ rootDir: ROOT, reader });
        reader.bytes.set(outputFile, 124);
        const stats = await reapOrphanedTmuxProcesses({
            rootDir: ROOT,
            reader,
        });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.orphaned, 0);
        assert.equal(stats.keptGrowing, 1);
    });

    void it("keeps a quiet CPU-idle non-pipe-blocked chain when its owner exits", async () => {
        const { reader } = fixture();
        reader.pipeProof.set(20, "not-blocked");
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.keptQuiet, 1);
    });

    void it("reports a stable chain with a live pipe peer without signalling", async () => {
        const { reader } = fixture();
        reader.pipeProof.set(20, "not-blocked");
        reader.pipeProof.set(21, "blocked-peer");
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.stuckChainCount, 1);
        assert.match(
            stats.stuckChains[0],
            /pi-tmux-1:wrapper=20:chain=2:stable-ms=/
        );
        assert.match(
            formatOrphanReaperLog(stats),
            /stuck-chains=1 stuck-findings=.*pi-tmux-1:wrapper=20:chain=2:stable-ms=/
        );
    });

    void it("keeps the whole chain when any process identity is unreadable", async () => {
        const { reader } = fixture();
        reader.identities.delete(21);
        reader.listedPids = [10, 20, 21];
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.keptUnverified, 1);
    });

    void it("skips an owner boot-id mismatch", async () => {
        const { reader } = fixture({ ownerBoot: "old-boot" });
        const stats = await reapOrphanedTmuxProcesses({
            rootDir: ROOT,
            reader,
        });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.skippedBootMismatch, 1);
    });

    void it("does not signal a recycled wrapper pid with different start ticks", async () => {
        const { reader } = fixture({ actualWrapperTicks: "999" });
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.keptUnverified, 1);
    });

    void it("counts a legacy run without ownership metadata as unverified", async () => {
        const reader = new FakeProc();
        reader.directories.add(`${ROOT}/pi-tmux-legacy`);
        const stats = await reapOrphanedTmuxProcesses({
            rootDir: ROOT,
            reader,
        });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.examined, 1);
        assert.equal(stats.keptUnverified, 1);
    });

    void it("never touches a run with an exit sentinel", async () => {
        const { reader } = fixture({ exit: true });
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.keptFinished, 1);
    });

    void it("dry-run reports orphan but signals nothing", async () => {
        const { reader } = fixture();
        const stats = await twoObservations(reader, { dryRun: true });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.orphaned, 1);
        assert.deepEqual(stats.wouldKill, [
            "pi-tmux-1/job.owner.json:wrapper=20",
        ]);
        assert.equal(stats.killed, 0);
    });

    void it("kill-switch disables the reaper", async () => {
        const { reader } = fixture();
        const previous = process.env[ORPHAN_REAPER_DISABLE_ENV];
        process.env[ORPHAN_REAPER_DISABLE_ENV] = "1";
        try {
            const stats = await twoObservations(reader);
            assert.deepEqual(reader.signals, []);
            assert.equal(stats.examined, 0);
        } finally {
            if (previous === undefined)
                delete process.env[ORPHAN_REAPER_DISABLE_ENV];
            else process.env[ORPHAN_REAPER_DISABLE_ENV] = previous;
        }
    });
});
