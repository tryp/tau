import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ORPHAN_REAPER_DISABLE_ENV,
    ORPHAN_REAPER_METADATA_SUFFIX,
    reapOrphanedTmuxProcesses,
    type ProcessIdentity,
    type ReaperProcReader,
    type TmuxJobOwnership,
} from "../features/tmux-orphan-reaper.ts";

const BOOT = "boot-a";
const ROOT = "/fake/tmp";

class FakeProc implements ReaperProcReader {
    identities = new Map<number, ProcessIdentity>();
    files = new Map<string, string>();
    directories = new Set<string>([ROOT]);
    bytes = new Map<string, number>();
    signals: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
    boot = BOOT;
    pids(): number[] {
        return [...this.identities.keys()];
    }
    identity(pid: number): ProcessIdentity | null {
        return this.identities.get(pid) ?? null;
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
    const fullOptions = { rootDir: ROOT, reader, ...options };
    await reapOrphanedTmuxProcesses(fullOptions);
    return reapOrphanedTmuxProcesses(fullOptions);
}

void describe("tmux orphan process reaper", () => {
    void it("reaps a dead-owner frozen chain with TERM then KILL and pinned counters", async () => {
        const { reader } = fixture();
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, [
            [20, "SIGTERM"],
            [21, "SIGTERM"],
            [20, "SIGKILL"],
            [21, "SIGKILL"],
        ]);
        assert.deepEqual(stats, {
            examined: 1,
            orphaned: 1,
            killed: 2,
            keptLive: 0,
            keptUnverified: 0,
            skippedBootMismatch: 0,
            killEscalated: 1,
            wouldKill: [],
            wouldKillOmitted: 0,
        });
    });

    void it("does not exceed the per-sweep process cap", async () => {
        const { reader } = fixture();
        await reapOrphanedTmuxProcesses({ rootDir: ROOT, reader });
        const stats = await reapOrphanedTmuxProcesses({ rootDir: ROOT, reader, maxProcesses: 1 });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.orphaned, 1);
        assert.equal(stats.keptUnverified, 1);
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
        const stats = await reapOrphanedTmuxProcesses({ rootDir: ROOT, reader });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.orphaned, 0);
        assert.equal(stats.keptLive, 1);
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
        const stats = await reapOrphanedTmuxProcesses({ rootDir: ROOT, reader });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.examined, 1);
        assert.equal(stats.keptUnverified, 1);
    });

    void it("never touches a run with an exit sentinel", async () => {
        const { reader } = fixture({ exit: true });
        const stats = await twoObservations(reader);
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.keptLive, 1);
    });

    void it("dry-run reports orphan but signals nothing", async () => {
        const { reader } = fixture();
        const stats = await twoObservations(reader, { dryRun: true });
        assert.deepEqual(reader.signals, []);
        assert.equal(stats.orphaned, 1);
        assert.deepEqual(stats.wouldKill, ["pi-tmux-1/job.owner.json:wrapper=20"]);
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
