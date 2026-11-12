import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { register_context_sidecar_owner } from "@spences10/pi-context";
import {
    findJobSourceDetailsInSidecar,
    findJobSourceIdInSidecar,
    getSidecarIndexStats,
    indexJobOutputWithOutcome,
    readJobOutputFromSidecar,
    readJobOutputDetailsFromSidecar,
    indexJobOutputInSidecar,
    resetSidecarIndexStats,
    searchSidecarSources,
    trackJobOutputIndex,
} from "../features/background.ts";
import {
    formatSidecarReceipt,
    INLINE_CONTEXT_MAX_LINES,
    INLINE_FALLBACK_MAX_CHARS,
    prepareInlineOutput,
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
let closeOwner: (() => Promise<void>) | undefined;
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const priorContextDb = process.env.MY_PI_CONTEXT_DB;

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
    process.env.MY_PI_CONTEXT_DB = join(tmpDir, "context.db");
    closeOwner = register_context_sidecar_owner();
});

afterEach(async () => {
    await closeOwner?.();
    closeOwner = undefined;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorContextDb === undefined) delete process.env.MY_PI_CONTEXT_DB;
    else process.env.MY_PI_CONTEXT_DB = priorContextDb;
    rmSync(tmpDir, { recursive: true, force: true });
});

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
            {}
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
            {}
        );
        assert.equal(outcome.status, "indexed");
        assert.equal(
            await readJobOutputFromSidecar("job-bg-small"),
            "one\ntwo\nthree"
        );
    });

    void it("persists an unavailable-owner skip counter without opening the DB", async () => {
        await closeOwner?.();
        closeOwner = undefined;
        const entries: { type: string; data: Record<string, unknown> }[] = [];
        const failureLogPath = join(tmpDir, "owner-unavailable.jsonl");
        const job = testJob({ id: "job-skip-1", logPath: writeLog("hello") });
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
            { failureLogPath }
        );
        assert.deepEqual(outcome, {
            status: "skipped",
            eligible: true,
            reason: "sidecar_unavailable",
            errorCategory: "unavailable",
        });
        assert.equal(getSidecarIndexStats().unavailableSkipped, 1);
        assert.deepEqual(entries, [
            {
                type: "sidecar-index-owner-unavailable",
                data: {
                    jobId: "job-skip-1",
                    reason: "owner_unavailable",
                    detail: "pi-context owner descriptor unavailable",
                    unavailableSkipped: 1,
                },
            },
        ]);
        assert.match(
            readFileSync(failureLogPath, "utf8"),
            /"unavailableSkipped":1/
        );
        assert.equal(existsSync(join(tmpDir, "context.db")), false);
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

    void it("keeps the legacy source-only API compatible through the owner", async () => {
        const job = testJob({
            id: "job-skip-legacy",
            logPath: writeLog("hello"),
        });
        assert.ok(await indexJobOutputInSidecar(job, {}));
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

        // The owner repairs the schema and indexes the source through its store.
        const check = new DatabaseSync(join(tmpDir, "context.db"), {});
        const count = check
            .prepare("SELECT COUNT(*) AS count FROM context_sources")
            .get() as { count: number };
        check.close();
        assert.equal(count.count, 1);
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

    void it("indexes a job's output as source + chunks", async () => {
        createDb(tmpDir);
        const output = "hello world\nsecond line\nthird line";
        const job = testJob({ id: "job-index-1", logPath: writeLog(output) });
        const sourceId = await indexJobOutputInSidecar(job, { cwd: tmpDir });
        assert.ok(sourceId?.startsWith("ctx_"));
        assert.equal(await findJobSourceIdInSidecar(job.id), sourceId);

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
        const output = `agent-large-token\n${Array.from(
            { length: 8_192 },
            (_, index) => `log event ${index} ${"x".repeat(500)}`
        ).join("\n")}`;
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
        const matches = await searchSidecarSources("agent-large-token", {
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
        const output = Array.from(
            { length: 200 },
            (_, index) =>
                `${index === 0 ? "ERROR: foreground-large-token" : `line ${index}`} ${"x".repeat(190)}`
        ).join("\n");
        const job = testJob({
            id: "job-large-foreground",
            logPath: writeLog(output),
        });

        const prepared = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash",
            {}
        );

        assert.equal(prepared.truncated, true);
        assert.equal(prepared.partial, true);
        assert.equal(prepared.byteCount, Buffer.byteLength(output, "utf8"));
        assert.equal(prepared.totalLines, 200);
        assert.equal(prepared.empty, false);
        assert.ok(prepared.source);
        assert.match(prepared.text, /\[context-sidecar\]/);
        assert.match(prepared.text, /Severity: 1 err, 0 warn of 200 lines/);
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
        assert.equal(severity?.classified_line_count, 200);
        check.close();
    });

    void it("lets the owner initialize its schema when no database exists", async () => {
        const output = Array.from(
            { length: 200 },
            (_, index) =>
                `${index === 0 ? "ERROR: owner-initialized-schema" : `line ${index}`} ${"x".repeat(190)}`
        ).join("\n");
        const job = testJob({
            id: "job-severity-write-failure",
            logPath: writeLog(output),
        });
        const prepared = await prepareInlineOutput(
            job,
            { cwd: tmpDir },
            output,
            "bash",
            {}
        );
        assert.ok(prepared.source);
        assert.match(prepared.text, /Severity: 1 err, 0 warn of 200 lines/);
        assert.equal(await readJobOutputFromSidecar(job.id), output);
    });

    void it("keeps indexing and the legacy receipt when classification throws", async () => {
        createDb(tmpDir);
        const output = Array.from(
            { length: 200 },
            (_, index) =>
                `${index === 0 ? "ERROR: classifier test" : `line ${index}`} ${"x".repeat(190)}`
        ).join("\n");
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
        // The owner store classifies and persists severities independently of
        // tau's optional receipt classifier.
        assert.equal(severity.count, 1);
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

    void it("counts unavailable-owner skips when stale appendEntry rejects entries", async () => {
        await closeOwner?.();
        closeOwner = undefined;
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
            failureLogPath,
        });
        const second = await indexJobOutputWithOutcome(
            { ...job, id: "job-sqlite-error-2" },
            context,
            "bash",
            { failureLogPath }
        );
        assert.equal(first.status, "skipped");
        assert.equal(first.reason, "sidecar_unavailable");
        assert.equal(second.status, "skipped");
        assert.equal(getSidecarIndexStats().unavailableSkipped, 2);
        assert.equal(getSidecarIndexStats().entriesDroppedWhenCtxStale, 2);
        const lines = readFileSync(failureLogPath, "utf8")
            .trim()
            .split("\n")
            .map(
                (line) =>
                    JSON.parse(line) as {
                        unavailableSkipped: number;
                    }
            );
        assert.equal(lines.length, 2);
        assert.deepEqual(
            lines.map((line) => line.unavailableSkipped),
            [1, 2]
        );
    });

    void it("keeps inline text when a forced index cannot be created", async () => {
        // A forced index must never make the result worse: if the sidecar is
        // unavailable, the output is returned as-is rather than replaced by a
        // receipt that points nowhere.
        await closeOwner?.();
        closeOwner = undefined;
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
        await closeOwner?.();
        closeOwner = undefined;
        const output = `fallback-token\n${Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(180)}`).join("\n")}`;
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
        // The owner returns the stable source ID; reading it through the client
        // may update its own retrieval accounting, which tau does not own.
        assert.ok(sources[0].returned_byte_count >= 0);
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
        assert.equal(await findJobSourceIdInSidecar(firstJob.id), first);
        assert.equal(await findJobSourceIdInSidecar(secondJob.id), second);
        const details = await findJobSourceDetailsInSidecar(secondJob.id);
        assert.deepEqual(details?.chunkIds.length, 1);
    });

    void it("searches indexed output with stable source and chunk IDs", async () => {
        createDb(tmpDir);
        const job = testJob({
            id: "job-search",
            logPath: writeLog("searchable diagnostic output"),
        });
        const sourceId = await indexJobOutputInSidecar(job, { cwd: tmpDir });
        const matches = await searchSidecarSources("diagnostic", {
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

        const noMatch = await searchSidecarSources("diagnostic", {
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

void describe("sidecar missing-data compatibility", () => {
    void it("read missing-table and missing-job paths safely", async () => {
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
        db.prepare("CREATE TABLE dummy (id TEXT)").run();
        db.close();
        assert.equal(await readJobOutputFromSidecar("job-any"), null);

        createDb(tmpDir);
        assert.equal(await readJobOutputFromSidecar("job-missing"), null);
    });

    void it("indexing safely ignores a DB without context_sources", async () => {
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
    });
});

// ─── Double-close regression tests ─────────────────────────────────
// These verify the fix for the "database is not open" error caused by
// explicit db.close() + finally { db.close() } on early-return paths.
