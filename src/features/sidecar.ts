/**
 * Context sidecar integration — shared by bash_bg, agent_bg, and tmux
 * background paths.
 *
 * Writes job output directly to the pi-context sidecar's context.db using
 * the same schema, so context_search / context_get / context_list can find
 * completed job output. Skips silently if the DB or sidecar tables don't
 * exist (sidecar not loaded).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { JobOutputIndex } from "../types.ts";

/** Inline output limits mirror the context sidecar's baseline capture policy. */
export const INLINE_CONTEXT_MAX_BYTES = 24 * 1024;
export const INLINE_CONTEXT_MAX_LINES = 300;
export const INLINE_FALLBACK_MAX_CHARS = 12_000;

/** Default age (days) for purging sidecar entries at startup. */
const SIDECAR_PURGE_AGE_DAYS = 10;

/** Tool names this module owns for retention/purge. */
const SIDECAR_TOOL_NAMES = ["bash_bg", "agent_bg"] as const;
/** Tool names searchable through this adapter, including foreground bash. */
const SIDECAR_SEARCH_TOOL_NAMES = ["bash", ...SIDECAR_TOOL_NAMES] as const;

/** Context for the indexing call — cwd + session identity. */
export interface SidecarContext {
    cwd?: string;
    sessionManager?: {
        // pi-core's ExtensionContext returns string | undefined; indexers
        // normalize via ?? null, so accept both.
        getSessionFile?: () => string | null | undefined;
        getSessionId?: () => string | null | undefined;
    };
}

/** Output plus stable sidecar identifiers for a background job. */
export interface SidecarJobOutput extends JobOutputIndex {
    text: string;
    /** Original log path, kept separate from output text and line metadata. */
    logPath?: string;
}

/** Search result for indexed agent/job/run/review output. */
export interface SidecarSourceMatch extends JobOutputIndex {
    toolName: string;
    createdAt: number;
    inputSummary: string;
}

export interface PreparedInlineOutput {
    text: string;
    /** Original output was reduced before being returned inline. */
    truncated: boolean;
    /** This response is a view of the output rather than the complete output. */
    partial?: boolean;
    /** Number of lines in the original output, when known. */
    totalLines?: number;
    /** Original output size in UTF-8 bytes, when known. */
    byteCount?: number;
    /** Whether the original output contained no meaningful content. */
    empty?: boolean;
    source?: JobOutputIndex;
}

/**
 * Build the path to the context sidecar's SQLite database.
 */
export function sidecarDbPath(): string {
    const agentDir =
        process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return join(agentDir, "context.db");
}

/**
 * Purge sidecar entries older than `ageDays` days. Runs at startup to
 * prevent unbounded growth. Scoped to entries this module owns
 * (bash_bg, agent_bg).
 */
export function purgeSidecar(ageDays: number = SIDECAR_PURGE_AGE_DAYS): void {
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) return;

    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;

    try {
        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });
        try {
            // Select IDs to delete so we can log the count
            const toolList = SIDECAR_TOOL_NAMES.map((t) => `'${t}'`).join(",");
            const toDelete = db
                .prepare(
                    `SELECT id FROM context_sources
                     WHERE tool_name IN (${toolList})
                       AND created_at < ?`
                )
                .all(cutoff) as { id: string }[];

            if (toDelete.length === 0) {
                return;
            }

            // Delete chunks first (FTS triggers fire properly), then sources.
            // Use chunked batches to keep the WAL manageable.
            const ids = toDelete.map((r) => r.id);
            const batchSize = 100;
            for (let i = 0; i < ids.length; i += batchSize) {
                const batch = ids.slice(i, i + batchSize);
                const placeholders = batch.map(() => "?").join(",");

                db.prepare(
                    `DELETE FROM context_chunks WHERE source_id IN (${placeholders})`
                ).run(...batch);

                db.prepare(
                    `DELETE FROM context_sources WHERE id IN (${placeholders})`
                ).run(...batch);
            }

            // VACUUM to reclaim free pages (fast at startup — no concurrent
            // readers). For DBs with thousands of old entries this may take
            // ~100-500ms; acceptable at startup where overall init time is
            // dominated by model loading, not DB maintenance.
            db.prepare("VACUUM").run();

            // Minimal logging — visible in pi startup output
            console.error(
                `[tau] purged ${toDelete.length} sidecar entries older than ${ageDays} days, ` +
                    `VACUUM reclaimed freed space`
            );
        } finally {
            db.close();
        }
    } catch (err) {
        console.error(
            `[tau] sidecar purge failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

function sidecarToolListSql(): string {
    return SIDECAR_SEARCH_TOOL_NAMES.map((tool) => `'${tool}'`).join(",");
}

function findJobSourceRow(
    db: DatabaseSync,
    jobId: string
): { id: string; input_summary: string } | undefined {
    return db
        .prepare(
            `SELECT id, input_summary FROM context_sources
             WHERE tool_name IN (${sidecarToolListSql()})
               AND json_valid(input_summary)
               AND json_extract(input_summary, '$.jobId') = ?
             ORDER BY created_at DESC LIMIT 1`
        )
        .get(jobId) as { id: string; input_summary: string } | undefined;
}

function chunkIdsForSource(db: DatabaseSync, sourceId: string): string[] {
    return (
        db
            .prepare(
                `SELECT id FROM context_chunks
                 WHERE source_id = ? ORDER BY ordinal ASC`
            )
            .all(sourceId) as { id: string }[]
    ).map((chunk) => chunk.id);
}

/**
 * Find indexed output and stable source/chunk IDs for a completed job.
 * Returns null when the sidecar is unavailable or no matching source exists.
 */
export function findJobSourceDetailsInSidecar(
    jobId: string
): JobOutputIndex | null {
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) return null;

    try {
        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });
        try {
            const tableCheck = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='context_sources'"
                )
                .get();
            if (!tableCheck) return null;

            const source = findJobSourceRow(db, jobId);
            if (!source) return null;
            return {
                sourceId: source.id,
                chunkIds: chunkIdsForSource(db, source.id),
            };
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

/**
 * Search indexed output by tool family and free-text query. This is a small
 * synchronous helper for callers that need source/chunk IDs without invoking
 * the full context-search tool.
 */
export function searchSidecarSources(
    query: string,
    options: { toolNames?: readonly string[]; limit?: number } = {}
): SidecarSourceMatch[] {
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) return [];

    const toolNames = options.toolNames?.length
        ? options.toolNames
        : SIDECAR_SEARCH_TOOL_NAMES;
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    try {
        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });
        try {
            const tableCheck = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='context_sources'"
                )
                .get();
            if (!tableCheck) return [];

            const placeholders = toolNames.map(() => "?").join(",");
            const pattern = `%${query}%`;
            const rows = db
                .prepare(
                    `SELECT id, tool_name, created_at, input_summary
                     FROM context_sources
                     WHERE tool_name IN (${placeholders})
                       AND (
                         ? = '' OR input_summary LIKE ? OR id IN (
                           SELECT source_id FROM context_chunks WHERE content LIKE ?
                         )
                       )
                     ORDER BY created_at DESC LIMIT ?`
                )
                .all(...toolNames, query, pattern, pattern, limit) as {
                id: string;
                tool_name: string;
                created_at: number;
                input_summary: string;
            }[];
            return rows.map((row) => ({
                sourceId: row.id,
                chunkIds: chunkIdsForSource(db, row.id),
                toolName: row.tool_name,
                createdAt: row.created_at,
                inputSummary: row.input_summary,
            }));
        } finally {
            db.close();
        }
    } catch {
        return [];
    }
}

/** Backward-compatible source-only lookup. */
export function findJobSourceIdInSidecar(jobId: string): string | null {
    return findJobSourceDetailsInSidecar(jobId)?.sourceId ?? null;
}

/**
 * Look up a completed job's output and stable IDs from the context sidecar.
 */
export async function readJobOutputDetailsFromSidecar(
    jobId: string
): Promise<SidecarJobOutput | null> {
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) return null;

    try {
        const db = new DatabaseSync(dbPath, {
            enableForeignKeyConstraints: true,
        });
        try {
            const tableCheck = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='context_sources'"
                )
                .get();
            if (!tableCheck) return null;

            const source = findJobSourceRow(db, jobId);
            if (!source) return null;

            let logPath: string | undefined;
            try {
                const summary = JSON.parse(source.input_summary) as {
                    logPath?: string;
                };
                logPath = summary.logPath;
            } catch {
                // Old records may lack logPath; keep it undefined.
            }

            const chunks = db
                .prepare(
                    `SELECT id, content FROM context_chunks
                     WHERE source_id = ? ORDER BY ordinal ASC`
                )
                .all(source.id) as { id: string; content: string }[];
            if (chunks.length === 0) return null;

            return {
                sourceId: source.id,
                chunkIds: chunks.map((chunk) => chunk.id),
                // chunkText() is lossless, so do not inject separators while
                // reconstructing the original output.
                text: chunks.map((chunk) => chunk.content).join(""),
                logPath,
            };
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

/** Backward-compatible text-only sidecar lookup. */
export async function readJobOutputFromSidecar(
    jobId: string
): Promise<string | null> {
    return (await readJobOutputDetailsFromSidecar(jobId))?.text ?? null;
}

function isLargeInlineOutput(text: string): boolean {
    return (
        Buffer.byteLength(text, "utf8") > INLINE_CONTEXT_MAX_BYTES ||
        text.split("\n").length > INLINE_CONTEXT_MAX_LINES
    );
}

function truncateInlineFallback(text: string): string {
    if (text.length <= INLINE_FALLBACK_MAX_CHARS) return text;
    return (
        `...[truncated, showing last ${INLINE_FALLBACK_MAX_CHARS} chars; ` +
        "full output was not available in the context sidecar]\n" +
        text.slice(-INLINE_FALLBACK_MAX_CHARS)
    );
}

export function formatSidecarReceipt(
    toolName: string,
    source: JobOutputIndex,
    bytes: number,
    lines: number
): string {
    return [
        `[context-sidecar] Large ${toolName} output indexed locally`,
        `Source: ${source.sourceId}`,
        `Chunks: ${source.chunkIds.length}; original size: ${bytes} bytes, ${lines} lines`,
        `- Search snippets first: context_search query:"..." source_id:"${source.sourceId}"`,
        `- Retrieve focused output: context_get source_id:"${source.sourceId}" chunk_id:"${source.chunkIds[0] ?? ""}"`,
        "- Export full output for offline processing: context_export source_id:" +
            `"${source.sourceId}"`,
    ].join("\n");
}

/**
 * Try to index output via pi-context's public ContextStore.index_external_output
 * API when the @spences10/pi-context package is available at runtime. Returns
 * undefined so the caller can use the direct SQLite fallback when the
 * package/API is unavailable or errors.
 *
 * The API path preserves tool_name, job metadata, session/project scope,
 * redaction, threshold/max-source behavior, and returns enough source/chunk
 * details for receipts via the same context.db.
 */
interface ContextStoreLike {
    index_external_output: (input: object) => { source_id?: string } | null;
}
interface ContextStoreModule {
    get_context_store?: (options?: object) => ContextStoreLike;
}

async function tryIndexViaExternalApi(
    text: string,
    job: {
        id: string;
        command: string;
        logPath: string;
        exitCode?: number;
        status?: string;
    },
    ctx: SidecarContext,
    toolName: string,
    dbPath: string
): Promise<string | undefined> {
    // Dynamic import — may fail at runtime when the package is not in the
    // module resolution graph (e.g. pi-context not loaded as an extension).
    let storeModule: ContextStoreModule | undefined;

    // Strategy 1: try importing via package name (works when pi's runtime
    // resolver includes pi-context in the module graph). Build the specifier
    // dynamically to avoid a static TypeScript error for the undeclared dep.
    try {
        const parts = ["@spences10", "pi-context", "store"];
        storeModule = (await import(parts.join("/"))) as ContextStoreModule;
    } catch {
        // Fallback: scan known pi installation paths for the package.
        const home = homedir();
        const candidates = [
            join(
                home,
                ".pi",
                "agent",
                "npm",
                "node_modules",
                "@spences10",
                "pi-context",
                "dist",
                "store.js"
            ),
            join(
                home,
                ".pi",
                "agent",
                "local",
                "pi-context",
                "dist",
                "store.js"
            ),
        ];
        for (const storePath of candidates) {
            try {
                if (existsSync(storePath)) {
                    storeModule = (await import(
                        storePath
                    )) as ContextStoreModule;
                    break;
                }
            } catch {
                /* continue */
            }
        }
    }
    if (!storeModule) return undefined;

    const getContextStore = storeModule.get_context_store;
    if (typeof getContextStore !== "function") return undefined;

    try {
        const sessionId =
            ctx?.sessionManager?.getSessionFile?.() ??
            ctx?.sessionManager?.getSessionId?.() ??
            null;
        const projectPath = ctx?.cwd ?? process.cwd();

        const store = getContextStore({
            db_path: dbPath,
            project_path: projectPath,
            session_id: sessionId,
        });

        if (typeof store.index_external_output !== "function") return undefined;

        const inputSummary = JSON.stringify({
            command: job.command,
            jobId: job.id,
            exitCode: job.exitCode,
            status: job.status,
            logPath: job.logPath,
        });

        const result = store.index_external_output({
            text,
            tool_name: toolName,
            input_summary: inputSummary,
            session_id: sessionId,
            project_path: projectPath,
            force: true,
        }) as { source_id?: string } | null | undefined;

        if (result?.source_id) {
            return result.source_id;
        }
    } catch {
        // API error — fall through to direct DB
    }

    return undefined;
}

/**
 * Index large foreground output before it is returned to the model.
 * The complete output remains in the log/sidecar; only a compact receipt or
 * bounded fallback is returned inline.
 */
export async function prepareInlineOutput(
    job: {
        id: string;
        command: string;
        logPath: string;
        exitCode?: number;
        status?: string;
    },
    ctx: SidecarContext,
    output: string,
    toolName = "bash"
): Promise<PreparedInlineOutput> {
    const bytes = Buffer.byteLength(output, "utf8");
    const totalLines = output.length === 0
        ? 0
        : output.split("\n").length - (output.endsWith("\n") ? 1 : 0);
    const empty = output.trim().length === 0;
    if (!isLargeInlineOutput(output)) {
        return {
            text: output || "(no output)",
            truncated: false,
            totalLines,
            byteCount: bytes,
            empty,
        };
    }

    const lines = totalLines;
    const sourceId = await indexJobOutputInSidecar(job, ctx, toolName);
    const source = sourceId
        ? (findJobSourceDetailsInSidecar(job.id) ?? { sourceId, chunkIds: [] })
        : undefined;
    if (source) {
        return {
            text: formatSidecarReceipt(toolName, source, bytes, lines),
            truncated: true,
            partial: true,
            totalLines: lines,
            byteCount: bytes,
            empty,
            source,
        };
    }

    return {
        text: truncateInlineFallback(output),
        truncated: true,
        partial: true,
        totalLines: lines,
        byteCount: bytes,
        empty,
    };
}

/**
 * Split text into ~4 KiB chunks, matching the sidecar's chunk_text().
 */
export function chunkText(
    text: string,
    sourceId: string
): {
    id: string;
    sourceId: string;
    ordinal: number;
    title: string;
    content: string;
    byteCount: number;
}[] {
    // Keep the chunker deliberately lossless. Splitting by paragraphs and
    // lines is attractive, but a line larger than the target size can leave
    // an earlier chunk behind while silently dropping that line. Iterating by
    // Unicode code point preserves the complete text and never splits a UTF-8
    // sequence in the middle.
    const targetBytes = 4096;
    const chunks: string[] = [];
    let current: string[] = [];
    let currentBytes = 0;
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (current.length > 0 && currentBytes + characterBytes > targetBytes) {
            chunks.push(current.join(""));
            current = [character];
            currentBytes = characterBytes;
        } else {
            current.push(character);
            currentBytes += characterBytes;
        }
    }
    if (current.length > 0) chunks.push(current.join(""));
    if (chunks.length === 0) chunks.push(text);

    return chunks.map((content, index) => ({
        id: `${sourceId}_${String(index + 1).padStart(4, "0")}`,
        sourceId,
        ordinal: index + 1,
        title:
            content
                .split("\n")
                .find((l) => l.trim())
                ?.trim()
                .slice(0, 120) ?? "(empty)",
        content,
        byteCount: Buffer.byteLength(content, "utf8"),
    }));
}

/**
 * Build a short preview from the first content lines.
 */
function makePreview(text: string): string {
    const lines = text.split("\n");
    const previewLines = lines.slice(0, 40);
    let result = previewLines.join("\n");
    if (Buffer.byteLength(result, "utf8") > 4096) {
        result = Buffer.from(result, "utf8").subarray(0, 4096).toString("utf8");
    }
    if (lines.length > 40) result += "\n...";
    return result;
}

/**
 * Direct SQLite indexing fallback — writes job output into the sidecar's
 * context.db using the same schema that context_search / context_get /
 * context_list expect. Used when the pi-context external API is unavailable.
 */
async function indexViaDirectDb(
    text: string,
    job: {
        id: string;
        command: string;
        logPath: string;
        exitCode?: number;
        status?: string;
    },
    ctx: SidecarContext,
    toolName: string,
    dbPath: string
): Promise<string | undefined> {
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const sessionId =
        ctx?.sessionManager?.getSessionFile?.() ??
        ctx?.sessionManager?.getSessionId?.() ??
        null;
    const projectPath = ctx?.cwd ?? process.cwd();

    const db = new DatabaseSync(dbPath, {
        enableForeignKeyConstraints: true,
    });

    try {
        // Check if the source table exists (sidecar schema applied)
        const tableCheck = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='context_sources'"
            )
            .get();
        if (!tableCheck) {
            return;
        }

        const contentHash = createHash("sha256").update(text).digest("hex");
        // Deduplicate repeated indexing of the same job, but never merge
        // two different jobs. A source row carries one jobId, so sharing
        // it across jobs would make the second job impossible to find.
        const existing = db
            .prepare(
                `SELECT id FROM context_sources
                 WHERE tool_name = ? AND content_hash = ?
                   AND (project_path = ? OR project_path IS NULL)
                   AND json_valid(input_summary)
                   AND json_extract(input_summary, '$.jobId') = ?
                 LIMIT 1`
            )
            .get(toolName, contentHash, projectPath, job.id) as
            | { id: string }
            | undefined;
        if (existing) {
            // Re-indexing is internal maintenance, not a context read. Do
            // not charge these bytes to returned_byte_count; that counter
            // tracks bytes actually returned by context retrieval.
            return existing.id;
        }

        // Keep the source and all chunks atomic. A schema mismatch or FTS
        // trigger failure must not leave an orphan source that prevents a
        // later retry from indexing the job.
        db.exec("BEGIN");

        // Generate a unique source ID matching the sidecar's format
        const sourceId = `ctx_bg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        const createdAt = Date.now();
        const preview = makePreview(text);
        const previewBytes = Buffer.byteLength(preview, "utf8");
        const inputSummary = JSON.stringify({
            command: job.command,
            jobId: job.id,
            exitCode: job.exitCode,
            status: job.status,
            logPath: job.logPath,
        });

        // Insert source record
        db.prepare(
            `INSERT INTO context_sources
             (id, session_id, project_path, tool_name, input_summary,
              created_at, byte_count, line_count, content_hash,
              preview_byte_count, returned_byte_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        ).run(
            sourceId,
            sessionId,
            projectPath,
            toolName,
            inputSummary,
            createdAt,
            bytes,
            lines,
            contentHash,
            previewBytes
        );

        // Insert chunks (FTS5 trigger auto-populates context_chunks_fts)
        const chunks = chunkText(text, sourceId);
        const insertChunk = db.prepare(
            `INSERT INTO context_chunks
             (id, source_id, ordinal, title, content, byte_count)
             VALUES (?, ?, ?, ?, ?, ?)`
        );

        for (const chunk of chunks) {
            insertChunk.run(
                chunk.id,
                chunk.sourceId,
                chunk.ordinal,
                chunk.title,
                chunk.content,
                chunk.byteCount
            );
        }
        db.exec("COMMIT");
        return sourceId;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Preserve the original schema or I/O error.
        }
        throw error;
    } finally {
        db.close();
    }
}

/**
 * Index a completed job's output into the context sidecar SQLite database.
 *
 * Prefers pi-context's public ContextStore.index_external_output API when the
 * @spences10/pi-context package is available at runtime. Falls back to a direct
 * SQLite write using the same schema that context_search / context_get / context_list
 * expect. Skips silently if the DB or the sidecar tables don't exist.
 *
 * Each non-empty job gets its own source row so the jobId-to-source mapping
 * remains stable even when multiple jobs produce identical output.
 */
export async function indexJobOutputInSidecar(
    job: {
        id: string;
        command: string;
        logPath: string;
        exitCode?: number;
        status?: string;
    },
    ctx: SidecarContext,
    toolName: string = "bash_bg"
): Promise<string | undefined> {
    try {
        const text = await readFile(job.logPath, "utf-8").catch(() => "");
        if (!text) return;

        const dbPath = sidecarDbPath();
        if (!existsSync(dbPath)) {
            return;
        }

        // Try pi-context's public external-indexing API first.
        const apiSourceId = await tryIndexViaExternalApi(
            text,
            job,
            ctx,
            toolName,
            dbPath
        );
        if (apiSourceId) return apiSourceId;

        // Fallback: direct SQLite write.
        return await indexViaDirectDb(text, job, ctx, toolName, dbPath);
    } catch {
        // DB unavailable or schema mismatch — skip silently
    }
}

/**
 * Start terminal-output indexing and retain its result on the job. Consumers
 * can await the returned promise before exposing completion metadata.
 */
export function trackJobOutputIndex(
    job: {
        sourceId?: string;
        chunkIds?: string[];
        outputIndexPromise?: Promise<JobOutputIndex | undefined>;
    } & {
        id: string;
        command: string;
        logPath: string;
        exitCode?: number;
        status?: string;
    },
    ctx: SidecarContext,
    toolName: string = "bash_bg",
    outputReady?: Promise<unknown>
): Promise<JobOutputIndex | undefined> {
    // Completion paths can receive both error and close events. Reuse the
    // first promise so one job cannot create multiple sidecar source rows.
    if (job.outputIndexPromise) return job.outputIndexPromise;

    const promise = (outputReady ?? Promise.resolve()).then(() =>
        indexJobOutputInSidecar(job, ctx, toolName).then((sourceId) => {
            if (!sourceId) return undefined;
            const details = findJobSourceDetailsInSidecar(job.id) ?? {
                sourceId,
                chunkIds: [],
            };
            job.sourceId = details.sourceId;
            job.chunkIds = details.chunkIds;
            return details;
        })
    );
    job.outputIndexPromise = promise;
    return promise;
}
