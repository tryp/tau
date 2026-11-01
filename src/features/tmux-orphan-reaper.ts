import {
    readFileSync,
    readdirSync,
    statSync,
    readlinkSync,
    writeFileSync,
    renameSync,
} from "node:fs";
import { join } from "node:path";

export const ORPHAN_REAPER_METADATA_SUFFIX = ".owner.json";
export const ORPHAN_REAPER_STATE_SUFFIX = ".reaper.json";
export const ORPHAN_REAPER_DISABLE_ENV = "PI_TAU_DISABLE_ORPHAN_REAPER";
export const ORPHAN_REAPER_DRY_RUN_ENV = "PI_TAU_ORPHAN_REAPER_DRY_RUN";
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
    identity(pid: number): ProcessIdentity | null;
    cpuTime(pid: number): number | null;
    pipeBlockedWithoutPeer(pid: number): boolean | null;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;
    sleep(ms: number): Promise<void>;
    outputBytes(path: string): number | null;
    readText(path: string): string | null;
    writeText(path: string, value: string): void;
    rename(from: string, to: string): void;
    list(path: string): string[];
    exists(path: string): boolean;
}

export interface OrphanReaperOptions {
    rootDir: string;
    reader?: ReaperProcReader;
    dryRun?: boolean;
    disabled?: boolean;
    maxProcesses?: number;
    graceMs?: number;
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
    pipeBlockedWithoutPeer: (pid) => {
        try {
            const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim();
            if (!/pipe_(read|write|wait)|wait_for_partner/.test(wchan))
                return false;
            const syscall = readFileSync(`/proc/${pid}/syscall`, "utf8")
                .trim()
                .split(/\s+/);
            const fd = Number(syscall[1]);
            if (!Number.isSafeInteger(fd)) return null;
            const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
            const match = /^pipe:\[(\d+)\]$/.exec(link);
            if (!match) return null;
            const inode = match[1];
            for (const otherPid of readdirSync("/proc").filter(
                (x) => /^\d+$/.test(x) && Number(x) !== pid
            )) {
                let fds: string[];
                try {
                    fds = readdirSync(`/proc/${otherPid}/fd`);
                } catch {
                    return null;
                }
                for (const otherFd of fds) {
                    try {
                        if (
                            readlinkSync(`/proc/${otherPid}/fd/${otherFd}`) ===
                            `pipe:[${inode}]`
                        )
                            return false;
                    } catch {
                        return null;
                    }
                }
            }
            return true;
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

function descendants(
    root: ProcessIdentity,
    reader: ReaperProcReader
): ProcessIdentity[] | null {
    const pids = reader.pids();
    const identities = pids.map((pid) => reader.identity(pid));
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
    };
    if (options.disabled || process.env[ORPHAN_REAPER_DISABLE_ENV] === "1")
        return stats;
    const currentBoot = reader.bootId();
    if (!currentBoot) {
        stats.keptUnverified++;
        return stats;
    }
    let killedThisSweep = 0;
    for (const runName of reader.list(options.rootDir)) {
        if (!runName.startsWith("pi-tmux-")) continue;
        const runDir = join(options.rootDir, runName);
        const metadataNames = reader
            .list(runDir)
            .filter((name) => name.endsWith(ORPHAN_REAPER_METADATA_SUFFIX));
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
            if (!ownerCurrent && reader.pids().includes(owner.pid)) {
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
            const chain = descendants(currentWrapper, reader);
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
            saveState(reader, statePath, bytes, cpuTime, Date.now());
            if (!previous || previous.bytes !== bytes) {
                stats.keptGrowing++;
                continue;
            }
            if (previous.cpuTime !== cpuTime) {
                stats.keptLive++;
                continue;
            }
            const pipeResults = chain.map((proc) =>
                reader.pipeBlockedWithoutPeer(proc.pid)
            );
            if (!pipeResults.includes(true)) {
                if (pipeResults.includes(null)) stats.keptUnverified++;
                else stats.keptQuiet++;
                continue;
            }
            stats.orphaned++;
            if (
                options.dryRun ||
                process.env[ORPHAN_REAPER_DRY_RUN_ENV] === "1"
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
            if (!latestOwner && reader.pids().includes(owner.pid)) {
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
            let sent = 0;
            for (const proc of chain) {
                if (proc.bootId !== currentBoot) {
                    stats.keptUnverified++;
                    continue;
                }
                const check = reader.identity(proc.pid);
                if (!identityMatches(proc, check, currentBoot)) {
                    stats.keptUnverified++;
                    continue;
                }
                if (reader.signal(proc.pid, "SIGTERM")) {
                    sent++;
                    killedThisSweep++;
                } else stats.keptUnverified++;
            }
            if (sent === 0) {
                stats.keptUnverified++;
                continue;
            }
            await reader.sleep(options.graceMs ?? ORPHAN_REAPER_TERM_GRACE_MS);
            let escalated = false;
            for (const proc of chain) {
                const check = reader.identity(proc.pid);
                if (!identityMatches(proc, check, currentBoot)) {
                    if (!reader.pids().includes(proc.pid)) stats.killed++;
                    else stats.keptUnverified++;
                    continue;
                }
                if (reader.signal(proc.pid, "SIGKILL")) {
                    escalated = true;
                    stats.killed++;
                } else stats.keptUnverified++;
            }
            if (escalated) stats.killEscalated++;
        }
    }
    return stats;
}

export function formatOrphanReaperLog(
    stats: OrphanReaperStats,
    dryRun = false
): string {
    const targets = stats.wouldKill.length
        ? `${stats.wouldKill.join(",")}${stats.wouldKillOmitted ? `,+${stats.wouldKillOmitted}` : ""}`
        : "-";
    return `[tau] tmux-orphan-reaper dry-run=${dryRun || process.env[ORPHAN_REAPER_DRY_RUN_ENV] === "1"} examined=${stats.examined} orphaned=${stats.orphaned} killed=${stats.killed} kept-live=${stats.keptLive} kept-finished=${stats.keptFinished} kept-growing=${stats.keptGrowing} kept-quiet=${stats.keptQuiet} kept-unverified=${stats.keptUnverified} skipped-boot-mismatch=${stats.skippedBootMismatch} kill-escalated=${stats.killEscalated} would-kill=${targets}`;
}
