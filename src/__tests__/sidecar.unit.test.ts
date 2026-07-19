import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
    purgeSidecar,
    readJobOutputFromSidecar,
    indexJobOutputInSidecar,
} from "../features/background.ts";
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

CREATE INDEX IF NOT EXISTS idx_context_sources_created ON context_sources(created_at);
CREATE INDEX IF NOT EXISTS idx_context_chunks_source ON context_chunks(source_id, ordinal);
`;

let tmpDir: string;

/** Create a temp directory for an isolated context.db. */
function setupTempDir(): string {
    const dir = join(tmpdir(), `pi-tau-sidecar-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Create a fully-wired context.db at `dir` with schema applied. */
function createDb(dir: string): DatabaseSync {
    const dbPath = join(dir, "context.db");
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    for (const stmt of SIDECAR_SCHEMA.split(";").filter((s) => s.trim())) {
        db.prepare(stmt).run();
    }
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
            .prepare("SELECT id FROM context_sources WHERE tool_name = 'bash_bg'")
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
            .prepare("SELECT id FROM context_sources WHERE tool_name = 'bash_bg'")
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
            .prepare("SELECT COUNT(*) as cnt FROM context_sources WHERE tool_name = 'bash_bg'")
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
        ).run("other", "lsp", null, Date.now() - 30 * 24 * 60 * 60 * 1000, 50, 2, "hash_other");
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
            input_summary: JSON.stringify({ jobId: "job-output-1", logPath: "/tmp/test.log" }),
        });
        insertChunk(db, srcId, 1, "line one");
        insertChunk(db, srcId, 2, "line two");
        insertChunk(db, srcId, 3, "line three");
        db.close();

        const result = await readJobOutputFromSidecar("job-output-1");
        assert.ok(result !== null);
        assert.ok(result!.includes("Log: /tmp/test.log"));
        assert.ok(result!.includes("line one"));
        assert.ok(result!.includes("line two"));
        assert.ok(result!.includes("line three"));
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
        insertChunk(db, srcId, 2, "second");
        insertChunk(db, srcId, 1, "first");
        insertChunk(db, srcId, 3, "third");
        db.close();

        const result = await readJobOutputFromSidecar("job-ordered");
        assert.ok(result !== null);
        const withoutLog = result!.replace(/^Log: .*\n\n?/, "");
        assert.equal(withoutLog, "first\n\nsecond\n\nthird");
    });
});

// ─── indexJobOutputInSidecar tests ──────────────────────────────────

/** Minimal session manager for tests that need it. */
const noopSessionMgr = {};

void describe("indexJobOutputInSidecar", () => {
    function testJob(overrides: Partial<BackgroundJob> & { id: string }): BackgroundJob {
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

    void it("skips silently when context.db does not exist", async () => {
        const job = testJob({ id: "job-skip-1", logPath: writeLog("hello") });
        await indexJobOutputInSidecar(job, {});
        // No throw — pass
    });

    void it("skips silently when context_sources table does not exist", async () => {
        const db = new DatabaseSync(join(tmpDir, "context.db"), {});
        db.prepare("CREATE TABLE dummy (id TEXT)").run();
        db.close();

        const job = testJob({ id: "job-skip-2", logPath: writeLog("hello") });
        await indexJobOutputInSidecar(job, {});
        // No throw — pass
    });

    void it("skips empty log files", async () => {
        createDb(tmpDir);
        const job = testJob({ id: "job-empty", logPath: writeLog("") });
        await indexJobOutputInSidecar(job, {});

        // Verify nothing was inserted
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const count = check
            .prepare("SELECT COUNT(*) as cnt FROM context_sources WHERE tool_name = 'bash_bg'")
            .get() as { cnt: number };
        check.close();
        assert.equal(count.cnt, 0);
    });

    void it("indexes a job's output as source + chunks", async () => {
        createDb(tmpDir);
        const output = "hello world\nsecond line\nthird line";
        const job = testJob({ id: "job-index-1", logPath: writeLog(output) });
        await indexJobOutputInSidecar(job, { cwd: tmpDir });

        // Check source was inserted
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const sources = check
            .prepare(
                `SELECT id, byte_count, line_count, input_summary
                 FROM context_sources WHERE tool_name = 'bash_bg'`
            )
            .all() as { id: string; byte_count: number; line_count: number; input_summary: string }[];
        assert.equal(sources.length, 1);
        const summary = JSON.parse(sources[0].input_summary);
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

    void it("deduplicates identical content by updating returned_byte_count", async () => {
        createDb(tmpDir);
        const output = "some unique output";
        const job = testJob({ id: "job-dedup-1", logPath: writeLog(output) });

        // Index twice
        await indexJobOutputInSidecar(job, { cwd: tmpDir });
        await indexJobOutputInSidecar(job, { cwd: tmpDir });

        // Should only have one source
        const check = new DatabaseSync(join(tmpDir, "context.db"));
        const sources = check
            .prepare("SELECT id, returned_byte_count FROM context_sources WHERE tool_name = 'bash_bg'")
            .all() as { id: string; returned_byte_count: number }[];
        assert.equal(sources.length, 1);
        // returned_byte_count incremented on dedup hit
        assert.equal(sources[0].returned_byte_count, Buffer.byteLength(output, "utf8"));
        check.close();
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
            .get() as { session_id: string | null; project_path: string | null };
        assert.equal(row.session_id, "/sessions/test-session.jsonl");
        assert.equal(row.project_path, tmpDir);
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
