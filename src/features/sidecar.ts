/**
 * Context sidecar integration — shared by bash_bg, agent_bg, and tmux
 * background paths.
 *
 * Uses pi-context's owner client for indexing and retrieval. Tau never opens
 * or inspects the owner database; when the owner is absent, indexing is skipped
 * and the unavailable counter is persisted with the session entry.
 */

import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
    ContextExternalSource,
    ContextPurgeDetails,
    ContextSidecarClient,
    SidecarOwnerResult,
    StoreContextInput,
} from "@spences10/pi-context";
import type {
    JobOutputIndex,
    SidecarIndexOutcome,
    SidecarIndexStats,
} from "../types.ts";
import { countLines, type LogCounts } from "./log-classify.ts";
import { isStaleCtxError } from "./ctx-guard.ts";
import {
    classifyIndexError,
    retryIndexOperation,
} from "./sidecar-index-errors.ts";

/** Inline output limits mirror the context sidecar's baseline capture policy. */
export const INLINE_CONTEXT_MAX_BYTES = 24 * 1024;
export const INLINE_CONTEXT_MAX_LINES = 300;
export const INLINE_FALLBACK_MAX_CHARS = 12_000;

/** Tool names this module indexes and searches. */
const SIDECAR_TOOL_NAMES = ["bash", "bash_bg", "agent_bg"] as const;
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

let sidecarIndexStats: SidecarIndexStats = {
    attempts: 0,
    eligible: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    missingLogSkipped: 0,
    entriesDroppedWhenCtxStale: 0,
    emptySkipped: 0,
    unavailableSkipped: 0,
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
        missingLogSkipped: 0,
        entriesDroppedWhenCtxStale: 0,
        emptySkipped: 0,
        unavailableSkipped: 0,
        staleSessionIdentity: 0,
    };
}

/** Load and validate the owner's versioned package client. Importing the package
 * does not open the database; an absent extension is an ordinary unavailable
 * result. */
async function getSidecarOwnerClient(): Promise<
    ContextSidecarClient | undefined
> {
    try {
        const owner = await import("@spences10/pi-context");
        const descriptor = owner.CONTEXT_SIDECAR_CLIENT_API;
        if (
            descriptor?.id !== "@spences10/pi-context/sidecar-owner" ||
            descriptor.version !== 1 ||
            descriptor.operations.join(",") !==
                "indexOutput,findSources,deleteSources"
        )
            return undefined;
        const client = owner.get_context_sidecar_client();
        if (
            !client ||
            client.descriptor.id !== descriptor.id ||
            client.descriptor.version !== descriptor.version ||
            client.descriptor.operations.join(",") !==
                descriptor.operations.join(",")
        )
            return undefined;
        return client;
    } catch {
        return undefined;
    }
}

function ownerError(
    error: { code: string; message: string; retryable: boolean },
    receipt: string
): Error & { code?: string; ownerCode: string; retryable: boolean } {
    const code = error.code === "busy" ? "SQLITE_BUSY" : undefined;
    return Object.assign(new Error(`${receipt}: ${error.message}`), {
        ...(code ? { code } : {}),
        ownerCode: error.code,
        retryable: error.retryable,
    });
}

function requireOwnerResult<T>(result: SidecarOwnerResult<T>): T {
    if (!result.ok) {
        const error = ownerError(result.error, result.receipt);
        if (
            result.error.code === "owner_unavailable" ||
            result.error.code === "disabled"
        )
            Object.assign(error, { ownerCode: "owner_unavailable" });
        throw error;
    }
    return result.result;
}

async function recordOwnerUnavailableSkip(
    ctx: SidecarContext | undefined,
    jobId: string,
    reason: string,
    logPath = join(tmpdir(), "pi-tau-maintenance.log")
): Promise<void> {
    sidecarIndexStats.skipped += 1;
    sidecarIndexStats.unavailableSkipped += 1;
    const event = {
        jobId,
        reason: "owner_unavailable",
        detail: reason,
        unavailableSkipped: sidecarIndexStats.unavailableSkipped,
    };
    const identity = readSessionIdentity(ctx);
    if (identity.stale) {
        sidecarIndexStats.entriesDroppedWhenCtxStale += 1;
    } else {
        try {
            ctx?.appendEntry?.("sidecar-index-owner-unavailable", event);
        } catch (error) {
            if (isStaleCtxError(error))
                sidecarIndexStats.entriesDroppedWhenCtxStale += 1;
        }
    }
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "sidecar-index-owner-unavailable",
        ...event,
    });
    try {
        await appendFile(logPath, `${line}\n`);
    } catch {
        // Sidecar diagnostics must not change the background job result.
    }
}

/** Find the stable source/chunk IDs for a job through the owner API. */
export async function findJobSourceDetailsInSidecar(
    jobId: string
): Promise<JobOutputIndex | null> {
    const client = await getSidecarOwnerClient();
    if (!client) return null;
    try {
        const sources = requireOwnerResult(
            await client.findSources({
                job_id: jobId,
                tool_names: SIDECAR_TOOL_NAMES,
                limit: 100,
            })
        );
        const source = sources[0];
        return source
            ? { sourceId: source.source_id, chunkIds: source.chunk_ids }
            : null;
    } catch {
        return null;
    }
}

/** Search indexed output by tool family and free-text query via pi-context. */
export async function searchSidecarSources(
    query: string,
    options: { toolNames?: readonly string[]; limit?: number } = {}
): Promise<SidecarSourceMatch[]> {
    const client = await getSidecarOwnerClient();
    if (!client) return [];
    const toolNames = options.toolNames?.length
        ? options.toolNames
        : SIDECAR_SEARCH_TOOL_NAMES;
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    try {
        return requireOwnerResult(
            await client.findSources({ query, tool_names: toolNames, limit })
        ).map((source: ContextExternalSource) => ({
            sourceId: source.source_id,
            chunkIds: source.chunk_ids,
            toolName: source.tool_name,
            createdAt: source.created_at,
            inputSummary: source.input_summary,
        }));
    } catch {
        return [];
    }
}

/** Backward-compatible source-only lookup. */
export async function findJobSourceIdInSidecar(
    jobId: string
): Promise<string | null> {
    return (await findJobSourceDetailsInSidecar(jobId))?.sourceId ?? null;
}

/** Read output and stable IDs for a job through the owner's retrieval API. */
export async function readJobOutputDetailsFromSidecar(
    jobId: string
): Promise<SidecarJobOutput | null> {
    const client = await getSidecarOwnerClient();
    if (!client) return null;
    try {
        const sources = requireOwnerResult(
            await client.findSources({
                job_id: jobId,
                tool_names: SIDECAR_TOOL_NAMES,
                limit: 100,
            })
        );
        const match = sources[0];
        if (!match) return null;
        const [source] = requireOwnerResult(
            await client.findSources({ source_id: match.source_id, limit: 1 })
        );
        if (!source?.text) return null;
        let logPath: string | undefined;
        try {
            logPath = (JSON.parse(source.input_summary) as { logPath?: string })
                .logPath;
        } catch {
            // Older records may not contain a JSON input summary.
        }
        return {
            sourceId: source.source_id,
            chunkIds: source.chunk_ids,
            text: source.text,
            ...(logPath ? { logPath } : {}),
        };
    } catch {
        return null;
    }
}

/** Delete one explicitly selected source through the owner API. */
export async function deleteSidecarSource(
    sourceId: string,
    ctx?: SidecarContext
): Promise<ContextPurgeDetails | undefined> {
    const client = await getSidecarOwnerClient();
    if (!client) {
        await recordOwnerUnavailableSkip(ctx, sourceId, "deleteSources");
        return undefined;
    }
    try {
        return requireOwnerResult(await client.deleteSources(sourceId));
    } catch (error) {
        if (
            error &&
            typeof error === "object" &&
            (error as { ownerCode?: string }).ownerCode === "owner_unavailable"
        ) {
            await recordOwnerUnavailableSkip(
                ctx,
                sourceId,
                formatUnknownError(error)
            );
            return undefined;
        }
        throw error;
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
 * Optional test/caller controls for indexing behavior. Classification remains advisory.
 */
export interface SidecarIndexOptions {
    classify?: (text: string) => LogCounts;
    /** Override log reads for deterministic transient-I/O tests. */
    readLog?: (path: string) => Promise<string>;
    /** Override the durable failure log path for tests. */
    failureLogPath?: string;
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

function getSqliteErrorCode(error: unknown): string | number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const sqliteError = error as { code?: unknown; errcode?: unknown };
    const code = sqliteError.errcode ?? sqliteError.code;
    return typeof code === "string" || typeof code === "number"
        ? code
        : undefined;
}

function formatUnknownError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error) ?? "Unknown error";
    } catch {
        return "Unknown error";
    }
}

function getIndexErrorInput(error: unknown, message: string) {
    if (!error || typeof error !== "object") return { message };
    const source = error as {
        code?: unknown;
        errno?: unknown;
        errcode?: unknown;
    };
    const code = source.errcode ?? source.code;
    return {
        ...(typeof code === "string" || typeof code === "number"
            ? { code }
            : {}),
        ...(typeof source.errno === "string" || typeof source.errno === "number"
            ? { errno: source.errno }
            : {}),
        message,
    };
}

async function reportSidecarIndexFailure(
    ctx: SidecarContext,
    data: Record<string, unknown>,
    logPath = join(tmpdir(), "pi-tau-maintenance.log")
): Promise<void> {
    const identity = readSessionIdentity(ctx);
    if (identity.stale) {
        sidecarIndexStats.entriesDroppedWhenCtxStale += 1;
    } else {
        try {
            ctx.appendEntry?.("sidecar-index-failure", data);
        } catch (error) {
            if (isStaleCtxError(error))
                sidecarIndexStats.entriesDroppedWhenCtxStale += 1;
        }
    }
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "sidecar-index-failure",
        ...data,
        entries_dropped_when_ctx_stale:
            sidecarIndexStats.entriesDroppedWhenCtxStale,
        missing_log_skipped: sidecarIndexStats.missingLogSkipped,
    });
    try {
        await appendFile(logPath, `${line}\n`);
    } catch {
        // Diagnostics must never alter the primary background-job result.
    }
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
        const classified = classifyIndexError(
            getIndexErrorInput(readError, errorMessage)
        );
        const missingLog = classified.category === "missing";
        let expectedSizeBytes: number | null = null;
        try {
            expectedSizeBytes = (await stat(job.logPath)).size;
        } catch {
            // Unknown when the path is gone or metadata itself is inaccessible.
        }
        const outcome: SidecarIndexOutcome = {
            status: missingLog ? "skipped" : "failed",
            eligible: false,
            reason: missingLog ? "log_missing" : "read_failed",
            errorCategory: classified.category,
            errorMessage,
            ...(errorCode !== undefined ? { errorCode } : {}),
            retryCount: readRetryCount,
        };
        if (missingLog) {
            sidecarIndexStats.skipped += 1;
            sidecarIndexStats.missingLogSkipped += 1;
        } else {
            sidecarIndexStats.failed += 1;
        }
        await reportSidecarIndexFailure(
            ctx,
            {
                jobId: job.id,
                reason: outcome.reason,
                category: classified.category,
                errno: errorCode,
                errorMessage,
                logPath: job.logPath,
                expectedSizeBytes,
                retryCount: readRetryCount,
            },
            options.failureLogPath
        );
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
    const client = await getSidecarOwnerClient();
    if (!client) {
        if (readSessionIdentity(ctx).stale) {
            const errorMessage = new StaleSessionIdentityError().message;
            sidecarIndexStats.failed += 1;
            await reportSidecarIndexFailure(
                ctx,
                {
                    jobId: job.id,
                    reason: "index_failed",
                    category: "stale",
                    errorMessage,
                },
                options.failureLogPath
            );
            return {
                status: "failed",
                eligible: true,
                reason: "index_failed",
                errorCategory: "stale",
                errorMessage,
            };
        }
        await recordOwnerUnavailableSkip(
            ctx,
            job.id,
            "pi-context owner descriptor unavailable",
            options.failureLogPath
        );
        return {
            status: "skipped",
            eligible: true,
            reason: "sidecar_unavailable",
            errorCategory: "unavailable",
        };
    }

    const projectPath = ctx.cwd ?? process.cwd();
    const inputSummary = JSON.stringify({
        command: job.command,
        jobId: job.id,
        exitCode: job.exitCode,
        status: job.status,
        logPath: job.logPath,
    });
    const startedAt = Date.now();
    const writeAttempt = await retryIndexOperation(async () => {
        const identity = readSessionIdentity(ctx);
        if (identity.stale) throw new StaleSessionIdentityError();
        const input: StoreContextInput = {
            text,
            tool_name: toolName,
            input_summary: inputSummary,
            session_id: identity.value,
            project_path: projectPath,
            force: true,
        };
        const response = await client.indexOutput(input);
        const stored = requireOwnerResult(response);
        return stored?.source_id;
    });
    const retryCount = writeAttempt.retryCount;
    const sourceId = writeAttempt.ok ? writeAttempt.value : undefined;
    const lastError = writeAttempt.ok ? undefined : writeAttempt.error;
    const waitMs = Date.now() - startedAt;
    if (
        lastError &&
        ["owner_unavailable", "disabled"].includes(
            (lastError as { ownerCode?: string }).ownerCode ?? ""
        )
    ) {
        await recordOwnerUnavailableSkip(
            ctx,
            job.id,
            formatUnknownError(lastError),
            options.failureLogPath
        );
        return {
            status: "skipped",
            eligible: true,
            reason: "sidecar_unavailable",
            errorCategory: "unavailable",
            retryCount: retryCount + readRetryCount,
            waitMs,
        };
    }
    if (!lastError && !sourceId) {
        sidecarIndexStats.skipped += 1;
        return {
            status: "skipped",
            eligible: true,
            reason: "owner_skipped",
            retryCount: retryCount + readRetryCount,
            waitMs,
        };
    }
    if (!lastError && sourceId) {
        const indexedSource = (await findJobSourceDetailsInSidecar(job.id)) ?? {
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

    const errorMessage = formatUnknownError(lastError);
    const errorCode = getSqliteErrorCode(lastError);
    const errorCategory: SidecarIndexOutcome["errorCategory"] =
        lastError instanceof StaleSessionIdentityError
            ? "stale"
            : classifyIndexError(getIndexErrorInput(lastError, errorMessage))
                  .category;
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
    await reportSidecarIndexFailure(
        ctx,
        {
            jobId: job.id,
            reason: "index_failed",
            category: errorCategory,
            errorMessage,
            errorCode,
            retryCount,
            waitMs,
        },
        options.failureLogPath
    );
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
