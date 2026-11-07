import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import {
    findJobSourceDetailsInSidecar,
    findJobSourceIdInSidecar,
    getSidecarIndexStats,
    indexJobOutputWithOutcome,
    purgeSidecar,
    readJobOutputFromSidecar,
    readJobOutputDetailsFromSidecar,
    indexJobOutputInSidecar,
    resetSidecarIndexStats,
    searchSidecarSources,
    trackJobOutputIndex,
} from "../features/background.ts";
import {
    canRunSidecarPurge,
    chunkText,
    formatSidecarReceipt,
    INLINE_CONTEXT_MAX_LINES,
    INLINE_FALLBACK_MAX_CHARS,
    prepareInlineOutput,
    scheduleSidecarPurge,
    type SidecarPurgeOptions,
} from "../features/sidecar.ts";
import type { BackgroundJob } from "../types.ts";
import { planPipeNerf } from "../features/pipe-nerf/parse.ts";

// ─── Fixture helpers ────────────────────────────────────────────────

const SIDECAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_sources (
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

CREATE TABLE IF NOT EXISTS context_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES context_sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  byte_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_source_severity (
  source_id TEXT PRIMARY KEY REFERENCES context_sources(id) ON DELETE CASCADE,
  err_line_count INTEGER NOT NULL,
  warn_line_count INTEGER NOT NULL,
  classified_line_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_sources_created ON context_sources(created_at);
CREATE INDEX IF NOT EXISTS idx_context_chunks_source ON context_chunks(source_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS context_chunks_fts USING fts5(
  title, content, content='context_chunks', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS context_chunks_ai AFTER INSERT ON context_chunks BEGIN
  INSERT INTO context_chunks_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS context_chunks_ad AFTER DELETE ON context_chunks BEGIN
  INSERT INTO context_chunks_fts(context_chunks_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS context_chunks_au AFTER UPDATE ON context_chunks BEGIN
  INSERT INTO context_chunks_fts(context_chunks_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO context_chunks_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;
`;

let tmpDir: string;

/** Create a temp directory for an isolated context.db. */
function setupTempDir(): string {
    const dir = join(
        tmpdir(),
        `pi-tau-sidecar-test-${randomUUID().slice(0, 8)}`
    );
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Create a fully-wired context.db at `dir` with schema applied. */
function createDb(dir: string): DatabaseSync {
    const dbPath = join(dir, "context.db");
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec(SIDECAR_SCHEMA);
    return db;
}

/** Helper to insert a bash_bg source row. */
function insertSource(
    db: DatabaseSync,
    overrides: Partial<{
        id: string;
        session_id: string | null;
        project_path: string | null;
        input_summary: string;
        created_at: number;
        byte_count: number;
        line_count: number;
        content_hash: string;
        preview_byte_count: number;
        returned_byte_count: number;
    }> = {}
): string {
    const id = overrides.id ?? `src_${randomUUID().slice(0, 8)}`;
    db.prepare(
        `INSERT INTO context_sources
         (id, session_id, project_path, tool_name, input_summary,
          created_at, byte_count, line_count, content_hash,
          preview_byte_count, returned_byte_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
        id,
        overrides.session_id ?? null,
        overrides.project_path ?? null,
        "bash_bg",
        overrides.input_summary ?? '{"command":"echo hi"}',
        overrides.created_at ?? Date.now(),
        overrides.byte_count ?? 100,
        overrides.line_count ?? 5,
        overrides.content_hash ?? `hash_${id}`,
        overrides.preview_byte_count ?? 50
    );
    return id;
}

/** Helper to insert a chunk row. */
function insertChunk(
    db: DatabaseSync,
    sourceId: string,
    ordinal: number,
    content: string
): string {
    const id = `${sourceId}_${String(ordinal).padStart(4, "0")}`;
    db.prepare(
        `INSERT INTO context_chunks (id, source_id, ordinal, title, content, byte_count)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        sourceId,
        ordinal,
        content.split("\n")[0] ?? "(empty)",
        content,
        Buffer.byteLength(content, "utf8")
    );
    return id;
}

// ─── beforeEach / afterEach ─────────────────────────────────────────

beforeEach(() => {
    resetSidecarIndexStats();
    tmpDir = setupTempDir();
    process.env.PI_CODING_AGENT_DIR = tmpDir;
});

afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
});

// ─── purgeSidecar tests ─────────────────────────────────────────────

void describe("purgeSidecar", () => {
    void it("deletes large source chunks in bounded slabs and yields between slabs", async () => {
        const db = createDb(tmpDir);
        const sourceId = insertSource(db, {
            created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
        });
        const insert = db.prepare(
            `INSERT INTO context_chunks (id, source_id, ordinal, title, content, byte_count)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (let ordinal = 0; ordinal < 5_000; ordinal++) {
            insert.run(
                `${sourceId}_${ordinal}`,
                sourceId,
                ordinal,
                "chunk",
                "x",
                1
            );
        }
        db.close();

        const deleteSizes: number[] = [];
        let yields = 0;
        const stats = await purgeSidecar(1, {
            dbPath: join(tmpDir, "context.db"),
            openDatabase: (path) => {
                const database = new DatabaseSync(path, {
                    enableForeignKeyConstraints: true,
                });
                return {
                    prepare(sql: string) {
                        const statement = database.prepare(sql);
                        return {
                            all: (...params: unknown[]) =>
                                statement.all(...(params as never[])),
                            run: (...params: unknown[]) => {
                                const result = statement.run(
                                    ...(params as never[])
                                );
                                if (sql.includes("DELETE FROM context_chunks"))
                                    deleteSizes.push(Number(result.changes));
                                return result;
                            },
                        };
                    },
                    close: () => database.close(),
                };
            },
            yieldToEventLoop: async () => {
                yields++;
            },
        });

        assert.equal(stats.chunksRemoved, 5_000);
        assert.ok(
            deleteSizes.length >= 11,
            "5000 chunks require 10 slabs plus empty check"
        );
        assert.ok(deleteSizes.every((count) => count <= 500));
        assert.ok(
            yields >= 10,
            "each full slab must yield before more trigger work"
        );
    });

    void it("paginates stale-source scans and yields before reading the full set", async () => {
        const db = createDb(tmpDir);
        const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
        for (let index = 0; index < 450; index++) {
            insertSource(db, {
                id: `page-${String(index).padStart(4, "0")}`,
                created_at: old,
            });
        }
        db.close();

        let scanPages = 0;
        let firstYieldRemaining = 0;
        const stats = await purgeSidecar(1, {
            dbPath: join(tmpDir, "context.db"),
            openDatabase: (path) => {
                const database = new DatabaseSync(path, {
                    enableForeignKeyConstraints: true,
                });
                return {
                    prepare(sql: string) {
                        const statement = database.prepare(sql);
                        return {
                            all: (...params: unknown[]) => {
                                if (
                                    sql.startsWith(
                                        "SELECT id FROM context_sources"
                                    )
                                )
                                    scanPages++;
                                return statement.all(...(params as never[]));
                            },
                            run: (...params: unknown[]) =>
                                statement.run(...(params as never[])),
                        };
                    },
                    close: () => database.close(),
                };
            },
            yieldToEventLoop: async () => {
                if (firstYieldRemaining === 0) {
                    const check = new DatabaseSync(join(tmpDir, "context.db"));
                    firstYieldRemaining = Number(
                        check
                            .prepare(
                                "SELECT count(*) AS count FROM context_sources"
                            )
                            .get()?.count ?? 0
                    );
                    check.close();
                }
            },
        });

        assert.equal(stats.pages, 3);
        assert.equal(scanPages, stats.pages, "each nonempty page is read once");
        assert.ok(
            firstYieldRemaining > 0,
            "first yield must precede reading all stale ids"
        );
        assert.equal(stats.sourcesRemoved, 450);
    });

    void it("yields to timers while the purge is still running", async () => {
        const pending = Array.from({ length: 8 }, (_, index) => ({
            id: `slow-${index}`,
        }));
        let clock = 0;
        let finished = false;
        let monitorFiredDuringPurge = false;
        const options: SidecarPurgeOptions = {
            dbPath: "injected",
            batchSize: 1,
            sliceBudgetMs: 10,
            totalBudgetMs: 2_000,
            now: () => clock,
            openDatabase: () => ({
                prepare(sql: string) {
                    return {
                        all() {
                            if (
                                sql.startsWith("SELECT id FROM context_sources")
                            )
                                return [...pending];
                            return [{ freelist_count: 0 }];
                        },
                        run(...ids: unknown[]) {
                            clock += 6;
                            if (sql.startsWith("DELETE FROM context_sources")) {
                                const id = String(ids[0]);
                                const index = pending.findIndex(
                                    (row) => row.id === id
                                );
                                if (index >= 0) pending.splice(index, 1);
                                return { changes: Number(index >= 0) };
                            }
                            return { changes: 1 };
                        },
                    };
                },
                close() {},
            }),
        };
        setTimeout(() => {
            monitorFiredDuringPurge = !finished && pending.length > 0;
        }, 0);

        const stats = await purgeSidecar(1, options);
        finished = true;
        assert.ok(
            monitorFiredDuringPurge,
            "timer should run between purge slices"
        );
        assert.ok(stats.slices > 0);
        assert.equal(stats.sourcesRemoved, 8);
    });

    void it("stops at its pass budget and resumes remaining sources on the next pass", async () => {
        const pending = Array.from({ length: 4 }, (_, index) => ({
            id: `budget-${index}`,
        }));
        let clock = 0;
        const options: SidecarPurgeOptions = {
            dbPath: "injected",
            batchSize: 1,
            sliceBudgetMs: 10,
            totalBudgetMs: 40,
            now: () => clock,
            openDatabase: () => ({
                prepare(sql: string) {
                    return {
                        all() {
                            return sql.startsWith(
                                "SELECT id FROM context_sources"
                            )
                                ? [...pending]
                                : [{ freelist_count: 0 }];
                        },
                        run(...ids: unknown[]) {
                            clock += 15;
                            if (sql.startsWith("DELETE FROM context_sources")) {
                                const index = pending.findIndex(
                                    (row) => row.id === String(ids[0])
                                );
                                if (index >= 0) pending.splice(index, 1);
                                return { changes: Number(index >= 0) };
                            }
                            return { changes: 1 };
                        },
                    };
                },
                close() {},
            }),
        };
        const first = await purgeSidecar(1, options);
        assert.equal(first.budgetExhausted, true);
        assert.equal(first.sourcesConsidered, 4);
        assert.equal(first.sourcesRemoved, 2);
        assert.equal(pending.length, 2);

        const second = await purgeSidecar(1, {
            ...options,
            totalBudgetMs: 100,
        });
        assert.equal(second.budgetExhausted, false);
        assert.equal(second.sourcesConsidered, 2);
        assert.equal(second.sourcesRemoved, 2);
        assert.equal(pending.length, 0);
    });

    void it("pauses between slices when turn processing begins", async () => {
        const pending = Array.from({ length: 3 }, (_, index) => ({
            id: `turn-${index}`,
        }));
        let clock = 0;
        let turnProcessing = false;
        let pausedOnce = false;
        let databaseOpens = 0;
        const options: SidecarPurgeOptions = {
            dbPath: "injected",
            batchSize: 1,
            sliceBudgetMs: 10,
            now: () => clock,
            shouldContinue: () => canRunSidecarPurge(turnProcessing, 0, 10_000),
            yieldToEventLoop: async () => {
                if (!pausedOnce) {
                    pausedOnce = true;
                    turnProcessing = true;
                }
            },
            openDatabase: () => {
                databaseOpens++;
                return {
                    prepare(sql: string) {
                        return {
                            all() {
                                return sql.startsWith(
                                    "SELECT id FROM context_sources"
                                )
                                    ? [...pending]
                                    : [{ freelist_count: 0 }];
                            },
                            run(...ids: unknown[]) {
                                clock += 6;
                                if (
                                    sql.startsWith(
                                        "DELETE FROM context_sources"
                                    )
                                ) {
                                    const index = pending.findIndex(
                                        (row) => row.id === String(ids[0])
                                    );
                                    if (index >= 0) pending.splice(index, 1);
                                    return { changes: Number(index >= 0) };
                                }
                                return { changes: 1 };
                            },
                        };
                    },
                    close() {},
                };
            },
        };
        const first = await purgeSidecar(1, options);
        assert.equal(first.budgetExhausted, true);
        assert.equal(first.sourcesRemoved, 1);
        assert.equal(pending.length, 2);

        const opensBeforeBusyCall = databaseOpens;
        const whileBusy = await purgeSidecar(1, options);
        assert.equal(whileBusy.sourcesConsidered, 0);
        assert.equal(
            databaseOpens,
            opensBeforeBusyCall,
            "busy turn must not open the database"
        );

        turnProcessing = false;
        const resumed = await purgeSidecar(1, options);
        assert.equal(resumed.sourcesRemoved, 2);
        assert.equal(pending.length, 0);
    });

    void it("does not schedule when maintenance is disabled", () => {
        const previous = process.env.PI_TAU_MAINTENANCE_DISABLE;
        process.env.PI_TAU_MAINTENANCE_DISABLE = "1";
        try {
            assert.equal(
                scheduleSidecarPurge(() => {}),
                undefined
            );
        } finally {
            if (previous === undefined)
                delete process.env.PI_TAU_MAINTENANCE_DISABLE;
            else process.env.PI_TAU_MAINTENANCE_DISABLE = previous;
        }
    });

    void it("succeeds silently when context.db does not exist", async () => {
        await purgeSidecar(1);
    });

    void it("succeeds silently when context.db exists but has no bash_bg entries", async () => {
        createDb(tmpDir);
        await purgeSidecar(1);
    });

    void it("does not throw when there are no stale entries (all entries are young)", async () => {
        const db = createDb(tmpDir);
        insertSource(db, { created_at: Date.now() });
        db.close();

        await purgeSidecar(1);
    });

    void it("removes stale bash_bg entries older than the cutoff", async () => {
        const db = createDb(tmpDir);
        const oldId = insertSource(db, {
            created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
        });
        insertChunk(db, oldId, 1, "stale output");
        db.close();

        await purgeSidecar(1);

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const remaining = check
            .prepare(
                "SELECT id FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .all() as { id: string }[];
        check.close();
        assert.equal(remaining.length, 0);
    });

    void it("removes only stale entries, keeping fresh ones", async () => {
        const db = createDb(tmpDir);
        const oldId = insertSource(db, {
            id: "old",
            created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
            content_hash: "hash_old",
        });
        insertChunk(db, oldId, 1, "old data");
        const freshId = insertSource(db, {
            id: "fresh",
            created_at: Date.now(),
            content_hash: "hash_fresh",
        });
        insertChunk(db, freshId, 1, "fresh data");
        db.close();

        await purgeSidecar(1);

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const remaining = check
            .prepare(
                "SELECT id FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .all() as { id: string }[];
        check.close();
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].id, "fresh");
    });

    void it("handles chunked deletion of >100 stale entries", async () => {
        const db = createDb(tmpDir);
        const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
        for (let i = 0; i < 150; i++) {
            const srcId = insertSource(db, {
                id: `stale_${i}`,
                created_at: cutoff,
                content_hash: `hash_stale_${i}`,
            });
            insertChunk(db, srcId, 1, `entry ${i}`);
        }
        db.close();

        await purgeSidecar(1);

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const remaining = check
            .prepare(
                "SELECT COUNT(*) as cnt FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .get() as { cnt: number };
        check.close();
        assert.equal(remaining.cnt, 0);
    });

    void it("skips non-bash_bg tool entries (only purges its own)", async () => {
        const db = createDb(tmpDir);
        db.prepare(
            `INSERT INTO context_sources
             (id, tool_name, input_summary, created_at, byte_count, line_count, content_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
            "other",
            "lsp",
            null,
            Date.now() - 30 * 24 * 60 * 60 * 1000,
            50,
            2,
            "hash_other"
        );
        db.close();

        await purgeSidecar(1);

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const remaining = check
            .prepare("SELECT id FROM context_sources")
            .all() as { id: string }[];
        check.close();
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].id, "other");
    });
});

// ─── readJobOutputFromSidecar tests ─────────────────────────────────

void describe("readJobOutputFromSidecar", () => {
    void it("returns null when context.db does not exist", async () => {
        const result = await readJobOutputFromSidecar("nonexistent");
        assert.equal(result, null);
    });

    void it("returns null when context_sources table does not exist", async () => {
        // Create a DB file without the schema
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
        db.prepare("CREATE TABLE dummy (id TEXT)").run();
        db.close();

        const result = await readJobOutputFromSidecar("job-1");
        assert.equal(result, null);
    });

    void it("returns null when job is not found", async () => {
        createDb(tmpDir);
        const result = await readJobOutputFromSidecar("job-unknown");
        assert.equal(result, null);
    });

    void it("returns null when source has no chunks", async () => {
        const db = createDb(tmpDir);
        insertSource(db, {
            input_summary: JSON.stringify({ jobId: "job-1" }),
        });
        db.close();

        const result = await readJobOutputFromSidecar("job-1");
        assert.equal(result, null);
    });

    void it("returns concatenated output for a job with chunks", async () => {
        const db = createDb(tmpDir);
        const srcId = insertSource(db, {
            input_summary: JSON.stringify({
                jobId: "job-output-1",
                logPath: "/tmp/test.log",
            }),
        });
        insertChunk(db, srcId, 1, "line one\n");
        insertChunk(db, srcId, 2, "line two\n");
        insertChunk(db, srcId, 3, "line three");
        db.close();

        const details = await readJobOutputDetailsFromSidecar("job-output-1");
        assert.ok(details !== null);
        assert.equal(details.logPath, "/tmp/test.log");
        assert.equal(details.text, "line one\nline two\nline three");
        assert.equal(
            await readJobOutputFromSidecar("job-output-1"),
            details.text
        );
    });

    void it("handles missing logPath gracefully", async () => {
        const db = createDb(tmpDir);
        const srcId = insertSource(db, {
            input_summary: JSON.stringify({ jobId: "job-nolog" }),
        });
        insertChunk(db, srcId, 1, "content");
        db.close();

        const result = await readJobOutputFromSidecar("job-nolog");
        assert.ok(result !== null);
        assert.equal(result, "content"); // no Log: prefix
    });

    void it("preserves chunk order across multiple chunks", async () => {
        const db = createDb(tmpDir);
        const srcId = insertSource(db, {
            input_summary: JSON.stringify({ jobId: "job-ordered" }),
        });
        insertChunk(db, srcId, 2, "second\n");
        insertChunk(db, srcId, 1, "first\n");
        insertChunk(db, srcId, 3, "third");
        db.close();

        const result = await readJobOutputFromSidecar("job-ordered");
        assert.equal(result, "first\nsecond\nthird");
    });
});

// ─── indexJobOutputInSidecar tests ──────────────────────────────────

void describe("indexJobOutputInSidecar", () => {
    function testJob(
        overrides: Partial<BackgroundJob> & { id: string }
    ): BackgroundJob {
        return {
            command: "echo test",
            pid: 9999,
            startTime: Date.now(),
            status: "completed",
            logPath: join(tmpDir, "job.log"),
            toolCallId: "tc-test",
            isBackgrounded: true,
            exitCode: 0,
            ...overrides,
        };
    }

    function writeLog(content: string): string {
        const p = join(tmpDir, "job.log");
        writeFileSync(p, content, "utf-8");
        return p;
    }

    void it("retains a bash_bg job's WHOLE log after pipe-nerf hoists the pipe", async () => {
        // Issue #3: bash_bg indexes through indexJobOutputWithOutcome, which has
        // NO inline threshold -- unlike prepareInlineOutput (the bash path, 300
        // lines). So a 60-line log a bash_bg produced is indexed in full. The
        // agent asked for `| tail -3` and still gets 3 lines inline, but all 60
        // are readable afterwards.
        //
        // This matters because bash_bg is the high-value case: 54% of background
        // jobs end in a limiter, and a job's log is the only record it has.
        createDb(tmpDir);
        const full = Array.from(
            { length: 60 },
            (_, i) => `bg-line-${i + 1}`
        ).join("\n");
        const job = testJob({
            id: "job-bg-hoisted",
            command: planPipeNerf("make test 2>&1 | tail -3").rewritten,
            logPath: writeLog(full),
        });

        // The rewrite must strip the pipe so the job writes an unfiltered log.
        assert.equal(
            planPipeNerf("make test 2>&1 | tail -3").rewritten,
            "make test 2>&1"
        );

        const outcome = await indexJobOutputWithOutcome(
            job,
            { cwd: tmpDir },
            "bash_bg",
            { useExternalApi: false }
        );
        assert.equal(outcome.status, "indexed");
        assert.ok(outcome.source, "the job must have a sidecar source");

        const back = await readJobOutputFromSidecar("job-bg-hoisted");
        assert.equal(back?.split("\n").length, 60);
        assert.equal(back, full);
    });

    void it("does not apply the inline threshold to a background job", async () => {
        // The two capture paths differ on purpose: prepareInlineOutput skips
        // indexing below 300 lines so ordinary small output is not indexed, while
        // indexJobOutputWithOutcome indexes any non-empty output because a
        // background job's log is its only record.
        createDb(tmpDir);
        const job = testJob({
            id: "job-bg-small",
            logPath: writeLog("one\ntwo\nthree"),
        });

        const outcome = await indexJobOutputWithOutcome(
            job,
            { cwd: tmpDir },
            "bash_bg",
            { useExternalApi: false }
        );
        assert.equal(outcome.status, "indexed");
        assert.equal(
            await readJobOutputFromSidecar("job-bg-small"),
            "one\ntwo\nthree"
        );
    });

    void it("classifies an unavailable sidecar without failing the job", async () => {
        const job = testJob({ id: "job-skip-1", logPath: writeLog("hello") });
        const outcome = await indexJobOutputWithOutcome(job, {});
        assert.deepEqual(outcome, {
            status: "skipped",
            eligible: true,
            reason: "sidecar_unavailable",
            errorCategory: "unavailable",
        });
        assert.deepEqual(getSidecarIndexStats(), {
            attempts: 1,
            eligible: 1,
            indexed: 0,
            skipped: 1,
            failed: 0,
            missingLogSkipped: 0,
            entriesDroppedWhenCtxStale: 0,
            emptySkipped: 0,
            unavailableSkipped: 1,
            schemaSkipped: 0,
            staleSessionIdentity: 0,
        });
    });

    void it("classifies empty output as intentionally ineligible", async () => {
        createDb(tmpDir);
        const job = testJob({ id: "job-empty-outcome", logPath: writeLog("") });
        const outcome = await indexJobOutputWithOutcome(job, {});
        assert.deepEqual(outcome, {
            status: "skipped",
            eligible: false,
            reason: "empty_output",
        });
        assert.equal(getSidecarIndexStats().emptySkipped, 1);
        assert.equal(getSidecarIndexStats().schemaSkipped, 0);
        assert.equal(getSidecarIndexStats().eligible, 0);
    });

    void it("reports indexed output and eligible coverage counters", async () => {
        createDb(tmpDir);
        const job = testJob({
            id: "job-index-outcome",
            logPath: writeLog("hello"),
        });
        const outcome = await indexJobOutputWithOutcome(job, { cwd: tmpDir });
        assert.equal(outcome.status, "indexed");
        assert.equal(outcome.eligible, true);
        assert.ok(outcome.source?.sourceId);
        const stats = getSidecarIndexStats();
        assert.deepEqual(stats, {
            attempts: 1,
            eligible: 1,
            indexed: 1,
            skipped: 0,
            failed: 0,
            missingLogSkipped: 0,
            entriesDroppedWhenCtxStale: 0,
            emptySkipped: 0,
            unavailableSkipped: 0,
            schemaSkipped: 0,
            staleSessionIdentity: 0,
        });
    });

    void it("persists errno, path, expected size, and job id after bounded read retries fail", async () => {
        const logPath = writeLog("expected output");
        const entries: { type: string; data: Record<string, unknown> }[] = [];
        const job = testJob({ id: "job-read-failed", logPath });
        const outcome = await indexJobOutputWithOutcome(
            job,
            {
                appendEntry: (type, data) =>
                    entries.push({
                        type,
                        data: data as Record<string, unknown>,
                    }),
            },
            "bash_bg",
            {
                readLog: async () => {
                    const error = Object.assign(
                        new Error("permission denied"),
                        { code: "EACCES" }
                    );
                    throw error;
                },
                failureLogPath: join(tmpDir, "sidecar-failures.jsonl"),
            }
        );
        assert.equal(outcome.status, "failed");
        assert.equal(outcome.eligible, false);
        assert.equal(outcome.reason, "read_failed");
        assert.equal(outcome.errorCategory, "permission");
        assert.equal(outcome.errorCode, "EACCES");
        assert.equal(outcome.retryCount, 1);
        assert.match(outcome.errorMessage ?? "", /permission denied/);
        assert.equal(getSidecarIndexStats().failed, 1);
        assert.deepEqual(entries, [
            {
                type: "sidecar-index-failure",
                data: {
                    jobId: "job-read-failed",
                    reason: "read_failed",
                    category: "permission",
                    errno: "EACCES",
                    errorMessage: "permission denied",
                    logPath,
                    expectedSizeBytes: Buffer.byteLength("expected output"),
                    retryCount: 1,
                },
            },
        ]);
        const failureLog = readFileSync(
            join(tmpDir, "sidecar-failures.jsonl"),
            "utf8"
        );
        assert.match(failureLog, /"category":"permission"/);
    });

    void it("counts ENOENT as an expected missing-log skip, not an I/O failure", async () => {
        const entries: { type: string; data: Record<string, unknown> }[] = [];
        const outcome = await indexJobOutputWithOutcome(
            testJob({
                id: "job-log-missing",
                logPath: join(tmpDir, "gone.log"),
            }),
            {
                appendEntry: (type, data) =>
                    entries.push({
                        type,
                        data: data as Record<string, unknown>,
                    }),
            },
            "bash_bg",
            {
                readLog: async () => {
                    throw Object.assign(
                        new Error("ENOENT: no such file or directory"),
                        {
                            code: "ENOENT",
                            errno: -2,
                        }
                    );
                },
                failureLogPath: join(tmpDir, "sidecar-failures.jsonl"),
            }
        );
        assert.equal(outcome.status, "skipped");
        assert.equal(outcome.reason, "log_missing");
        assert.equal(outcome.errorCategory, "missing");
        assert.equal(getSidecarIndexStats().failed, 0);
        assert.equal(getSidecarIndexStats().missingLogSkipped, 1);
        assert.equal(entries[0]?.data.reason, "log_missing");
        assert.equal(entries[0]?.data.category, "missing");
        assert.match(
            readFileSync(join(tmpDir, "sidecar-failures.jsonl"), "utf8"),
            /"reason":"log_missing"/
        );
    });

    void it("retries one transient log-read failure and indexes the output", async () => {
        createDb(tmpDir);
        let reads = 0;
        const outcome = await indexJobOutputWithOutcome(
            testJob({ id: "job-read-retry", logPath: writeLog("ignored") }),
            {},
            "bash_bg",
            {
                readLog: async () => {
                    reads += 1;
                    if (reads === 1) {
                        throw Object.assign(new Error("transient"), {
                            code: "ESTALE",
                        });
                    }
                    return "recovered output";
                },
            }
        );
        assert.equal(reads, 2);
        assert.equal(outcome.status, "indexed");
        assert.equal(outcome.retryCount, 1);
        assert.ok(outcome.source?.sourceId);
    });

    void it("keeps the legacy source-only API compatible", async () => {
        const job = testJob({
            id: "job-skip-legacy",
            logPath: writeLog("hello"),
        });
        assert.equal(await indexJobOutputInSidecar(job, {}), undefined);
    });

    void it("skips silently when context_sources table does not exist", async () => {
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
        db.prepare("CREATE TABLE dummy (id TEXT)").run();
        db.close();

        const job = testJob({ id: "job-skip-2", logPath: writeLog("hello") });
        await indexJobOutputInSidecar(job, {});
        // No throw — pass
    });

    void it("handles a minimal-schema DB without errors", async () => {
        // When only a bare context_sources table exists (no FTS5 triggers),
        // the pi-context external API applies the full schema automatically;
        // the direct SQLite fallback would roll back. Either path should
        // complete without throwing and produce at most one source row.
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
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
            )
        `);
        db.close();

        const job = testJob({
            id: "job-minimal-schema",
            logPath: writeLog("output for minimal-schema test"),
        });
        await indexJobOutputInSidecar(job, { cwd: tmpDir });

        // When the pi-context external API is available it applies the full
        // schema and writes successfully (1 source). In environments without
        // pi-context the direct fallback rolls back (0 sources). Both outcomes
        // are acceptable — the important thing is no uncaught exception.
        const check = new DatabaseSync(join(tmpDir, "context.db"), {});
        const count = check
            .prepare("SELECT COUNT(*) AS count FROM context_sources")
            .get() as { count: number };
        check.close();
        assert.ok(
            count.count === 0 || count.count === 1,
            `expected 0 or 1 source, got ${count.count}`
        );
    });

    void it("skips empty log files", async () => {
        createDb(tmpDir);
        const job = testJob({ id: "job-empty", logPath: writeLog("") });
        await indexJobOutputInSidecar(job, {});

        // Verify nothing was inserted
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const count = check
            .prepare(
                "SELECT COUNT(*) as cnt FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .get() as { cnt: number };
        check.close();
        assert.equal(count.cnt, 0);
    });

    void it("chunks long lines without dropping text", () => {
        const text = "prefix\n" + "x".repeat(5000) + "\ntrailing";
        const chunks = chunkText(text, "ctx_bg_test");
        assert.equal(chunks.map((chunk) => chunk.content).join(""), text);
        assert.ok(chunks.every((chunk) => chunk.byteCount <= 4096));
        assert.deepEqual(
            chunks.map((chunk) => chunk.ordinal),
            chunks.map((_, index) => index + 1)
        );
    });

    void it("indexes a job's output as source + chunks", async () => {
        createDb(tmpDir);
        const output = "hello world\nsecond line\nthird line";
        const job = testJob({ id: "job-index-1", logPath: writeLog(output) });
        const sourceId = await indexJobOutputInSidecar(job, { cwd: tmpDir });
        assert.ok(sourceId?.startsWith("ctx_bg_"));
        assert.equal(findJobSourceIdInSidecar(job.id), sourceId);

        // Check source was inserted
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const sources = check
            .prepare(
                `SELECT id, byte_count, line_count, input_summary
                 FROM context_sources WHERE tool_name = 'bash_bg'`
            )
            .all() as {
            id: string;
            byte_count: number;
            line_count: number;
            input_summary: string;
        }[];
        assert.equal(sources.length, 1);
        assert.equal(sources[0].line_count, 3);
        const summary = JSON.parse(sources[0].input_summary) as {
            jobId?: string;
        };
        assert.equal(summary.jobId, "job-index-1");

        // Check chunks were inserted
        const chunks = check
            .prepare(
                `SELECT ordinal, content FROM context_chunks
                 WHERE source_id = ? ORDER BY ordinal ASC`
            )
            .all(sources[0].id) as { ordinal: number; content: string }[];
        assert.ok(chunks.length >= 1);
        assert.ok(chunks[0].content.includes("hello world"));
        check.close();
    });

    void it("indexes output larger than the former 4 MiB cap", async () => {
        createDb(tmpDir);
        const output = `agent-large-token ${"x".repeat(4 * 1024 * 1024 + 1)}`;
        const job = testJob({
            id: "job-large-agent",
            command: "agent --inspect",
            logPath: writeLog(output),
        });

        const sourceId = await indexJobOutputInSidecar(
            job,
            { cwd: tmpDir },
            "agent_bg"
        );

        assert.ok(sourceId);
        assert.equal(
            (await readJobOutputFromSidecar(job.id))?.length,
            output.length
        );
        const matches = searchSidecarSources("agent-large-token", {
            toolNames: ["agent_bg"],
        });
        assert.equal(matches.length, 1);
        assert.equal(matches[0].sourceId, sourceId);
    });

    void it("formats severity when available and preserves the legacy receipt otherwise", () => {
        const source = { sourceId: "src-1", chunkIds: ["chunk-1"] };
        const unchanged = formatSidecarReceipt("bash", source, 100, 2);
        assert.equal(
            unchanged,
            [
                "[context-sidecar] Large bash output indexed locally",
                "Source: src-1",
                "Chunks: 1; original size: 100 bytes, 2 lines",
                '- Search snippets first: context_search query:"..." source_id:"src-1"',
                '- Retrieve focused output: context_get source_id:"src-1" chunk_id:"chunk-1"',
                '- Export full output for offline processing: context_export source_id:"src-1"',
            ].join("\n")
        );
        assert.match(
            formatSidecarReceipt(
                "bash",
                {
                    ...source,
                    severityCounts: { err: 3, warn: 12, total: 361 },
                },
                100,
                2
            ),
            /Severity: 3 err, 12 warn of 361 lines/
        );
    });

    void it("returns a compact receipt for large foreground output", async () => {
        createDb(tmpDir);
        const output = `ERROR: foreground-large-token\n${"x".repeat(40_000)}`;
        const job = testJob({
            id: "job-large-foreground",
            logPath: writeLog(output),
        });

        const prepared = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash",
            { useExternalApi: false }
        );

        assert.equal(prepared.truncated, true);
        assert.equal(prepared.partial, true);
        assert.equal(prepared.byteCount, Buffer.byteLength(output, "utf8"));
        assert.equal(prepared.totalLines, 2);
        assert.equal(prepared.empty, false);
        assert.ok(prepared.source);
        assert.match(prepared.text, /\[context-sidecar\]/);
        assert.match(prepared.text, /Severity: 1 err, 0 warn of 2 lines/);
        assert.ok(prepared.text.length < 10_000);
        assert.equal(await readJobOutputFromSidecar(job.id), output);
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const severity = check
            .prepare(
                "SELECT err_line_count, warn_line_count, classified_line_count FROM context_source_severity WHERE source_id = ?"
            )
            .get(prepared.source?.sourceId) as
            | {
                  err_line_count: number;
                  warn_line_count: number;
                  classified_line_count: number;
              }
            | undefined;
        assert.equal(severity?.err_line_count, 1);
        assert.equal(severity?.warn_line_count, 0);
        assert.equal(severity?.classified_line_count, 2);
        check.close();
    });

    void it("keeps indexing when the severity table is unavailable", async () => {
        const db = createDb(tmpDir);
        db.exec("DROP TABLE context_source_severity");
        db.close();
        const output = `ERROR: old sidecar schema\n${"x".repeat(40_000)}`;
        const job = testJob({
            id: "job-severity-write-failure",
            logPath: writeLog(output),
        });
        const prepared = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash",
            {
                useExternalApi: false,
            }
        );
        assert.ok(prepared.source);
        assert.match(prepared.text, /Severity: 1 err, 0 warn of 2 lines/);
        assert.equal(await readJobOutputFromSidecar(job.id), output);
    });

    void it("keeps indexing and the legacy receipt when classification throws", async () => {
        createDb(tmpDir);
        const output = `ERROR: classifier test\n${"x".repeat(40_000)}`;
        const job = testJob({
            id: "job-classify-failure",
            logPath: writeLog(output),
        });
        const prepared = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash",
            {
                useExternalApi: false,
                classify: () => {
                    throw new Error("classifier unavailable");
                },
            }
        );
        assert.equal(prepared.truncated, true);
        assert.ok(prepared.source);
        assert.match(prepared.text, /\[context-sidecar\]/);
        assert.doesNotMatch(prepared.text, /Severity:/);
        assert.equal(await readJobOutputFromSidecar(job.id), output);
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const severity = check
            .prepare(
                "SELECT COUNT(*) AS count FROM context_source_severity WHERE source_id = ?"
            )
            .get(prepared.source?.sourceId) as { count: number };
        assert.equal(severity.count, 0);
        check.close();
    });

    void it("indexes sub-threshold output when forced", async () => {
        // `pipe-nerf` shows the agent a bounded view, so the remainder has to be
        // captured. The commands it touches are usually BELOW the inline
        // threshold (an agent writes `| tail -5` on short output), which is
        // exactly where the default would skip the index and the rest of the
        // output would exist nowhere.
        createDb(tmpDir);
        const output = Array.from(
            { length: 60 },
            (_, i) => `line-${i + 1}`
        ).join("\n");
        assert.ok(output.split("\n").length <= INLINE_CONTEXT_MAX_LINES);
        const job = testJob({
            id: "job-forced-small",
            logPath: writeLog(output),
        });

        // Without force: inline, no source, nothing retained.
        const plain = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash"
        );
        assert.equal(plain.source, undefined);
        assert.equal(plain.truncated, false);

        // With force: index the full output but return the content for pipe-nerf
        // to bound after indexing; a receipt would suppress the requested view.
        const forced = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash",
            {
                force: true,
            }
        );
        assert.ok(forced.source, "a forced index must produce a source");
        assert.equal(forced.truncated, false);
        assert.equal(forced.text, output);
        assert.doesNotMatch(forced.text, /\[context-sidecar\]/);
        assert.equal(await readJobOutputFromSidecar(job.id), output);
    });

    void it("waits for a concurrent writer and records the retry wait", async () => {
        const db = createDb(tmpDir);
        db.close();
        const configured = new DatabaseSync(join(tmpDir, "context.db"), {
            enableForeignKeyConstraints: true,
            timeout: 5_000,
        });
        assert.equal(
            (
                configured.prepare("PRAGMA busy_timeout").get() as {
                    timeout: number;
                }
            ).timeout,
            5_000
        );
        configured.close();
        const dbPath = join(tmpDir, "context.db");
        const holder = spawn(
            process.execPath,
            [
                "-e",
                `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('LOCKED'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);`,
                dbPath,
            ],
            { stdio: ["ignore", "pipe", "inherit"] }
        );
        await new Promise<void>((resolve, reject) => {
            let output = "";
            holder.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();
                if (output.includes("LOCKED")) resolve();
            });
            holder.once("error", reject);
            holder.once("exit", (code) => {
                if (code !== 0) reject(new Error(`lock holder exited ${code}`));
            });
        });
        const job = testJob({
            id: "job-lock-wait",
            logPath: writeLog("waited output"),
        });
        const telemetry: { type: string; data: unknown }[] = [];
        const outcome = await indexJobOutputWithOutcome(
            job,
            { appendEntry: (type, data) => telemetry.push({ type, data }) },
            "bash",
            { useExternalApi: false }
        );
        assert.equal(outcome.status, "indexed");
        assert.equal(outcome.retryCount, 1);
        assert.ok((outcome.waitMs ?? 0) >= 300, `waitMs=${outcome.waitMs}`);
        assert.equal(telemetry[0]?.type, "sidecar-index-wait");
        assert.ok(telemetry[0]?.data);
        await new Promise<void>((resolve, reject) => {
            holder.once("exit", (code) =>
                code === 0 ? resolve() : reject(new Error(`exit ${code}`))
            );
        });
    });

    void it("persists every failure when stale appendEntry drops it and counts the drops", async () => {
        const db = createDb(tmpDir);
        db.exec(
            `CREATE TRIGGER reject_chunk BEFORE INSERT ON context_chunks BEGIN SELECT RAISE(ABORT, 'fixture sqlite failure'); END;`
        );
        db.close();
        const job = testJob({
            id: "job-sqlite-error",
            logPath: writeLog("fixture output"),
        });
        const context = {
            sessionManager: { getSessionId: () => "warning-session-fixture" },
            appendEntry: () => {
                throw new Error(
                    "This extension ctx is stale after session replacement or reload"
                );
            },
        };
        const failureLogPath = join(tmpDir, "sidecar-failures.jsonl");
        const first = await indexJobOutputWithOutcome(job, context, "bash", {
            useExternalApi: false,
            failureLogPath,
        });
        const second = await indexJobOutputWithOutcome(
            { ...job, id: "job-sqlite-error-2" },
            context,
            "bash",
            { useExternalApi: false, failureLogPath }
        );
        assert.equal(first.status, "failed");
        assert.match(first.errorMessage ?? "", /fixture sqlite failure/);
        assert.ok(first.errorCode);
        assert.equal(second.status, "failed");
        assert.equal(getSidecarIndexStats().entriesDroppedWhenCtxStale, 2);
        const lines = readFileSync(failureLogPath, "utf8")
            .trim()
            .split("\n")
            .map(
                (line) =>
                    JSON.parse(line) as {
                        entries_dropped_when_ctx_stale: number;
                    }
            );
        assert.equal(lines.length, 2);
        assert.deepEqual(
            lines.map((line) => line.entries_dropped_when_ctx_stale),
            [1, 2]
        );
    });

    void it("keeps inline text when a forced index cannot be created", async () => {
        // A forced index must never make the result worse: if the sidecar is
        // unavailable, the output is returned as-is rather than replaced by a
        // receipt that points nowhere.
        const output = Array.from(
            { length: 60 },
            (_, i) => `line-${i + 1}`
        ).join("\n");
        const job = testJob({
            id: "job-forced-no-db",
            logPath: writeLog(output),
        });

        const prepared = await prepareInlineOutput(job, {}, output, "bash", {
            force: true,
        });

        assert.equal(prepared.source, undefined);
        assert.equal(prepared.truncated, false);
        assert.equal(prepared.text, output);
    });

    void it("bounds large foreground output when the sidecar is unavailable", async () => {
        const output = `fallback-token\n${"x".repeat(40_000)}`;
        const job = testJob({
            id: "job-large-fallback",
            logPath: writeLog(output),
        });

        const prepared = await prepareInlineOutput(job, {}, output, "bash");

        assert.equal(prepared.truncated, true);
        assert.equal(prepared.partial, true);
        assert.equal(prepared.source, undefined);
        assert.equal(prepared.empty, false);
        assert.ok(prepared.text.length <= INLINE_FALLBACK_MAX_CHARS + 100);
        assert.match(prepared.text, /\[truncated/);
    });

    void it("deduplicates repeated indexing of one job", async () => {
        createDb(tmpDir);
        const output = "some unique output";
        const job = testJob({ id: "job-dedup-1", logPath: writeLog(output) });

        const first = await indexJobOutputInSidecar(job, { cwd: tmpDir });
        const second = await indexJobOutputInSidecar(job, { cwd: tmpDir });

        assert.equal(first, second);
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const sources = check
            .prepare(
                "SELECT id, returned_byte_count FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .all() as { id: string; returned_byte_count: number }[];
        assert.equal(sources.length, 1);
        // Indexing is internal maintenance, not a context read.
        assert.equal(sources[0].returned_byte_count, 0);
        check.close();
    });

    void it("keeps identical output from different jobs separately addressable", async () => {
        createDb(tmpDir);
        const output = "identical output from two jobs";
        const logPath = writeLog(output);
        const firstJob = testJob({ id: "job-same-output-a", logPath });
        const secondJob = testJob({ id: "job-same-output-b", logPath });

        const first = await indexJobOutputInSidecar(firstJob, { cwd: tmpDir });
        const second = await indexJobOutputInSidecar(secondJob, {
            cwd: tmpDir,
        });

        assert.ok(first);
        assert.ok(second);
        assert.notEqual(first, second);
        assert.equal(findJobSourceIdInSidecar(firstJob.id), first);
        assert.equal(findJobSourceIdInSidecar(secondJob.id), second);
        const details = findJobSourceDetailsInSidecar(secondJob.id);
        assert.deepEqual(details?.chunkIds.length, 1);
    });

    void it("searches indexed output with stable source and chunk IDs", async () => {
        createDb(tmpDir);
        const job = testJob({
            id: "job-search",
            logPath: writeLog("searchable diagnostic output"),
        });
        const sourceId = await indexJobOutputInSidecar(job, { cwd: tmpDir });
        const matches = searchSidecarSources("diagnostic", {
            toolNames: ["bash_bg"],
        });
        assert.equal(matches.length, 1);
        assert.equal(matches[0].sourceId, sourceId);
        assert.equal(matches[0].chunkIds.length, 1);
        assert.equal(matches[0].toolName, "bash_bg");

        const db = new DatabaseSync(join(tmpDir, "context.db"));
        const ftsMatches = db
            .prepare(
                "SELECT rowid FROM context_chunks_fts WHERE context_chunks_fts MATCH ?"
            )
            .all("diagnostic");
        assert.equal(ftsMatches.length, 1);
        db.close();

        const noMatch = searchSidecarSources("diagnostic", {
            toolNames: ["agent_bg"],
        });
        assert.equal(noMatch.length, 0);
    });

    void it("tracks source and chunk IDs on the job", async () => {
        createDb(tmpDir);
        const job = testJob({ id: "job-track", logPath: writeLog("tracked") });
        const result = await trackJobOutputIndex(job, { cwd: tmpDir });
        assert.ok(result);
        assert.equal(job.sourceId, result.sourceId);
        assert.deepEqual(job.chunkIds, result.chunkIds);
        assert.equal(job.outputIndexPromise !== undefined, true);
    });

    void it("reuses a concurrent indexing promise for one job", async () => {
        createDb(tmpDir);
        const job = testJob({
            id: "job-track-once",
            logPath: writeLog("tracked once"),
        });
        const first = trackJobOutputIndex(job, { cwd: tmpDir });
        const second = trackJobOutputIndex(job, { cwd: tmpDir });
        assert.equal(first, second);
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.ok(firstResult);
        assert.deepEqual(secondResult, firstResult);

        const db = new DatabaseSync(join(tmpDir, "context.db"));
        const count = db
            .prepare(
                "SELECT COUNT(*) AS count FROM context_sources WHERE json_extract(input_summary, '$.jobId') = ?"
            )
            .get("job-track-once") as { count: number };
        assert.equal(count.count, 1);
        db.close();
    });

    void it("waits for output readiness without creating a promise cycle", async () => {
        createDb(tmpDir);
        const output = "agent output after stream flush";
        const job = testJob({
            id: "job-ready-gate",
            logPath: writeLog(output),
        });
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tracked = trackJobOutputIndex(
            job,
            { cwd: tmpDir },
            "agent_bg",
            ready
        );
        release();
        const result = await tracked;
        assert.ok(result);
        assert.equal(await readJobOutputFromSidecar(job.id), output);
    });

    void it("round-trips output larger than one chunk without inserted separators", async () => {
        createDb(tmpDir);
        const output = `${"x".repeat(5000)}\nfinal line`;
        const job = testJob({ id: "job-roundtrip", logPath: writeLog(output) });
        await indexJobOutputInSidecar(job, { cwd: tmpDir });
        const details = await readJobOutputDetailsFromSidecar("job-roundtrip");
        assert.equal(details?.text, output);
    });

    void it("preserves session_id and project_path in source record", async () => {
        createDb(tmpDir);
        const output = "session-scoped output";
        const logPath = writeLog(output);
        const job = testJob({ id: "job-session", logPath });

        const sessionMgr = {
            getSessionFile: () => "/sessions/test-session.jsonl",
            getSessionId: () => null,
        };
        await indexJobOutputInSidecar(job, {
            cwd: tmpDir,
            sessionManager: sessionMgr,
        });

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const row = check
            .prepare(
                "SELECT session_id, project_path FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .get() as {
            session_id: string | null;
            project_path: string | null;
        };
        assert.equal(row.session_id, "/sessions/test-session.jsonl");
        assert.equal(row.project_path, tmpDir);
        check.close();
    });

    void it("indexes with a custom tool_name (agent_bg)", async () => {
        createDb(tmpDir);
        const output = "agent background output";
        const logPath = writeLog(output);
        const job = testJob({ id: "job-agent-1", logPath });

        await indexJobOutputInSidecar(job, { cwd: tmpDir }, "agent_bg");

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const row = check
            .prepare(
                "SELECT tool_name FROM context_sources WHERE tool_name = 'agent_bg'"
            )
            .get() as { tool_name: string } | undefined;
        assert.ok(row, "agent_bg source should be inserted");
        assert.equal(row.tool_name, "agent_bg");
        check.close();
    });
});

// ─── Double-close regression tests ─────────────────────────────────
// These verify the fix for the "database is not open" error caused by
// explicit db.close() + finally { db.close() } on early-return paths.

void describe("double-close regression", () => {
    void it("purgeSidecar: empty DB does not throw 'database is not open'", async () => {
        createDb(tmpDir);
        await purgeSidecar(1);
    });

    void it("purgeSidecar: all-fresh entries does not throw", async () => {
        const db = createDb(tmpDir);
        insertSource(db, { created_at: Date.now() });
        db.close();

        await purgeSidecar(1);
    });

    void it("readJobOutputFromSidecar: missing table does not throw", async () => {
        // DB exists but no context_sources table
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
        db.prepare("CREATE TABLE dummy (id TEXT)").run();
        db.close();

        const result = await readJobOutputFromSidecar("job-any");
        assert.equal(result, null);
    });

    void it("readJobOutputFromSidecar: missing job does not throw", async () => {
        createDb(tmpDir);
        const result = await readJobOutputFromSidecar("job-missing");
        assert.equal(result, null);
    });

    void it("indexJobOutputInSidecar: missing table does not throw", async () => {
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
        db.prepare("CREATE TABLE dummy (id TEXT)").run();
        db.close();

        const job: BackgroundJob = {
            id: "dummy",
            command: "echo",
            pid: 1,
            startTime: 0,
            status: "completed",
            logPath: join(tmpDir, "nope.log"),
            toolCallId: "tc-1",
            isBackgrounded: true,
        };
        await indexJobOutputInSidecar(job, {});
        // No throw
    });
});
