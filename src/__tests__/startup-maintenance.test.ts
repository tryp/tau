import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduleBackgroundJobRestore } from "../features/startup-maintenance.ts";
import { schedulePeriodicTmuxRunDirCleanup } from "../features/bash-tmux.ts";
import { scheduleSidecarPurge } from "../features/sidecar.ts";
import { resolveMaintenanceDelayMs } from "../index.ts";
import {
    forEachWithinTimeBudget,
    ORPHAN_REAPER_DELAY_ENV,
} from "../features/tmux-orphan-reaper.ts";

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

    void it("defers and unrefs sidecar purge and background-job restore", () => {
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
            let purges = 0;
            let restores = 0;
            scheduleSidecarPurge(() => purges++);
            scheduleBackgroundJobRestore(() => restores++);

            assert.equal(purges, 0);
            assert.equal(restores, 0);
            assert.ok(fakeTimers.records.every((timer) => timer.unrefCalled));
            fakeTimers.advance(100);
            assert.equal(restores, 1);
            assert.equal(purges, 0);
            fakeTimers.advance(4_900);
            assert.equal(purges, 1);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
        }
    });

    void it("runs once per session after the deferred first pass and recurs hourly", async () => {
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
            const calls: string[] = [];
            schedulePeriodicTmuxRunDirCleanup({
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
            assert.deepEqual(calls, []);
            assert.ok(fakeTimers.records.every((timer) => timer.unrefCalled));
            fakeTimers.advance(5_000);
            await waitFor(() => calls.length === 2);
            assert.deepEqual(calls, ["reaper", "sweep"]);
            fakeTimers.advance(60 * 60 * 1000);
            await waitFor(() => calls.length === 4);
            assert.deepEqual(calls, ["reaper", "sweep", "reaper", "sweep"]);
        } finally {
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
        }
    });

    void it("postpones maintenance until the caller reports sustained idle", async () => {
        const fakeTimers = new FakeTimers();
        const original = {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        };
        globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
        globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
        try {
            let idle = false;
            let runs = 0;
            schedulePeriodicTmuxRunDirCleanup({
                firstRunDelayMs: 30_000,
                intervalMs: 60 * 60 * 1000,
                isTestRunner: false,
                isIdle: () => idle,
                reapOrphans: async () => {
                    runs++;
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
                cleanup: async () => ({
                    examined: 0,
                    removed: 0,
                    keptAlive: 0,
                    keptUnknown: 0,
                }),
            });
            fakeTimers.advance(30_000);
            assert.equal(runs, 0);
            idle = true;
            fakeTimers.advance(1_000);
            await waitFor(() => runs === 1);
        } finally {
            globalThis.setTimeout = original.setTimeout;
            globalThis.clearTimeout = original.clearTimeout;
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

    void it("keeps the real extension entry deferred through session_start, rejecting unsafe timer delays", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-tau-startup-maintenance-"));
        const agentDir = join(dir, "agent");
        const fakeBin = join(dir, "bin");
        const cwd = join(dir, "cwd");
        const previousEnv = new Map<string, string | undefined>();
        const envKeys = [
            "PATH",
            "TMPDIR",
            "PI_CODING_AGENT_DIR",
            "PI_TAU_ORPHAN_REAPER_DELAY_MS",
            "PI_TAU_DISABLE_ORPHAN_REAPER",
            "PI_TAU_ENABLE_ORPHAN_REAPER",
            "PI_TAU_TMUX_RUN_DIR_RETENTION_MS",
            "PI_TAU_TMUX_LIVENESS_POLL_EVERY",
            "PI_TAU_TEST_TMUX_LOG",
        ];
        const rememberEnv = (key: string) =>
            previousEnv.set(key, process.env[key]);
        for (const key of envKeys) rememberEnv(key);
        const oldSetTimeout = globalThis.setTimeout;
        const oldSetInterval = globalThis.setInterval;
        const oldClearTimeout = globalThis.clearTimeout;
        const oldClearInterval = globalThis.clearInterval;
        const oldDateNow = Date.now;
        const oldReaddirSync = fs.readdirSync;
        const oldReaddir = fsPromises.readdir;
        const oldPrepare = Object.getOwnPropertyDescriptor(
            DatabaseSync.prototype,
            "prepare"
        )!.value as typeof DatabaseSync.prototype.prepare;
        const oldNodeTestContext = process.env.NODE_TEST_CONTEXT;
        const oldArgv = [...process.argv];
        const fakeTimers = new FakeTimers();
        let procScans = 0;
        let tmpSweeps = 0;
        let sidecarSelects = 0;
        let sqliteInteractions = 0;
        const tools = new Map<
            string,
            { execute: (...args: unknown[]) => unknown }
        >();
        const events = new Map<
            string,
            Array<(...args: unknown[]) => unknown>
        >();
        const appended: Array<{ type: string; data: unknown }> = [];
        const userMessages: unknown[] = [];
        let stopExtension: (() => Promise<void>) | undefined;

        try {
            mkdirSync(agentDir, { recursive: true });
            mkdirSync(fakeBin, { recursive: true });
            mkdirSync(cwd, { recursive: true });
            const fakeTmux = join(fakeBin, "tmux");
            const tmuxLog = join(dir, "tmux.log");
            writeFileSync(tmuxLog, "");
            writeFileSync(
                fakeTmux,
                `#!/bin/sh
echo "$*" >> "$PI_TAU_TEST_TMUX_LOG"
exit 0
`
            );
            chmodSync(fakeTmux, 0o755);

            const db = new DatabaseSync(join(agentDir, "context.db"));
            db.exec(`
                CREATE TABLE context_sources (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    project_path TEXT,
                    tool_name TEXT NOT NULL,
                    input_summary TEXT,
                    created_at INTEGER NOT NULL,
                    byte_count INTEGER NOT NULL,
                    line_count INTEGER NOT NULL,
                    content_hash TEXT NOT NULL,
                    preview_byte_count INTEGER NOT NULL DEFAULT 0,
                    returned_byte_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE context_chunks (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES context_sources(id) ON DELETE CASCADE,
                    ordinal INTEGER NOT NULL,
                    title TEXT,
                    content TEXT NOT NULL,
                    byte_count INTEGER NOT NULL
                );
            `);
            db.prepare(
                `INSERT INTO context_sources
                    (id, tool_name, created_at, byte_count, line_count, content_hash)
                 VALUES (?, ?, ?, 0, 0, '')`
            ).run("stale", "bash_bg", 1);
            db.close();

            process.env.PATH = `${fakeBin}:${previousEnv.get("PATH") ?? ""}`;
            process.env.TMPDIR = dir;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            process.env[ORPHAN_REAPER_DELAY_ENV] = "2147483648";
            delete process.env.PI_TAU_DISABLE_ORPHAN_REAPER;
            delete process.env.PI_TAU_ENABLE_ORPHAN_REAPER;
            delete process.env.NODE_TEST_CONTEXT;
            process.argv = process.argv.filter((arg) => arg !== "--test");
            process.env.PI_TAU_TMUX_RUN_DIR_RETENTION_MS = "2592000000";
            process.env.PI_TAU_TMUX_LIVENESS_POLL_EVERY = "1";
            process.env.PI_TAU_TEST_TMUX_LOG = tmuxLog;

            Date.now = () => oldDateNow() + fakeTimers.now;
            globalThis.setTimeout = fakeTimers.setTimeout as typeof setTimeout;
            globalThis.setInterval =
                fakeTimers.setInterval as typeof setInterval;
            globalThis.clearTimeout = fakeTimers.clear as typeof clearTimeout;
            globalThis.clearInterval = fakeTimers.clear as typeof clearInterval;
            fs.readdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
                if (String(path) === "/tmp") {
                    tmpSweeps++;
                    return [];
                }
                return oldReaddirSync(path, ...(args as [never]));
            }) as typeof fs.readdirSync;
            fsPromises.readdir = (async (
                path: fs.PathLike,
                ...args: unknown[]
            ) => {
                if (String(path) === "/proc") procScans++;
                if (String(path) === "/tmp") {
                    tmpSweeps++;
                    return [];
                }
                return oldReaddir(path, ...(args as [never]));
            }) as typeof fsPromises.readdir;
            syncBuiltinESMExports();
            DatabaseSync.prototype.prepare = function (sql: string) {
                sqliteInteractions++;
                if (
                    sql
                        .replace(/\s+/g, " ")
                        .trim()
                        .startsWith("SELECT id FROM context_sources") &&
                    sql.includes("created_at < ?")
                ) {
                    sidecarSelects++;
                }
                return Reflect.apply(oldPrepare, this, [sql]);
            };

            const { default: registerTau } = await import("../index.ts");
            const pi = new Proxy(
                {
                    on: (
                        event: string,
                        handler: (...args: unknown[]) => unknown
                    ) =>
                        events.set(event, [
                            ...(events.get(event) ?? []),
                            handler,
                        ]),
                    registerTool: (tool: {
                        name: string;
                        execute: (...args: unknown[]) => unknown;
                    }) => tools.set(tool.name, tool),
                    appendEntry: (type: string, data: unknown) =>
                        appended.push({ type, data }),
                    getAllTools: () => [],
                    getActiveTools: () => [],
                    getFlag: () => undefined,
                    sendMessage: () => {},
                    sendUserMessage: (message: unknown) =>
                        userMessages.push(message),
                    cancelQueuedMessage: () => false,
                    registerMessageRenderer: () => {},
                    getSessionName: () => "startup-test",
                },
                {
                    get(target, key: string) {
                        if (key in target)
                            return target[key as keyof typeof target];
                        return () => {};
                    },
                }
            );
            registerTau(pi as never);
            const assertRestoreIdle = () => {
                const terminalRecords = appended.filter(
                    (entry) =>
                        entry.type === "background-job-liveness" &&
                        (entry.data as { event?: string }).event === "terminal"
                );
                assert.equal(terminalRecords.length, 0);
                assert.equal(sqliteInteractions, 0);
                assert.equal(readFileSync(tmuxLog, "utf8").trim(), "");
            };
            assertRestoreIdle();
            assert.equal(procScans, 0);
            assert.equal(tmpSweeps, 0);
            assert.equal(sidecarSelects, 0);
            assert.ok(fakeTimers.records.some((timer) => timer.due === 5_000));
            assert.ok(
                fakeTimers.records
                    .filter((timer) => timer.due === 5_000)
                    .every((timer) => timer.unrefCalled)
            );

            const jobId = "deferred-restore-job";
            const jobOutputFile = join(dir, "job.out");
            writeFileSync(jobOutputFile, "restored job output\n");
            const entries = [
                {
                    type: "custom",
                    customType: "background-tasks-state",
                    data: {
                        jobs: [
                            [
                                jobId,
                                {
                                    id: jobId,
                                    command: "echo done",
                                    pid: 2_147_483_647,
                                    startTime: Date.now() - 1000,
                                    tmux: {
                                        session: "restore-test",
                                        windowId: "@1",
                                        exitCodeFile: join(dir, "missing.exit"),
                                        outputFile: jobOutputFile,
                                        gitRoot: cwd,
                                    },
                                    status: "running",
                                    logPath: join(dir, "job.out"),
                                    toolCallId: "call-1",
                                    isBackgrounded: true,
                                    wantsCompletionNotification: false,
                                },
                            ],
                        ],
                        jobCounter: 1,
                    },
                },
                {
                    type: "custom",
                    customType: "callbacks-state",
                    data: {
                        callbacks: [
                            {
                                id: "orphaned-reminder",
                                message: "check on deferred job",
                                fireAt: new Date(
                                    Date.now() + 250
                                ).toISOString(),
                                createdAt: new Date().toISOString(),
                                source: "agent",
                                linkedJobId: "untracked-job",
                            },
                        ],
                        nextId: 2,
                    },
                },
            ];
            const ctx = {
                cwd,
                hasUI: false,
                ui: {
                    setStatus() {},
                    notify() {},
                    setWidget() {},
                    setTitle() {},
                    theme: { fg: (_: string, text: string) => text },
                },
                sessionManager: {
                    getEntries: () => entries,
                    getBranch: () => [],
                    getSessionFile: () => "startup-test.jsonl",
                    getSessionId: () => "startup-test",
                },
            };
            stopExtension = async () => {
                for (const handler of events.get("session_shutdown") ?? []) {
                    await handler({}, ctx);
                }
            };
            const startHandlers = events.get("session_start");
            assert.ok(startHandlers?.length);
            const mainStart = startHandlers[startHandlers.length - 1];
            assert.ok(mainStart);
            for (const handler of startHandlers.slice(0, -1)) {
                await handler({}, ctx);
            }
            const shutdownHandlers = events.get("session_shutdown") ?? [];
            const indexShutdown = shutdownHandlers[shutdownHandlers.length - 1];
            assert.ok(indexShutdown);
            const staleJobId = "stale-timer-job";
            const staleContext = {
                ...ctx,
                sessionManager: {
                    ...ctx.sessionManager,
                    getEntries: () => [
                        {
                            type: "custom",
                            customType: "background-tasks-state",
                            data: {
                                jobs: [
                                    [
                                        staleJobId,
                                        {
                                            id: staleJobId,
                                            command: "echo stale",
                                            pid: 2_147_483_647,
                                            startTime: Date.now() - 1000,
                                            status: "running",
                                            logPath: join(dir, "stale-job.out"),
                                            toolCallId: "call-stale",
                                            isBackgrounded: true,
                                            wantsCompletionNotification: false,
                                        },
                                    ],
                                ],
                                jobCounter: 1,
                            },
                        },
                    ],
                },
            };
            const startupA = mainStart({}, staleContext) as Promise<void>;
            assertRestoreIdle();
            fakeTimers.advance(0);
            assert.equal(procScans, 0);
            assert.equal(tmpSweeps, 0);
            assert.equal(sidecarSelects, 0);
            await startupA;
            assertRestoreIdle();

            // Shutdown A after it has scheduled all maintenance, then start B
            // before any of A's timers can fire.
            await indexShutdown({}, staleContext);
            const startupB = mainStart({}, ctx) as Promise<void>;
            await startupB;
            assertRestoreIdle();

            const maintenanceTimer = fakeTimers.records
                .filter(
                    (timer) =>
                        !timer.cleared &&
                        timer.interval === 0 &&
                        timer.due >= 30_000
                )
                .at(-1);
            assert.ok(maintenanceTimer, "maintenance timer uses the 30s floor");
            assert.equal(maintenanceTimer.due, 30_000);
            Date.now = () => oldDateNow() + 30_000;
            maintenanceTimer.callback();
            Date.now = oldDateNow;
            await new Promise<void>((resolve) => realSetTimeout(resolve, 50));
            assert.equal(
                procScans,
                1,
                `maintenance callback did not scan; due=${maintenanceTimer.due}, cleared=${maintenanceTimer.cleared}`
            );
            await waitFor(() => tmpSweeps === 2);
            assert.equal(procScans, 1, "only B's deferred orphan scan runs");
            assert.equal(
                tmpSweeps,
                2,
                "B performs one reaper root enumeration and one run-dir sweep"
            );
            await waitFor(() =>
                readFileSync(
                    join(dir, "pi-tau-maintenance.log"),
                    "utf8"
                ).includes("maintenance delay rejected above Node timer range")
            );
            assert.equal(sidecarSelects, 0);
            await waitFor(
                () => readFileSync(tmuxLog, "utf8").trim().length > 0
            );

            fakeTimers.advance(100);
            await waitFor(() => {
                const terminals = appended.filter(
                    (entry) =>
                        entry.type === "background-job-liveness" &&
                        (entry.data as { event?: string }).event === "terminal"
                );
                return terminals.length === 1 && sqliteInteractions > 0;
            });
            const terminalRecords = appended.filter(
                (entry) =>
                    entry.type === "background-job-liveness" &&
                    (entry.data as { event?: string }).event === "terminal"
            );
            assert.equal(terminalRecords.length, 1);
            assert.equal(
                (terminalRecords[0].data as { jobId?: string }).jobId,
                "deferred-restore-job",
                "A's stale restore must no-op while B's restore remains active"
            );
            assert.ok(sqliteInteractions > 0);
            const jobsTool = tools.get("jobs");
            assert.ok(jobsTool);
            const listed = (await jobsTool.execute(
                "call",
                { action: "list" },
                undefined,
                () => {},
                ctx
            )) as {
                content: Array<{ text: string }>;
            };
            assert.match(
                listed.content[0].text,
                /deferred-restore-job: .*failed/
            );

            fakeTimers.advance(150);
            assert.ok(
                userMessages.some((message) =>
                    String(message).includes(
                        "linked job untracked-job is no longer tracked in this session"
                    )
                ),
                "orphaned reminder restoration must still deliver its notice"
            );

            fakeTimers.advance(4_750);
            await waitFor(() => sidecarSelects === 1);
            assert.equal(sidecarSelects, 1);
            const dbAfterPurge = new DatabaseSync(join(agentDir, "context.db"));
            assert.equal(
                dbAfterPurge
                    .prepare(
                        "SELECT id FROM context_sources WHERE id = 'stale'"
                    )
                    .all().length,
                0
            );
            dbAfterPurge.close();

            const makeSnapshot = (jobId: string) => [
                {
                    type: "custom",
                    customType: "background-tasks-state",
                    data: {
                        jobs: [
                            [
                                jobId,
                                {
                                    id: jobId,
                                    command: "echo generation",
                                    pid: 2_147_483_647,
                                    startTime: Date.now() - 1000,
                                    status: "running",
                                    logPath: jobOutputFile,
                                    toolCallId: `call-${jobId}`,
                                    isBackgrounded: true,
                                    wantsCompletionNotification: false,
                                },
                            ],
                        ],
                        jobCounter: 1,
                    },
                },
            ];
            const contextWithSnapshot = (snapshot: unknown[]) => ({
                ...ctx,
                sessionManager: {
                    ...ctx.sessionManager,
                    getEntries: () => snapshot,
                },
            });
            const terminalJobIds = () =>
                appended
                    .filter(
                        (entry) =>
                            entry.type === "background-job-liveness" &&
                            (entry.data as { event?: string }).event ===
                                "terminal"
                    )
                    .map((entry) => (entry.data as { jobId?: string }).jobId);
            const timersBeforeOverlap = fakeTimers.records.length;
            const overlapStartupA = mainStart(
                {},
                contextWithSnapshot(makeSnapshot("stale-generation-job"))
            ) as Promise<void>;
            const overlapStartupB = mainStart(
                {},
                contextWithSnapshot(makeSnapshot("current-generation-job"))
            ) as Promise<void>;
            await overlapStartupA;
            const overlapRestoreTimers = fakeTimers.records
                .slice(timersBeforeOverlap)
                .filter((timer) => timer.due === fakeTimers.now + 100);
            assert.equal(
                overlapRestoreTimers.length,
                1,
                "only the latest overlapping session_start may schedule restore"
            );
            await overlapStartupB;
            fakeTimers.advance(100);
            await waitFor(() =>
                terminalJobIds().includes("current-generation-job")
            );
            assert.equal(
                terminalJobIds().includes("stale-generation-job"),
                false,
                "the superseded startup must not restore using its stale entries"
            );

            assert.ok(mainStart);
            assert.ok(indexShutdown);
            const timersBeforeShutdownRace = fakeTimers.records.length;
            const lateStartup = mainStart({}, ctx);
            await indexShutdown({}, ctx);
            await lateStartup;
            assert.equal(
                fakeTimers.records.length,
                timersBeforeShutdownRace,
                "shutdown during startup must not schedule a late restore"
            );

            const maintenanceTimers = fakeTimers.records.filter(
                (timer) =>
                    timer.due === 0 ||
                    timer.due === 100 ||
                    timer.due === 5_000 ||
                    timer.interval === 3_600_000
            );
            assert.ok(maintenanceTimers.length >= 4);
            assert.ok(
                maintenanceTimers.every((timer) => timer.unrefCalled),
                "maintenance timers must not keep the process alive"
            );
        } finally {
            await stopExtension?.();
            Date.now = oldDateNow;
            globalThis.setTimeout = oldSetTimeout;
            globalThis.setInterval = oldSetInterval;
            globalThis.clearTimeout = oldClearTimeout;
            globalThis.clearInterval = oldClearInterval;
            fs.readdirSync = oldReaddirSync;
            fsPromises.readdir = oldReaddir;
            syncBuiltinESMExports();
            DatabaseSync.prototype.prepare = oldPrepare;
            if (oldNodeTestContext === undefined)
                delete process.env.NODE_TEST_CONTEXT;
            else process.env.NODE_TEST_CONTEXT = oldNodeTestContext;
            process.argv = oldArgv;
            for (const key of envKeys) {
                const value = previousEnv.get(key);
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
