import {
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { stageZeroDirectory } from "./stage0-path.ts";

export const DEFAULT_STAGE0_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
const CAPTURE_NAME = /^pi-pipe-stage0-[A-Za-z0-9_-]+\.log$/;
const INDEX_SUFFIX = ".indexed.json";
const STATE_NAME = ".stage0-gc-state.json";

export interface Stage0SweepOptions {
    directories: string[];
    budgetBytes?: number;
    maxFiles?: number;
    maxMs?: number;
    now?: () => number;
}

export interface Stage0SweepResult {
    observedBytes: number;
    filesVisited: number;
    complete: boolean;
    deletedPaths: string[];
}

interface IndexedEvidence {
    sourceId: string;
    indexedAt: number;
}

interface CaptureRecord {
    size: number;
    mtimeMs: number;
    indexed: boolean;
}

interface SweepState {
    files: Record<string, CaptureRecord>;
}

function indexPath(capturePath: string): string {
    return `${capturePath}${INDEX_SUFFIX}`;
}

function statePath(directory: string): string {
    return join(directory, STATE_NAME);
}

function readState(path: string): SweepState {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SweepState>;
        if (value.files && typeof value.files === "object") {
            return { files: value.files };
        }
    } catch {
        // Rebuild state incrementally after a corrupt or absent state file.
    }
    return { files: {} };
}

function writeState(path: string, state: SweepState): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
}

function hasIndexEvidence(capturePath: string): boolean {
    try {
        const value = JSON.parse(readFileSync(indexPath(capturePath), "utf8")) as Partial<IndexedEvidence>;
        return typeof value.sourceId === "string" && value.sourceId.length > 0;
    } catch {
        return false;
    }
}

/** Write durable evidence only after sidecar indexing returned a source id. */
export function markStage0CaptureIndexed(
    capturePath: string,
    sourceId: string,
    indexedAt = Date.now(),
    stateDirectory = stageZeroDirectory()
): boolean {
    if (!sourceId) return false;
    try {
        const stat = statSync(capturePath);
        if (!stat.isFile()) return false;
        const target = indexPath(capturePath);
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(
            temporary,
            JSON.stringify({ sourceId, indexedAt } satisfies IndexedEvidence),
            { encoding: "utf8", mode: 0o600 }
        );
        renameSync(temporary, target);

        // Keep the incremental GC inventory aware of newly indexed files, even
        // when a prior bounded pass had already inventoried this payload.
        mkdirSync(stateDirectory, { recursive: true });
        const ledger = statePath(stateDirectory);
        const state = readState(ledger);
        state.files[capturePath] = {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            indexed: true,
        };
        writeState(ledger, state);
        return true;
    } catch {
        // No evidence means no deletion. Retaining an extra file is safe.
        return false;
    }
}

/**
 * Bounded incremental GC across current and legacy capture directories. Each
 * pass inventories at most maxFiles payloads (or maxMs), persisting progress so
 * large directories are eventually covered. Deletion only starts after a full
 * inventory, which makes the byte budget and global mtime ordering exact.
 */
export function sweepStage0Captures(
    options: Stage0SweepOptions
): Stage0SweepResult {
    const directories = [...new Set(options.directories)];
    const stateDirectory = directories[0] ?? stageZeroDirectory();
    const ledger = statePath(stateDirectory);
    const budgetBytes = options.budgetBytes ?? resolveStage0BudgetBytes();
    const maxFiles = options.maxFiles ?? 500;
    const maxMs = options.maxMs ?? 2_000;
    const now = options.now ?? Date.now;
    const startedAt = now();
    const state = readState(ledger);
    const currentPaths: string[] = [];
    let listingComplete = true;

    for (const directory of directories) {
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") listingComplete = false;
            continue;
        }
        for (const name of names) {
            if (CAPTURE_NAME.test(name)) currentPaths.push(join(directory, name));
        }
    }
    const current = new Set(currentPaths);
    for (const path of Object.keys(state.files)) {
        if (!current.has(path)) delete state.files[path];
    }

    let filesVisited = 0;
    for (const path of currentPaths) {
        if (state.files[path]) continue;
        if (filesVisited >= maxFiles || now() - startedAt >= maxMs) {
            listingComplete = false;
            break;
        }
        filesVisited++;
        try {
            const stat = statSync(path);
            if (!stat.isFile()) continue;
            state.files[path] = {
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                indexed: hasIndexEvidence(path),
            };
        } catch {
            // Retry unreadable or concurrently changing files on the next pass.
        }
    }

    const complete =
        listingComplete && currentPaths.every((path) => Boolean(state.files[path]));
    const deletedPaths: string[] = [];
    let observedBytes = Object.values(state.files).reduce(
        (total, file) => total + file.size,
        0
    );

    if (complete && observedBytes > budgetBytes) {
        const candidates = currentPaths
            .map((path) => ({ path, ...state.files[path] }))
            .filter((file) => file.indexed)
            .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
        for (const candidate of candidates) {
            if (observedBytes <= budgetBytes) break;
            if (
                deletedPaths.length >= maxFiles ||
                now() - startedAt >= maxMs
            ) {
                break;
            }
            try {
                unlinkSync(candidate.path);
                try {
                    unlinkSync(indexPath(candidate.path));
                } catch {
                    // Orphan metadata is harmless and never authorizes deletion.
                }
                observedBytes -= candidate.size;
                delete state.files[candidate.path];
                deletedPaths.push(candidate.path);
            } catch {
                // A failed delete remains counted and the next sweep can retry.
            }
        }
    }

    try {
        mkdirSync(stateDirectory, { recursive: true });
        writeState(ledger, state);
    } catch {
        // Inventory persistence is an optimization; lack of it never deletes
        // unindexed content. A later pass can rebuild the inventory.
    }

    return { observedBytes, filesVisited, complete, deletedPaths };
}

export function resolveStage0BudgetBytes(
    value = process.env.PI_TAU_STAGE0_BUDGET_BYTES
): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
        ? parsed
        : DEFAULT_STAGE0_BUDGET_BYTES;
}

export function legacyStage0Directory(home: string): string {
    return join(home, "tmp");
}

export function isStage0CapturePath(path: string): boolean {
    return CAPTURE_NAME.test(basename(path));
}
