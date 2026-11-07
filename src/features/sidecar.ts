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
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
    JobOutputIndex,
    SidecarIndexOutcome,
    SidecarIndexStats,
} from "../types.ts";
import { countLines, type LogCounts } from "./log-classify.ts";

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
    appendEntry?: (customType: string, data: unknown) => void;
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

const warnedIndexFailures = new Set<string>();

let sidecarIndexStats: SidecarIndexStats = {
    attempts: 0,
    eligible: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    emptySkipped: 0,
    unavailableSkipped: 0,
    schemaSkipped: 0,
    staleSessionIdentity: 0,
};

/**
 * The captured ctx was replaced before indexing ran.
 *
 * A distinct type rather than a message match: the retry loop decides whether to
 * retry by pattern-matching SQLite busy errors, and a stale ctx is not
 * retryable, so the classification must not depend on wording. The message is
 * stable so `errorMessage` in the recorded outcome is readable, and deliberately
 * contains neither "busy" nor "locked" so the retry loop breaks immediately.
 */
class StaleSessionIdentityError extends Error {
    constructor() {
        super(
            "session ctx is stale after session replacement or reload; indexing skipped"
        );
        this.name = "StaleSessionIdentityError";
    }
}

/**
 * Read session identity from a possibly-stale extension ctx.
 *
 * Optional chaining is not enough here. `ctx?.sessionManager?.getSessionFile?.()`
 * guards a *missing* receiver; it does not guard a receiver method that
 * **throws**. pi-core makes a captured ctx stale after `newSession`, `fork`,
 * `switchSession` or `reload`, and from then on `getSessionFile()` and
 * `getSessionId()` throw by design.
 *
 * The distinction between `null` and `stale` is deliberate:
 *
 * - `null` identity means the caller supplied no session identity (fixtures,
 *   headless indexing). Indexing proceeds; the row is stored unattributed.
 * - `stale` means a real session existed and has been replaced. Indexing must
 *   not proceed under a borrowed identity, so the direct-DB path raises and the
 *   outcome is classified as `errorCategory: "stale"`.
 *
 * The stale case has to be *reportable* here rather than thrown at the point of
 * access, because the failure path also needs the identity: it derived its
 * dedupe key from the same accessor, so a throw there replaced the failure being
 * reported with an unhandled rejection (see `ctx-guard.unit.test.ts`, "indexing a
 * real log resolves without an unhandled rejection").
 */
function readSessionIdentity(ctx: SidecarContext | undefined): {
    value: string | null;
    stale: boolean;
} {
    try {
        return {
            value:
                ctx?.sessionManager?.getSessionFile?.() ??
                ctx?.sessionManager?.getSessionId?.() ??
                null,
            stale: false,
        };
    } catch {
        sidecarIndexStats.staleSessionIdentity += 1;
        return { value: null, stale: true };
    }
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
    /** Outcome of the optional sidecar indexing attempt. */
    indexOutcome?: SidecarIndexOutcome;
}

export function getSidecarIndexStats(): SidecarIndexStats {
    return { ...sidecarIndexStats };
}

/** Reset process-local counters; intended for tests and isolated diagnostics. */
export function resetSidecarIndexStats(): void {
    sidecarIndexStats = {
        attempts: 0,
        eligible: 0,
        indexed: 0,
        skipped: 0,
        failed: 0,
        emptySkipped: 0,
        unavailableSkipped: 0,
        schemaSkipped: 0,
        staleSessionIdentity: 0,
    };
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
export const SIDECAR_PURGE_DELAY_MS = 5_000;

export interface SidecarPurgeStats {
    sourcesConsidered: number;
    sourcesRemoved: number;
    chunksRemoved: number;
    slices: number;
    budgetExhausted: boolean;
    vacuumSteps: number;
    errors: number;
}

interface SidecarPurgeStatement {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number | bigint };
}

interface SidecarPurgeDatabase {
    prepare(sql: string): SidecarPurgeStatement;
    close(): void;
}

export interface SidecarPurgeOptions {
    dbPath?: string;
    openDatabase?: (path: string) => SidecarPurgeDatabase;
    now?: () => number;
    yieldToEventLoop?: () => Promise<void>;
    sliceBudgetMs?: number;
    totalBudgetMs?: number;
    batchSize?: number;
    vacuumPagesPerStep?: number;
    shouldContinue?: () => boolean;
}

const PURGE_SLICE_BUDGET_MS = 10;
const PURGE_TOTAL_BUDGET_MS = 2_000;
const PURGE_BATCH_SIZE = 25;
const PURGE_VACUUM_PAGES = 100;
export const SIDECAR_PURGE_IDLE_MS = 5_000;
let vacuumPending = false;

export function canRunSidecarPurge(
    turnProcessing: boolean,
    lastActivityAt: number,
    now = Date.now()
): boolean {
    return !turnProcessing && now - lastActivityAt >= SIDECAR_PURGE_IDLE_MS;
}

export function scheduleSidecarPurge(
    purge: () => unknown = () => purgeSidecar(),
    delayMs = SIDECAR_PURGE_DELAY_MS,
    shouldRun?: () => boolean,
    onStale?: () => void
): ReturnType<typeof setTimeout> | undefined {
    if (process.env.PI_TAU_MAINTENANCE_DISABLE === "1") return undefined;
    const timer = setTimeout(() => {
        if (shouldRun && !shouldRun()) {
            console.debug("[tau] sidecar purge skipped for stale startup");
            onStale?.();
            return;
        }
        void Promise.resolve(purge()).catch((error: unknown) => {
            console.error(
                `[tau] sidecar purge failed: ${error instanceof Error ? error.message : String(error)}`
            );
        });
    }, delayMs);
    timer.unref?.();
    return timer;
}

function emptySidecarPurgeStats(): SidecarPurgeStats {
    return {
        sourcesConsidered: 0,
        sourcesRemoved: 0,
        chunksRemoved: 0,
        slices: 0,
        budgetExhausted: false,
        vacuumSteps: 0,
        errors: 0,
    };
}

function logSidecarPurgeStats(stats: SidecarPurgeStats, ageDays: number): void {
    const line =
        `[tau] sidecar-purge age-days=${ageDays} sources-considered=${stats.sourcesConsidered} ` +
        `sources-removed=${stats.sourcesRemoved} chunks-removed=${stats.chunksRemoved} ` +
        `slices=${stats.slices} budget-exhausted=${stats.budgetExhausted} ` +
        `vacuum-steps=${stats.vacuumSteps} errors=${stats.errors}`;
    console.error(line);
    if (process.env.NODE_TEST_CONTEXT === undefined) {
        void appendFile(
            join(tmpdir(), "pi-tau-maintenance.log"),
            `${line}\n`
        ).catch(() => {});
    }
}

export async function purgeSidecar(
    ageDays: number = SIDECAR_PURGE_AGE_DAYS,
    options: SidecarPurgeOptions = {}
): Promise<SidecarPurgeStats> {
    const stats = emptySidecarPurgeStats();
    const dbPath = options.dbPath ?? sidecarDbPath();
    const now = options.now ?? (() => performance.now());
    const yieldToEventLoop =
        options.yieldToEventLoop ?? (() => yieldImmediate());
    const sliceBudgetMs = options.sliceBudgetMs ?? PURGE_SLICE_BUDGET_MS;
    const totalBudgetMs = options.totalBudgetMs ?? PURGE_TOTAL_BUDGET_MS;
    const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
    const vacuumPages = options.vacuumPagesPerStep ?? PURGE_VACUUM_PAGES;
    const started = now();
    let db: SidecarPurgeDatabase | undefined;
    let lastYieldAt = started;

    const yieldIfNeeded = async (force = false) => {
        if (force || now() - lastYieldAt >= sliceBudgetMs) {
            await yieldToEventLoop();
            stats.slices++;
            lastYieldAt = now();
        }
    };
    const overTotalBudget = () => now() - started >= totalBudgetMs;
    const shouldContinue = options.shouldContinue ?? (() => true);

    try {
        if (process.env.PI_TAU_MAINTENANCE_DISABLE === "1") return stats;
        if (!shouldContinue()) {
            stats.budgetExhausted = true;
            return stats;
        }
        if (!options.openDatabase && !existsSync(dbPath)) return stats;

        db = (
            options.openDatabase ??
            ((path) =>
                new DatabaseSync(path, {
                    enableForeignKeyConstraints: true,
                    // Fail/retry on a later idle pass instead of blocking the TUI on a writer lock.
                    timeout: 25,
                }))
        )(dbPath);
        const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
        const toolList = SIDECAR_TOOL_NAMES.map((t) => `'${t}'`).join(",");
        const toDelete = db
            .prepare(
                `SELECT id FROM context_sources
             WHERE tool_name IN (${toolList}) AND created_at < ?`
            )
            .all(cutoff) as { id: string }[];
        stats.sourcesConsidered = toDelete.length;

        // A truly empty pass is a no-op (including no vacuum). A previous
        // budget-limited vacuum is the one exception: finish that bounded work.
        if (toDelete.length === 0 && !vacuumPending) return stats;

        let cursor = 0;
        while (cursor < toDelete.length) {
            if (!shouldContinue()) {
                stats.budgetExhausted = true;
                break;
            }
            const batch = toDelete.slice(cursor, cursor + batchSize);
            const placeholders = batch.map(() => "?").join(",");
            const chunksResult = db
                .prepare(
                    `DELETE FROM context_chunks WHERE source_id IN (${placeholders})`
                )
                .run(...batch.map((row) => row.id));
            stats.chunksRemoved += Number(chunksResult.changes ?? 0);
            const sourcesResult = db
                .prepare(
                    `DELETE FROM context_sources WHERE id IN (${placeholders})`
                )
                .run(...batch.map((row) => row.id));
            stats.sourcesRemoved += Number(sourcesResult.changes ?? 0);
            cursor += batch.length;
            await yieldIfNeeded();
            if (
                !shouldContinue() ||
                (overTotalBudget() && cursor < toDelete.length)
            ) {
                stats.budgetExhausted = true;
                break;
            }
        }

        if (
            cursor >= toDelete.length &&
            (stats.sourcesRemoved > 0 || vacuumPending)
        ) {
            vacuumPending = true;
            if (!shouldContinue()) {
                stats.budgetExhausted = true;
                return stats;
            }
            const freePages = db.prepare("PRAGMA freelist_count").all()[0] as
                | { freelist_count?: number }
                | undefined;
            let remaining = Number(freePages?.freelist_count ?? 0);
            while (remaining > 0 && !overTotalBudget() && shouldContinue()) {
                db.prepare(`PRAGMA incremental_vacuum(${vacuumPages})`).run();
                stats.vacuumSteps++;
                // A vacuum step may reclaim less than requested; reread the bound.
                const current = db.prepare("PRAGMA freelist_count").all()[0] as
                    | { freelist_count?: number }
                    | undefined;
                const next = Number(current?.freelist_count ?? 0);
                if (next >= remaining) break;
                remaining = next;
                await yieldIfNeeded(true);
            }
            vacuumPending = remaining > 0;
            if (vacuumPending && (overTotalBudget() || !shouldContinue()))
                stats.budgetExhausted = true;
        }
    } catch (error) {
        stats.errors++;
        console.error(
            `[tau] sidecar purge failed: ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        try {
            db?.close();
        } catch {
            stats.errors++;
        }
        logSidecarPurgeStats(stats, ageDays);
    }
    return stats;
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
            timeout: 5_000,
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
            timeout: 5_000,
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
            timeout: 5_000,
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
    const severity = source.severityCounts
        ? `Severity: ${source.severityCounts.err} err, ${source.severityCounts.warn} warn of ${source.severityCounts.total} lines`
        : undefined;
    return [
        `[context-sidecar] Large ${toolName} output indexed locally`,
        `Source: ${source.sourceId}`,
        `Chunks: ${source.chunkIds.length}; original size: ${bytes} bytes, ${lines} lines`,
        severity,
        `- Search snippets first: context_search query:"..." source_id:"${source.sourceId}"`,
        `- Retrieve focused output: context_get source_id:"${source.sourceId}" chunk_id:"${source.chunkIds[0] ?? ""}"`,
        "- Export full output for offline processing: context_export source_id:" +
            `"${source.sourceId}"`,
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
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
        const identity = readSessionIdentity(ctx);
        if (identity.stale) {
            throw new StaleSessionIdentityError();
        }
        const sessionId = identity.value;
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
 * Optional test/caller controls for indexing behavior. Classification remains advisory.
 */
export interface SidecarIndexOptions {
    classify?: (text: string) => LogCounts;
    useExternalApi?: boolean;
    /** Override log reads for deterministic transient-I/O tests. */
    readLog?: (path: string) => Promise<string>;
    /**
     * Index this output even when it is under the ordinary inline threshold.
     *
     * This flag is where the retention invariant (see `prepareInlineOutput`)
     * becomes code, so treat it as load-bearing rather than as a threshold
     * override.
     *
     * Set only by pipe-nerf's two capture paths, and only because a limiter was
     * hoisted off the command: the `prepareInlineOutput` call sites driven by
     * `state.pipeHoistedCalls`, and `indexStageZeroCapture` in
     * `features/background.ts` for the pre-filter tee (same argument -- that file
     * is the only place stage 0's output exists). Those calls show the agent a
     * bounded view, so every line outside that view exists only in this capture.
     * Removing the flag -- or setting it conditionally on the output size --
     * silently reinstates the rule the invariant forbids ("the view is small, so
     * there is nothing worth keeping") and loses the only copy for exactly the
     * `pytest | tail -5` shape the nerf exists to protect.
     *
     * The chain that must stay intact for the invariant to hold:
     *   1. `pipe-nerf/index.ts` adds the toolCallId to `TauState.pipeHoistedCalls`
     *      when it rewrites a command (that set documents why the sidecar's own
     *      threshold is wrong for these calls).
     *   2. Every `prepareInlineOutput` call site in `features/background.ts`
     *      passes `{ force: state.pipeHoistedCalls.has(toolCallId) }` and then
     *      clears the entry, so the flag cannot leak onto a later call.
     *   3. The forced branches below index the full text even when it is small,
     *      and return that full text rather than a receipt so pipe-nerf can still
     *      rebuild the window the agent asked for.
     *
     * Links 1 and 3 are pinned by tests, so removing either fails a run rather
     * than only a comment: `pipe-nerf.unit.test.ts` "records a hoisted call so the
     * bash tool forces an index", and `sidecar.unit.test.ts` "indexes
     * sub-threshold output when forced". Link 2 is a mechanical pattern repeated
     * at every call site and is not covered by a test; grep for
     * `pipeHoistedCalls` when adding one. If a change here makes those tests look
     * over-strict, the invariant -- not the test -- is what is being argued with.
     */
    force?: boolean;
}

/**
 * Prepare foreground output for inline return, indexing it when required.
 *
 * A limiter decides what the agent SEES. It never decides whether the capture
 * SURVIVES. If the limiter discarded any captured line, that capture is
 * persisted and addressable regardless of how small the visible view is --
 * size and addressability decide WHERE it is stored, never WHETHER it exists.
 * The view being small is not evidence that the capture was small, and it must
 * never be read as "nothing to keep".
 *
 * 1. The old branch said "small enough to return inline, so nothing was written
 *    to disk or indexed". That described the VIEW and then drew a conclusion
 *    about the CAPTURE, so `pytest | tail -5` -- thousands of lines captured,
 *    five shown -- persisted nothing. Test and build output fits the inline
 *    budget, so the discarded case was the common one, not the corner: the
 *    single shape this code exists to prevent.
 * 2. Size cannot be the test even where the view is large. A caller cannot tell
 *    a 40-line capture from a 4000-line one by what it was shown, so any size
 *    rule becomes a rule the agent has to guess at, and guessing wrong loses
 *    the only copy.
 *
 * The invariant is enforced, not merely described: `SidecarIndexOptions.force`
 * documents the three links in the chain (pipe-nerf sets the flag, every bash
 * call site passes it, the forced branches below honour it). A change to any
 * link needs the others re-read. The note the agent reads is produced by
 * `pipe-nerf/messages.ts`, whose module comment states what it may and may not
 * claim about this function's result -- in particular that it may never report
 * a capture as lost on the strength of a small view.
 *
 * When indexing yields no source the capture's only remaining copy is the text
 * returned here. The caller then bounds it to the requested view, so the note
 * must not promise retrieval it cannot honour; `messages.ts` owns that branch.
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
    toolName = "bash",
    options: SidecarIndexOptions = {}
): Promise<PreparedInlineOutput> {
    const bytes = Buffer.byteLength(output, "utf8");
    const totalLines =
        output.length === 0
            ? 0
            : output.split("\n").length - (output.endsWith("\n") ? 1 : 0);
    const empty = output.trim().length === 0;
    if (!isLargeInlineOutput(output) && !options.force) {
        return {
            text: output || "(no output)",
            truncated: false,
            totalLines,
            byteCount: bytes,
            empty,
        };
    }
    // A forced index still needs the inline form bounded: the point is to record
    // the output, not to push all of it into the reply.
    if (!isLargeInlineOutput(output)) {
        const indexOutcome = await indexJobOutputWithOutcome(
            job,
            ctx,
            toolName,
            options
        );
        if (indexOutcome.source) {
            return {
                // Leave the content available to the pipe-nerf tool_result hook,
                // which applies the requested head/tail/count view after capture.
                // Replacing it with a receipt here loses that view entirely.
                text: output || "(no output)",
                truncated: false,
                totalLines,
                byteCount: bytes,
                empty,
                source: indexOutcome.source,
                indexOutcome,
            };
        }
        return {
            text: output || "(no output)",
            truncated: false,
            totalLines,
            byteCount: bytes,
            empty,
            indexOutcome,
        };
    }

    const lines = totalLines;
    const indexOutcome = await indexJobOutputWithOutcome(
        job,
        ctx,
        toolName,
        options
    );
    const source = indexOutcome.source;
    if (source) {
        if (options.force) {
            // pipe-nerf still needs the complete capture to reconstruct the exact
            // requested window; it bounds this text in its tool_result hook.
            return {
                text: output || "(no output)",
                truncated: false,
                totalLines: lines,
                byteCount: bytes,
                empty,
                source,
                indexOutcome,
            };
        }
        return {
            text: formatSidecarReceipt(toolName, source, bytes, lines),
            truncated: true,
            partial: true,
            totalLines: lines,
            byteCount: bytes,
            empty,
            source,
            indexOutcome,
        };
    }
    return {
        text: truncateInlineFallback(output),
        truncated: true,
        partial: true,
        totalLines: lines,
        byteCount: bytes,
        empty,
        indexOutcome,
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
function writeSeverityCountsBestEffort(
    db: DatabaseSync,
    sourceId: string,
    counts: LogCounts | undefined
): void {
    if (!counts) return;
    try {
        db.prepare(
            `INSERT INTO context_source_severity
             (source_id, err_line_count, warn_line_count, classified_line_count)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(source_id) DO UPDATE SET
               err_line_count = excluded.err_line_count,
               warn_line_count = excluded.warn_line_count,
               classified_line_count = excluded.classified_line_count`
        ).run(sourceId, counts.err, counts.warn, counts.total);
    } catch {
        // Severity is advisory metadata; older sidecar schemas must still index output.
    }
}

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
    dbPath: string,
    severityCounts?: LogCounts
): Promise<string | undefined> {
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const identity = readSessionIdentity(ctx);
    if (identity.stale) {
        throw new StaleSessionIdentityError();
    }
    const sessionId = identity.value;
    const projectPath = ctx?.cwd ?? process.cwd();

    const db = new DatabaseSync(dbPath, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
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
            writeSeverityCountsBestEffort(db, existing.id, severityCounts);
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
        writeSeverityCountsBestEffort(db, sourceId, severityCounts);
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

function getSqliteErrorCode(error: unknown): string | number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const sqliteError = error as { code?: unknown; errcode?: unknown };
    const code = sqliteError.code ?? sqliteError.errcode;
    return typeof code === "string" || typeof code === "number"
        ? code
        : undefined;
}

/**
 * Index a completed job's output and classify the result for diagnostics.
 *
 * Non-empty output is eligible for durable recovery. Empty output is an
 * intentional skip; an unavailable sidecar is also a skip, while read and
 * schema/I/O failures are failed outcomes. The primary job result remains
 * successful when this optional operation fails.
 */
export async function indexJobOutputWithOutcome(
    job: {
        id: string;
        command: string;
        logPath: string;
        exitCode?: number;
        status?: string;
    },
    ctx: SidecarContext,
    toolName: string = "bash_bg",
    options: SidecarIndexOptions = {}
): Promise<SidecarIndexOutcome> {
    sidecarIndexStats.attempts += 1;
    let text: string | undefined;
    let readError: unknown;
    let readRetryCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            text = await (
                options.readLog ?? ((path) => readFile(path, "utf-8"))
            )(job.logPath);
            readError = undefined;
            break;
        } catch (error) {
            readError = error;
            if (attempt === 0) {
                readRetryCount += 1;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
    }
    if (readError !== undefined || text === undefined) {
        const errorMessage =
            readError instanceof Error ? readError.message : String(readError);
        const errorCode = getSqliteErrorCode(readError);
        let expectedSizeBytes: number | null = null;
        try {
            expectedSizeBytes = (await stat(job.logPath)).size;
        } catch {
            // Unknown when the path is gone or metadata itself is inaccessible.
        }
        const outcome: SidecarIndexOutcome = {
            status: "failed",
            eligible: false,
            reason: "read_failed",
            errorCategory: "io",
            errorMessage,
            ...(errorCode !== undefined ? { errorCode } : {}),
            retryCount: readRetryCount,
        };
        sidecarIndexStats.failed += 1;
        try {
            ctx.appendEntry?.("sidecar-index-failure", {
                jobId: job.id,
                reason: "read_failed",
                category: "io",
                errno: errorCode,
                errorMessage,
                logPath: job.logPath,
                expectedSizeBytes,
                retryCount: readRetryCount,
            });
        } catch {
            // Diagnostic persistence must not replace the completed job result.
        }
        return outcome;
    }

    if (!text.trim()) {
        const outcome: SidecarIndexOutcome = {
            status: "skipped",
            eligible: false,
            reason: "empty_output",
        };
        sidecarIndexStats.skipped += 1;
        sidecarIndexStats.emptySkipped += 1;
        return outcome;
    }

    sidecarIndexStats.eligible += 1;
    let severityCounts: LogCounts | undefined;
    try {
        severityCounts = (options.classify ?? countLines)(text);
    } catch {
        // Classification is advisory; keep the existing indexing path intact.
    }
    const dbPath = sidecarDbPath();
    if (!existsSync(dbPath)) {
        const outcome: SidecarIndexOutcome = {
            status: "skipped",
            eligible: true,
            reason: "sidecar_unavailable",
            errorCategory: "unavailable",
        };
        sidecarIndexStats.skipped += 1;
        sidecarIndexStats.unavailableSkipped += 1;
        return outcome;
    }

    const startedAt = Date.now();
    let retryCount = 0;
    let sourceId: string | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
        try {
            // Try pi-context's public external-indexing API first.
            const apiSourceId =
                options.useExternalApi === false
                    ? undefined
                    : await tryIndexViaExternalApi(
                          text,
                          job,
                          ctx,
                          toolName,
                          dbPath
                      );
            sourceId =
                apiSourceId ??
                (await indexViaDirectDb(
                    text,
                    job,
                    ctx,
                    toolName,
                    dbPath,
                    severityCounts
                ));
            lastError = undefined;
            break;
        } catch (error) {
            lastError = error;
            const message =
                error instanceof Error ? error.message : String(error);
            const code = getSqliteErrorCode(error);
            const busy =
                code === "SQLITE_BUSY" ||
                /busy|database is locked/i.test(message);
            if (!busy || attempt === 3) break;
            retryCount += 1;
            // Short bounded exponential delay in addition to SQLite's busy_timeout.
            await new Promise((resolve) =>
                setTimeout(resolve, 50 * 2 ** attempt)
            );
        }
    }
    const waitMs = Date.now() - startedAt;
    if (!lastError && !sourceId) {
        const outcome: SidecarIndexOutcome = {
            status: "skipped",
            eligible: true,
            reason: "schema_unavailable",
            errorCategory: "schema",
            retryCount: retryCount + readRetryCount,
            waitMs,
        };
        sidecarIndexStats.skipped += 1;
        sidecarIndexStats.schemaSkipped += 1;
        return outcome;
    }
    if (!lastError && sourceId) {
        const indexedSource = findJobSourceDetailsInSidecar(job.id) ?? {
            sourceId,
            chunkIds: [],
        };
        const source: JobOutputIndex = {
            ...indexedSource,
            ...(severityCounts ? { severityCounts } : {}),
        };
        const outcome: SidecarIndexOutcome = {
            status: "indexed",
            eligible: true,
            source,
            retryCount: retryCount + readRetryCount,
            waitMs,
        };
        sidecarIndexStats.indexed += 1;
        if (retryCount > 0 || waitMs >= 100) {
            try {
                ctx.appendEntry?.("sidecar-index-wait", {
                    jobId: job.id,
                    retryCount,
                    waitMs,
                });
            } catch {
                // Lock-wait instrumentation must not turn a successful index into a failure.
            }
        }
        return outcome;
    }

    const errorMessage =
        lastError instanceof Error ? lastError.message : String(lastError);
    const errorCode = getSqliteErrorCode(lastError);
    const normalizedMessage = errorMessage.toLowerCase();
    const errorCategory: SidecarIndexOutcome["errorCategory"] =
        lastError instanceof StaleSessionIdentityError
            ? "stale"
            : /no such table|no such column|malformed schema|fts5|constraint failed/.test(
                    normalizedMessage
                )
              ? "schema"
              : /busy|locked|read-only|disk|i\/o|eacces|enotdir/.test(
                      normalizedMessage
                  )
                ? "io"
                : "unknown";
    const outcome: SidecarIndexOutcome = {
        status: "failed",
        eligible: true,
        reason: "index_failed",
        errorCategory,
        errorMessage,
        ...(errorCode !== undefined ? { errorCode } : {}),
        retryCount,
        waitMs,
    };
    sidecarIndexStats.failed += 1;
    try {
        ctx.appendEntry?.("sidecar-index-failure", {
            jobId: job.id,
            category: errorCategory,
            errorMessage,
            errorCode,
            retryCount,
            waitMs,
        });
    } catch {
        // Diagnostic persistence must not affect the completed job.
    }
    // A stale ctx must not turn a reported failure into an unhandled rejection.
    const sessionKey = readSessionIdentity(ctx).value ?? "unknown-session";
    const warningKey = `${sessionKey}:${errorCategory}`;
    if (!warnedIndexFailures.has(warningKey)) {
        warnedIndexFailures.add(warningKey);
        console.error(
            `[tau] sidecar index failed (${errorCategory}): ${errorMessage}; ` +
                `retries=${retryCount}, wait=${waitMs}ms`
        );
    }
    return outcome;
}

/** Backward-compatible source-only indexing API. */
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
    return (await indexJobOutputWithOutcome(job, ctx, toolName)).source
        ?.sourceId;
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
        sidecarIndexStatus?: SidecarIndexOutcome["status"];
        sidecarIndexReason?: SidecarIndexOutcome["reason"];
        sidecarIndexErrorCategory?: SidecarIndexOutcome["errorCategory"];
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
        indexJobOutputWithOutcome(job, ctx, toolName).then((outcome) => {
            job.sidecarIndexStatus = outcome.status;
            job.sidecarIndexReason = outcome.reason;
            job.sidecarIndexErrorCategory = outcome.errorCategory;
            if (!outcome.source) return undefined;
            job.sourceId = outcome.source.sourceId;
            job.chunkIds = outcome.source.chunkIds;
            return outcome.source;
        })
    );
    job.outputIndexPromise = promise;
    return promise;
}
