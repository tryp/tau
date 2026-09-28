import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
    chunkText,
    formatSidecarReceipt,
    INLINE_FALLBACK_MAX_CHARS,
    prepareInlineOutput,
} from "../features/sidecar.ts";
import type { BackgroundJob } from "../types.ts";

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
    void it("succeeds silently when context.db does not exist", () => {
        // PI_CODING_AGENT_DIR points to an empty dir; no context.db present
        purgeSidecar(1);
        // No throw — pass
    });

    void it("succeeds silently when context.db exists but has no bash_bg entries", () => {
        createDb(tmpDir); // creates empty DB with schema
        purgeSidecar(1);
        // No "database is not open" — this was the bug
    });

    void it("does not throw when there are no stale entries (all entries are young)", () => {
        const db = createDb(tmpDir);
        insertSource(db, { created_at: Date.now() });
        db.close();

        purgeSidecar(1); // purge entries older than 1 day
        // No throw — pass
    });

    void it("removes stale bash_bg entries older than the cutoff", () => {
        const db = createDb(tmpDir);
        const oldId = insertSource(db, {
            created_at: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        });
        insertChunk(db, oldId, 1, "stale output");
        db.close();

        purgeSidecar(1); // purge entries older than 1 day

        // Verify source was deleted
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const remaining = check
            .prepare(
                "SELECT id FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .all() as { id: string }[];
        check.close();
        assert.equal(remaining.length, 0);
    });

    void it("removes only stale entries, keeping fresh ones", () => {
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

        purgeSidecar(1);

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

    void it("handles chunked deletion of >100 stale entries", () => {
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

        purgeSidecar(1);

        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const remaining = check
            .prepare(
                "SELECT COUNT(*) as cnt FROM context_sources WHERE tool_name = 'bash_bg'"
            )
            .get() as { cnt: number };
        check.close();
        assert.equal(remaining.cnt, 0);
    });

    void it("skips non-bash_bg tool entries (only purges its own)", () => {
        const db = createDb(tmpDir);
        // Insert a non-bash_bg entry
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

        purgeSidecar(1);

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
            emptySkipped: 0,
            unavailableSkipped: 1,
            schemaSkipped: 0,
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
            emptySkipped: 0,
            unavailableSkipped: 0,
            schemaSkipped: 0,
        });
    });

    void it("classifies unreadable output as a non-eligible failure", async () => {
        const job = testJob({
            id: "job-read-failed",
            logPath: join(tmpDir, "missing-output.log"),
        });
        const outcome = await indexJobOutputWithOutcome(job, {});
        assert.deepEqual(outcome, {
            status: "failed",
            eligible: false,
            reason: "read_failed",
            errorCategory: "io",
        });
        assert.deepEqual(getSidecarIndexStats(), {
            attempts: 1,
            eligible: 0,
            indexed: 0,
            skipped: 0,
            failed: 1,
            emptySkipped: 0,
            unavailableSkipped: 0,
            schemaSkipped: 0,
        });
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
    void it("purgeSidecar: empty DB does not throw 'database is not open'", () => {
        createDb(tmpDir);
        // This was the original bug: when there's nothing to purge, the
        // early-return path called db.close() then finally called it again.
        purgeSidecar(1);
        // If we reach here without uncaught error, the fix works.
    });

    void it("purgeSidecar: all-fresh entries does not throw", () => {
        const db = createDb(tmpDir);
        insertSource(db, { created_at: Date.now() });
        db.close();

        purgeSidecar(1);
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
