export type SidecarIndexErrorCategory =
    | "busy"
    | "locked"
    | "readonly"
    | "schema"
    | "stale"
    | "missing"
    | "permission"
    | "io"
    | "unknown";

export interface ClassifiedIndexError {
    category: SidecarIndexErrorCategory;
    retryable: boolean;
}

export interface IndexErrorInput {
    code?: string | number;
    errno?: string | number;
    message: string;
}

export type RetryIndexResult<T> =
    | { ok: true; value: T; retryCount: number }
    | { ok: false; error: unknown; retryCount: number };

/** Run the existing bounded index attempt policy, retrying only lock contention. */
export async function retryIndexOperation<T>(
    operation: () => Promise<T>,
    maxRetries = 3
): Promise<RetryIndexResult<T>> {
    let retryCount = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return { ok: true, value: await operation(), retryCount };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            const classification = classifyIndexError({
                ...getErrorFields(error),
                message,
            });
            if (!classification.retryable || attempt === maxRetries)
                return { ok: false, error, retryCount };
            retryCount += 1;
            await new Promise<void>((resolve) =>
                setTimeout(resolve, 50 * 2 ** attempt)
            );
        }
    }
    throw new Error("unreachable retry state");
}

function getErrorFields(
    error: unknown
): Pick<IndexErrorInput, "code" | "errno"> {
    if (!error || typeof error !== "object") return {};
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
    };
}

/** Classify Node and SQLite failures without conflating lock contention with I/O. */
export function classifyIndexError({
    code,
    errno,
    message,
}: IndexErrorInput): ClassifiedIndexError {
    const codes = [code, errno].filter(
        (value): value is string | number => value !== undefined
    );
    const normalizedCodes = codes.map((value) => String(value).toUpperCase());

    // Prefer explicit OS and SQLite codes. SQLite extended result codes retain
    // their primary result in the low byte (e.g. SQLITE_BUSY_SNAPSHOT = 517).
    if (normalizedCodes.some((value) => ["ENOENT", "ENOTDIR"].includes(value)))
        return result("missing");
    if (normalizedCodes.includes("EROFS")) return result("readonly");
    if (
        ["EIO", "EISDIR", "ENOSPC"].some((value) =>
            normalizedCodes.includes(value)
        )
    )
        return result("io");
    if (normalizedCodes.some((value) => ["EACCES", "EPERM"].includes(value)))
        return result("permission");
    if (normalizedCodes.some((value) => value.includes("SQLITE_BUSY")))
        return result("busy", true);
    if (normalizedCodes.some((value) => value.includes("SQLITE_LOCKED")))
        return result("locked", true);
    if (normalizedCodes.some((value) => value.includes("SQLITE_READONLY")))
        return result("readonly");
    if (
        normalizedCodes.some(
            (value) =>
                value.includes("SQLITE_SCHEMA") ||
                value.includes("SQLITE_CONSTRAINT") ||
                value.includes("SQLITE_MISMATCH")
        )
    )
        return result("schema");
    if (
        normalizedCodes.some(
            (value) =>
                value.includes("SQLITE_IOERR") ||
                value.includes("SQLITE_CANTOPEN")
        )
    )
        return result("io");

    for (const value of codes) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue;
        const primary = value & 0xff;
        if (primary === 5) return result("busy", true);
        if (primary === 6) return result("locked", true);
        if (primary === 8) return result("readonly");
        if (primary === 17 || primary === 19 || primary === 20)
            return result("schema");
        if (primary === 10 || primary === 14) return result("io");
        if (primary === 12) return result("missing");
        // Node/libuv errno values: ENOENT=-2, EACCES=-13, EPERM=-1.
        if (value === -2 || value === -20) return result("missing");
        if (value === -13 || value === -1) return result("permission");
        if (value === -5 || value === -21 || value === -28) return result("io");
        if (value === -30) return result("readonly");
    }

    const text = message.toLowerCase();
    if (/extension ctx is stale after session replacement or reload/.test(text))
        return result("stale");
    if (
        /no such table|no such column|malformed schema|\bfts5\b|constraint failed/.test(
            text
        )
    )
        return result("schema");
    if (/no such file|enoent|not found/.test(text)) return result("missing");
    if (/permission denied|eacces|eperm|operation not permitted/.test(text))
        return result("permission");
    if (/read-only|readonly|attempt to write a readonly database/.test(text))
        return result("readonly");
    if (/sqlite_busy|database is busy|\bbusy\b/.test(text))
        return result("busy", true);
    if (/sqlite_locked|database is locked|\blocked\b/.test(text))
        return result("locked", true);
    if (
        /sqlite_ioerr|i\/o error|input\/output error|disk i\/o|\beio\b|disk full|no space left/.test(
            text
        )
    )
        return result("io");
    return result("unknown");
}

function result(
    category: SidecarIndexErrorCategory,
    retryable = false
): ClassifiedIndexError {
    return { category, retryable };
}
