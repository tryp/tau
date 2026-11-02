import {
    readFileSync,
    readdirSync,
    statSync,
    readlinkSync,
    writeFileSync,
    renameSync,
} from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * This detector only kills when a chain is stable and pipe-blocked with no
 * peer; peer-alive wedges are reported, not reaped. Numeric signalling follows
 * identity checks, but the TOCTOU window is bounded rather than eliminated:
 * Node does not expose pidfd-bound signalling.
 */
export const ORPHAN_REAPER_METADATA_SUFFIX = ".owner.json";
export const ORPHAN_REAPER_STATE_SUFFIX = ".reaper.json";
export const ORPHAN_REAPER_DISABLE_ENV = "PI_TAU_DISABLE_ORPHAN_REAPER";
export const ORPHAN_REAPER_DELAY_ENV = "PI_TAU_ORPHAN_REAPER_DELAY_MS";
export const ORPHAN_REAPER_DEFAULT_DELAY_MS = 5_000;
export const ORPHAN_REAPER_ENABLE_ENV = "PI_TAU_ENABLE_ORPHAN_REAPER";
export const ORPHAN_REAPER_DRY_RUN_ENV = "PI_TAU_ORPHAN_REAPER_DRY_RUN";
export const ORPHAN_REAPER_MIN_INTERVAL_ENV =
    "PI_TAU_ORPHAN_REAPER_MIN_INTERVAL_MS";
export const ORPHAN_REAPER_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const ORPHAN_REAPER_MAX_PROCESSES_PER_SWEEP = 64;
export const ORPHAN_REAPER_TERM_GRACE_MS = 2_000;

export interface ProcessIdentity {
    pid: number;
    bootId: string;
    startTicks: string;
    ppid: number;
}

export interface TmuxJobOwnership {
    schemaVersion: 1;
    owner: ProcessIdentity;
    wrapper: ProcessIdentity;
    outputFile: string;
    exitCodeFile: string;
}

export interface ReaperProcReader {
    bootId(): string | null;
    pids(): number[];
    pidsAsync?(): Promise<number[]>;
    identity(pid: number): ProcessIdentity | null;
    cpuTime(pid: number): number | null;
    pipeState(
        pid: number
    ):
        | "not-blocked"
        | "blocked-no-peer"
        | "blocked-peer"
        | null
        | Promise<"not-blocked" | "blocked-no-peer" | "blocked-peer" | null>;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;
    sleep(ms: number): Promise<void>;
    outputBytes(path: string): number | null;
    readText(path: string): string | null;
    writeText(path: string, value: string): void;
    rename(from: string, to: string): void;
    list(path: string): string[];
    listAsync?(path: string): Promise<string[]>;
    exists(path: string): boolean;
}

export interface OrphanReaperOptions {
    rootDir: string;
    reader?: ReaperProcReader;
    dryRun?: boolean;
    disabled?: boolean;
    maxProcesses?: number;
    graceMs?: number;
    minimumObservationIntervalMs?: number;
}

export interface OrphanReaperStats {
    examined: number;
    orphaned: number;
    killed: number;
    keptLive: number;
    keptFinished: number;
    keptGrowing: number;
    keptQuiet: number;
    keptUnverified: number;
    skippedBootMismatch: number;
    killEscalated: number;
    wouldKill: string[];
    wouldKillOmitted: number;
    intervalNotElapsed: number;
    chainAbandoned: number;
    stuckChainCount: number;
    stuckChains: string[];
}

function processStartTicks(
    stat: string
): { ppid: number; startTicks: string } | null {
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
    const ppid = Number(fields[1]);
    const startTicks = fields[19]; // /proc stat field 22, after pid/comm.
    if (!Number.isSafeInteger(ppid) || !/^\d+$/.test(startTicks ?? ""))
        return null;
    return { ppid, startTicks };
}

export function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
    try {
        const bootId = readFileSync(
            "/proc/sys/kernel/random/boot_id",
            "utf8"
        ).trim();
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const parsed = processStartTicks(stat);
        if (!bootId || !parsed) return null;
        return { pid, bootId, ...parsed };
    } catch {
        return null;
    }
}

export function captureOwnerIdentity(): ProcessIdentity | null {
    return readLinuxProcessIdentity(process.pid);
}

const defaultReader: ReaperProcReader = {
    bootId: () => {
        try {
            return (
                readFileSync(
                    "/proc/sys/kernel/random/boot_id",
                    "utf8"
                ).trim() || null
            );
        } catch {
            return null;
        }
    },
    pids: () => {
        try {
            return readdirSync("/proc")
                .filter((x) => /^\d+$/.test(x))
                .map(Number);
        } catch {
            return [];
        }
    },
    pidsAsync: async () => {
        try {
            return (await readdir("/proc"))
                .filter((x) => /^\d+$/.test(x))
                .map(Number);
        } catch {
            return [];
        }
    },
    identity: readLinuxProcessIdentity,
    cpuTime: (pid) => {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const fields = stat
                .slice(stat.lastIndexOf(")") + 1)
                .trim()
                .split(/\s+/);
            const ticks = Number(fields[11]) + Number(fields[12]);
            return Number.isFinite(ticks) ? ticks : null;
        } catch {
            return null;
        }
    },
    pipeState: async (pid) => {
        try {
            const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim();
            if (!/pipe_(read|write|wait)|wait_for_partner/.test(wchan))
                return "not-blocked";
            const syscall = readFileSync(`/proc/${pid}/syscall`, "utf8")
                .trim()
                .split(/\s+/);
            const fd = Number(syscall[1]);
            if (!Number.isSafeInteger(fd)) return null;
            const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
            const match = /^pipe:\[(\d+)\]$/.exec(link);
            if (!match) return null;
            const inode = match[1];
            for (const otherPid of (await readdir("/proc")).filter(
                (x) => /^\d+$/.test(x) && Number(x) !== pid
            )) {
                let fds: string[];
                try {
                    fds = await readdir(`/proc/${otherPid}/fd`);
                } catch {
                    return null;
                }
                for (const otherFd of fds) {
                    try {
                        if (
                            (await readlink(
                                `/proc/${otherPid}/fd/${otherFd}`
                            )) === `pipe:[${inode}]`
                        )
                            return "blocked-peer";
                    } catch {
                        return null;
                    }
                    if (Number(otherFd) > 0 && Number(otherFd) % 128 === 0) {
                        await new Promise<void>((resolve) =>
                            setImmediate(resolve)
                        );
                    }
                }
            }
            return "blocked-no-peer";
        } catch {
            return null;
        }
    },
    signal: (pid, signal) => {
        try {
            process.kill(pid, signal);
            return true;
        } catch {
            return false;
        }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    outputBytes: (path) => {
        try {
            return statSync(path).size;
        } catch {
            return null;
        }
    },
    readText: (path) => {
        try {
            return readFileSync(path, "utf8");
        } catch {
            return null;
        }
    },
    writeText: (path, value) => writeFileSync(path, value, { mode: 0o600 }),
    rename: renameSync,
    list: (path) => {
        try {
            return readdirSync(path);
        } catch {
            return [];
        }
    },
    listAsync: async (path) => {
        try {
            return await readdir(path);
        } catch {
            return [];
        }
    },
    exists: (path) => {
        try {
            readFileSync(path);
            return true;
        } catch {
            return false;
        }
    },
};

function parseOwnership(text: string | null): TmuxJobOwnership | null {
    if (!text) return null;
    try {
        const value = JSON.parse(text) as TmuxJobOwnership;
        const valid = (p: ProcessIdentity) =>
            p &&
            Number.isSafeInteger(p.pid) &&
            p.pid > 0 &&
            !!p.bootId &&
            /^\d+$/.test(p.startTicks);
        if (
            value.schemaVersion !== 1 ||
            !valid(value.owner) ||
            !valid(value.wrapper) ||
            !value.outputFile ||
            !value.exitCodeFile
        )
            return null;
        return value;
    } catch {
        return null;
    }
}

function identityMatches(
    expected: ProcessIdentity,
    current: ProcessIdentity | null,
    bootId: string
): boolean {
    return (
        !!current &&
        expected.bootId === bootId &&
        current.bootId === bootId &&
        current.pid === expected.pid &&
        current.startTicks === expected.startTicks
    );
}

export function inspectRunDirWrapperLiveness(
    dir: string
): "alive" | "dead" | "unknown" {
    const boot = defaultReader.bootId();
    if (!boot) return "unknown";
    let foundMetadata = false;
    for (const name of defaultReader.list(dir)) {
        if (!name.endsWith(ORPHAN_REAPER_METADATA_SUFFIX)) continue;
        foundMetadata = true;
        const ownership = parseOwnership(
            defaultReader.readText(join(dir, name))
        );
        if (!ownership) return "unknown";
        if (ownership.wrapper.bootId !== boot) continue;
        const current = defaultReader.identity(ownership.wrapper.pid);
        if (identityMatches(ownership.wrapper, current, boot)) return "alive";
        if (!current && defaultReader.pids().includes(ownership.wrapper.pid))
            return "unknown";
    }
    return foundMetadata ? "dead" : "unknown";
}

async function readPids(reader: ReaperProcReader): Promise<number[]> {
    return reader.pidsAsync ? reader.pidsAsync() : reader.pids();
}

async function descendants(
    root: ProcessIdentity,
    reader: ReaperProcReader,
    pids: number[]
): Promise<ProcessIdentity[] | null> {
    const identities: Array<ProcessIdentity | null> = [];
    for (let i = 0; i < pids.length; i++) {
        identities.push(reader.identity(pids[i]));
        if ((i + 1) % 128 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // An unreadable process could be a child in this chain. Fail closed rather
    // than signalling a partial tree while an unverified descendant survives.
    if (identities.some((identity) => identity === null)) return null;
    const verified = identities as ProcessIdentity[];
    const found = new Map<number, ProcessIdentity>([[root.pid, root]]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const p of verified) {
            if (!found.has(p.pid) && found.has(p.ppid)) {
                found.set(p.pid, p);
                changed = true;
            }
        }
    }
    return [...found.values()];
}

function loadState(
    reader: ReaperProcReader,
    path: string
): { bytes: number; cpuTime: number; observedAt: number } | null {
    const raw = reader.readText(path);
    if (!raw) return null;
    try {
        const state = JSON.parse(raw) as {
            bytes: number;
            cpuTime: number;
            observedAt: number;
        };
        return Number.isSafeInteger(state.bytes) &&
            Number.isFinite(state.cpuTime) &&
            Number.isFinite(state.observedAt)
            ? state
            : null;
    } catch {
        return null;
    }
}

function saveState(
    reader: ReaperProcReader,
    path: string,
    bytes: number,
    cpuTime: number,
    observedAt: number
): void {
    const temp = `${path}.tmp-${process.pid}`;
    reader.writeText(temp, JSON.stringify({ bytes, cpuTime, observedAt }));
    reader.rename(temp, path);
}

function signalVerifiedChain(
    chain: ProcessIdentity[],
    signal: "SIGTERM" | "SIGKILL",
    currentBoot: string,
    reader: ReaperProcReader
): { sent: number; verified: boolean } {
    // Verify the entire attributed tree before signalling any member. In
    // particular, a recycled wrapper PID invalidates every descendant link.
    for (const proc of chain) {
        if (
            proc.bootId !== currentBoot ||
            !identityMatches(proc, reader.identity(proc.pid), currentBoot)
        )
            return { sent: 0, verified: false };
    }
    let sent = 0;
    for (const proc of chain) {
        if (reader.signal(proc.pid, signal)) sent++;
    }
    return { sent, verified: true };
}

export async function reapOrphanedTmuxProcesses(
    options: OrphanReaperOptions
): Promise<OrphanReaperStats> {
    const reader = options.reader ?? defaultReader;
    const stats: OrphanReaperStats = {
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
    if (options.disabled || process.env[ORPHAN_REAPER_DISABLE_ENV] === "1")
        return stats;
    const currentBoot = reader.bootId();
    if (!currentBoot) {
        stats.keptUnverified++;
        return stats;
    }
    let killedThisSweep = 0;
    const pids = await readPids(reader);
    const runNames = reader.listAsync
        ? await reader.listAsync(options.rootDir)
        : reader.list(options.rootDir);
    for (let runIndex = 0; runIndex < runNames.length; runIndex++) {
        const runName = runNames[runIndex];
        if (runIndex > 0 && runIndex % 16 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!runName.startsWith("pi-tmux-")) continue;
        const runDir = join(options.rootDir, runName);
        const dirEntries = reader.listAsync
            ? await reader.listAsync(runDir)
            : reader.list(runDir);
        const metadataNames = dirEntries.filter((name) =>
            name.endsWith(ORPHAN_REAPER_METADATA_SUFFIX)
        );
        if (metadataNames.length === 0) {
            stats.examined++;
            stats.keptUnverified++;
            continue;
        }
        for (const name of metadataNames) {
            stats.examined++;
            const metadataPath = join(runDir, name);
            const ownership = parseOwnership(reader.readText(metadataPath));
            if (!ownership) {
                stats.keptUnverified++;
                continue;
            }
            const owner = ownership.owner;
            if (owner.bootId !== currentBoot) {
                stats.skippedBootMismatch++;
                continue;
            }
            const ownerCurrent = reader.identity(owner.pid);
            if (identityMatches(owner, ownerCurrent, currentBoot)) {
                stats.keptLive++;
                continue;
            }
            if (!ownerCurrent && pids.includes(owner.pid)) {
                stats.keptUnverified++;
                continue;
            }
            const wrapper = ownership.wrapper;
            if (wrapper.bootId !== currentBoot) {
                stats.skippedBootMismatch++;
                continue;
            }
            const currentWrapper = reader.identity(wrapper.pid);
            if (
                !currentWrapper ||
                !identityMatches(wrapper, currentWrapper, currentBoot)
            ) {
                stats.keptUnverified++;
                continue;
            }
            if (reader.exists(ownership.exitCodeFile)) {
                stats.keptFinished++;
                continue;
            }
            const bytes = reader.outputBytes(ownership.outputFile);
            if (bytes === null) {
                stats.keptUnverified++;
                continue;
            }
            const statePath = metadataPath.replace(
                ORPHAN_REAPER_METADATA_SUFFIX,
                ORPHAN_REAPER_STATE_SUFFIX
            );
            const chain = await descendants(currentWrapper, reader, pids);
            if (!chain) {
                stats.keptUnverified++;
                continue;
            }
            const cpuValues = chain.map((proc) => reader.cpuTime(proc.pid));
            if (cpuValues.some((value) => value === null)) {
                stats.keptUnverified++;
                continue;
            }
            const cpuTime = (cpuValues as number[]).reduce(
                (sum, value) => sum + value,
                0
            );
            const previous = loadState(reader, statePath);
            const now = Date.now();
            if (!previous || previous.bytes !== bytes) {
                saveState(reader, statePath, bytes, cpuTime, now);
                stats.keptGrowing++;
                continue;
            }
            if (previous.cpuTime !== cpuTime) {
                saveState(reader, statePath, bytes, cpuTime, now);
                stats.keptLive++;
                continue;
            }
            const stableForMs = Math.max(0, now - previous.observedAt);
            saveState(reader, statePath, bytes, cpuTime, previous.observedAt);
            const configuredInterval = Number(
                process.env[ORPHAN_REAPER_MIN_INTERVAL_ENV]
            );
            const minimumInterval =
                options.minimumObservationIntervalMs ??
                (Number.isFinite(configuredInterval) && configuredInterval >= 0
                    ? configuredInterval
                    : ORPHAN_REAPER_MIN_INTERVAL_MS);
            if (stableForMs < minimumInterval) {
                stats.intervalNotElapsed++;
                continue;
            }
            const pipeResults = await Promise.all(
                chain.map((proc) => Promise.resolve(reader.pipeState(proc.pid)))
            );
            if (pipeResults.includes("blocked-peer")) {
                stats.stuckChainCount++;
                stats.stuckChains.push(
                    `${runDir}:wrapper=${wrapper.pid}:chain=${chain.length}:stable-ms=${stableForMs}`
                );
                continue;
            }
            if (!pipeResults.includes("blocked-no-peer")) {
                if (pipeResults.includes(null)) stats.keptUnverified++;
                else stats.keptQuiet++;
                continue;
            }
            stats.orphaned++;
            if (
                options.dryRun ||
                process.env[ORPHAN_REAPER_DRY_RUN_ENV] === "1" ||
                process.env[ORPHAN_REAPER_ENABLE_ENV] !== "1"
            ) {
                const target = `${runName}/${name}:wrapper=${wrapper.pid}`;
                if (stats.wouldKill.length < 8) stats.wouldKill.push(target);
                else stats.wouldKillOmitted++;
                continue;
            }
            // Recheck the owner immediately before signalling; never act on a
            // run that has become live again through a PID reuse race.
            const latestOwner = reader.identity(owner.pid);
            if (identityMatches(owner, latestOwner, currentBoot)) {
                stats.keptLive++;
                continue;
            }
            if (!latestOwner && pids.includes(owner.pid)) {
                stats.keptUnverified++;
                continue;
            }
            // The command may have completed while /proc was being enumerated.
            if (reader.exists(ownership.exitCodeFile)) {
                stats.keptFinished++;
                continue;
            }
            const maxProcesses =
                options.maxProcesses ?? ORPHAN_REAPER_MAX_PROCESSES_PER_SWEEP;
            if (chain.length > maxProcesses - killedThisSweep) {
                stats.keptUnverified++;
                continue;
            }
            const termResult = signalVerifiedChain(
                chain,
                "SIGTERM",
                currentBoot,
                reader
            );
            if (!termResult.verified) {
                stats.chainAbandoned++;
                stats.keptUnverified++;
                continue;
            }
            const sent = termResult.sent;
            killedThisSweep += sent;
            if (sent === 0) {
                stats.keptUnverified++;
                continue;
            }
            await reader.sleep(options.graceMs ?? ORPHAN_REAPER_TERM_GRACE_MS);
            const killResult = signalVerifiedChain(
                chain,
                "SIGKILL",
                currentBoot,
                reader
            );
            if (!killResult.verified) {
                stats.chainAbandoned++;
                stats.keptUnverified++;
                continue;
            }
            if (killResult.sent > 0) {
                stats.killed += killResult.sent;
                stats.killEscalated++;
            } else stats.keptUnverified++;
        }
    }
    return stats;
}

export function startOrphanReaper(
    options: OrphanReaperOptions,
    onComplete: (stats: OrphanReaperStats) => void,
    onError: (error: unknown) => void
): void {
    void reapOrphanedTmuxProcesses(options).then(onComplete).catch(onError);
}

export function formatOrphanReaperLog(
    stats: OrphanReaperStats,
    dryRun = false
): string {
    const targets = stats.wouldKill.length
        ? `${stats.wouldKill.join(",")}${stats.wouldKillOmitted ? `,+${stats.wouldKillOmitted}` : ""}`
        : "-";
    return `[tau] tmux-orphan-reaper dry-run=${dryRun || process.env[ORPHAN_REAPER_DRY_RUN_ENV] === "1" || process.env[ORPHAN_REAPER_ENABLE_ENV] !== "1"} examined=${stats.examined} orphaned=${stats.orphaned} killed=${stats.killed} kept-live=${stats.keptLive} kept-finished=${stats.keptFinished} kept-growing=${stats.keptGrowing} kept-quiet=${stats.keptQuiet} kept-unverified=${stats.keptUnverified} interval-not-elapsed=${stats.intervalNotElapsed} chain-abandoned=${stats.chainAbandoned} stuck-chains=${stats.stuckChainCount} stuck-findings=${stats.stuckChains.join(";") || "-"} skipped-boot-mismatch=${stats.skippedBootMismatch} kill-escalated=${stats.killEscalated} would-kill=${targets}`;
}
