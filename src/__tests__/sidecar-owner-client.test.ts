import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register_context_sidecar_owner } from "@spences10/pi-context";
import {
    deleteSidecarSource,
    getSidecarIndexStats,
    indexJobOutputWithOutcome,
    readJobOutputDetailsFromSidecar,
    resetSidecarIndexStats,
    searchSidecarSources,
} from "../features/sidecar.ts";
import type { SidecarContext } from "../features/sidecar.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalContextDb = process.env.MY_PI_CONTEXT_DB;
let tempDir: string;
let closeOwner: (() => Promise<void>) | undefined;

beforeEach(() => {
    resetSidecarIndexStats();
    tempDir = mkdtempSync(join(tmpdir(), "pi-tau-owner-client-"));
    process.env.PI_CODING_AGENT_DIR = tempDir;
    process.env.MY_PI_CONTEXT_DB = join(tempDir, "context.db");
    closeOwner = register_context_sidecar_owner();
});

afterEach(async () => {
    await closeOwner?.();
    closeOwner = undefined;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalContextDb === undefined) delete process.env.MY_PI_CONTEXT_DB;
    else process.env.MY_PI_CONTEXT_DB = originalContextDb;
    rmSync(tempDir, { recursive: true, force: true });
});

void describe("pi-context sidecar owner client", () => {
    void it("indexes, finds, reads, and explicitly deletes output through the real owner store", async () => {
        const text = `owner-client-integration-needle\n${"large output line\n".repeat(600)}`;
        const logPath = join(tempDir, "job.log");
        writeFileSync(logPath, text);
        const job = {
            id: "job-owner-integration",
            command: "make test",
            logPath,
            status: "completed",
            exitCode: 0,
        };
        const entries: Array<{ type: string; data: unknown }> = [];
        const ctx: SidecarContext = {
            cwd: tempDir,
            sessionManager: { getSessionId: () => "owner-integration-session" },
            appendEntry: (type, data) => entries.push({ type, data }),
        };

        const indexed = await indexJobOutputWithOutcome(job, ctx, "bash_bg");
        assert.equal(indexed.status, "indexed");
        assert.ok(indexed.source?.sourceId);
        assert.ok(indexed.source?.chunkIds.length);
        assert.equal(getSidecarIndexStats().indexed, 1);

        const match = (
            await searchSidecarSources("owner-client-integration-needle", {
                toolNames: ["bash_bg"],
            })
        )[0];
        assert.equal(match?.sourceId, indexed.source?.sourceId);
        const read = await readJobOutputDetailsFromSidecar(job.id);
        assert.equal(read?.sourceId, indexed.source?.sourceId);
        assert.equal(read?.text, text);
        assert.equal(read?.logPath, logPath);
        assert.equal(existsSync(join(tempDir, "context.db")), true);

        const deleted = await deleteSidecarSource(indexed.source.sourceId, ctx);
        assert.equal(deleted?.deleted, 1);
        assert.equal(await readJobOutputDetailsFromSidecar(job.id), null);
        assert.ok(
            entries.every(
                (entry) => entry.type !== "sidecar-index-owner-unavailable"
            )
        );
    });

    void it("does not call deletion from the indexing path and contains no DB/schema access", () => {
        const source = readFileSync(
            new URL("../features/sidecar.ts", import.meta.url),
            "utf8"
        );
        const indexStart = source.indexOf(
            "export async function indexJobOutputWithOutcome"
        );
        const indexEnd = source.indexOf(
            "export async function indexJobOutputInSidecar",
            indexStart
        );
        assert.ok(indexStart >= 0 && indexEnd > indexStart);
        const indexPath = source.slice(indexStart, indexEnd);
        assert.doesNotMatch(indexPath, /deleteSidecarSource|deleteSources/);
        assert.match(source, /client\.deleteSources\(sourceId\)/);
        assert.doesNotMatch(
            source,
            /DatabaseSync|better-sqlite3|sqlite_master|context_sources|context_chunks|sidecarDbPath|context\.db/
        );
    });

    void it("persists the owner-unavailable skip counter in a session entry", async () => {
        await closeOwner?.();
        closeOwner = undefined;
        const entries: Array<{ type: string; data: Record<string, unknown> }> =
            [];
        const logPath = join(tempDir, "job.log");
        const failureLogPath = join(tempDir, "sidecar.log");
        writeFileSync(logPath, "owner unavailable output");
        const outcome = await indexJobOutputWithOutcome(
            {
                id: "job-owner-absent",
                command: "echo output",
                logPath,
            },
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

        assert.equal(outcome.status, "skipped");
        assert.equal(outcome.reason, "sidecar_unavailable");
        assert.equal(getSidecarIndexStats().unavailableSkipped, 1);
        assert.deepEqual(entries, [
            {
                type: "sidecar-index-owner-unavailable",
                data: {
                    jobId: "job-owner-absent",
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
        assert.equal(existsSync(join(tempDir, "context.db")), false);
    });
});
