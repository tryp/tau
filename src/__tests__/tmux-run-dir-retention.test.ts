/**
 * Tests for stale run-directory cleanup (src/features/bash-tmux.ts).
 *
 * Incident: `cleanupStaleTmuxRunDirs()` ran on every pi-tau session startup and
 * deleted the whole `/tmp/pi-tmux-<pid>` directory of any process that was no
 * longer alive. A session that had spawned >100 background jobs therefore lost
 * every job log the moment it exited — and in the incident it exited right
 * after a 15-minute silent provider stall, so the logs were the only record of
 * what had been running. The next pi startup destroyed them.
 *
 * Contract under test: a dead process's run directory is retained for
 * RUN_DIR_RETENTION_MS (24h), including the job output files inside it. Live
 * processes are never touched, our own directory is skipped, unattributable
 * /tmp entries are ignored, and reaping orphaned tmux sessions never removes a
 * retained directory.
 *
 * The retention tests below fail against the previous eager `rmSync` cleanup.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    MAX_RUN_DIR_RETENTION_MS,
    RUN_DIR_RETENTION_MS,
    type StaleRunDirCleanupOptions,
    cleanupStaleTmuxRunDirs,
    resolveRunDirRetentionMs,
} from "../features/bash-tmux.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Fixed clock so ages are exact and independent of wall time. */
const NOW_MS = 1_800_000_000_000;

/** Env var the retention override is read from. */
const RETENTION_ENV = "PI_TAU_TMUX_RUN_DIR_RETENTION_MS";

let root = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-tau-run-dir-test-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/**
 * Create a `pi-tmux-<name>` run directory aged by `ageMs`, optionally with a
 * job output file inside it. The mtime is set after the file write, because
 * writing into a directory bumps its own mtime.
 */
function makeRunDir(name: string, ageMs: number, output?: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (output !== undefined) {
        writeFileSync(join(dir, "pi-bg-job.out"), output);
    }
    const stamp = (NOW_MS - ageMs) / 1000;
    utimesSync(dir, stamp, stamp);
    return dir;
}

/** Run the cleanup against the temp root with test defaults. */
function cleanup(overrides: Partial<StaleRunDirCleanupOptions> = {}): void {
    cleanupStaleTmuxRunDirs({
        rootDir: root,
        now: () => NOW_MS,
        isAlive: () => false,
        retentionMs: RUN_DIR_RETENTION_MS,
        runTmux: () => "",
        ...overrides,
    });
}

void describe("stale run dir cleanup", () => {
    void it("preserves the run dir of a live process", () => {
        const dir = makeRunDir("pi-tmux-111", 48 * HOUR_MS);
        cleanup({ isAlive: (pid) => pid === 111 });
        assert.equal(existsSync(dir), true);
    });

    void it("preserves a dead process's run dir and job logs inside the retention window", () => {
        const dir = makeRunDir("pi-tmux-222", HOUR_MS, "job output tail");
        cleanup();
        assert.equal(existsSync(dir), true);
        assert.equal(
            readFileSync(join(dir, "pi-bg-job.out"), "utf-8"),
            "job output tail"
        );
    });

    void it("removes a dead process's run dir older than the retention window", () => {
        const dir = makeRunDir("pi-tmux-333", RUN_DIR_RETENTION_MS + HOUR_MS);
        cleanup();
        assert.equal(existsSync(dir), false);
    });

    void it("treats the retention boundary as inclusive", () => {
        const atBoundary = makeRunDir("pi-tmux-444", RUN_DIR_RETENTION_MS);
        const justInside = makeRunDir("pi-tmux-445", RUN_DIR_RETENTION_MS - 1);
        cleanup();
        assert.equal(existsSync(atBoundary), false);
        assert.equal(existsSync(justInside), true);
    });

    void it("removes dead-process dirs regardless of age when retention is 0", () => {
        const fresh = makeRunDir("pi-tmux-555", 0);
        const live = makeRunDir("pi-tmux-556", 0);
        cleanup({ retentionMs: 0, isAlive: (pid) => pid === 556 });
        assert.equal(existsSync(fresh), false);
        assert.equal(existsSync(live), true);
    });

    void it("skips our own process id", () => {
        const dir = makeRunDir(`pi-tmux-${process.pid}`, 48 * HOUR_MS);
        cleanup({ retentionMs: 0, isAlive: () => false });
        assert.equal(existsSync(dir), true);
    });

    void it("ignores unrelated and unattributable entries", () => {
        const unrelated = makeRunDir("some-other-tmp-dir", 48 * HOUR_MS);
        const unattributable = makeRunDir("pi-tmux-not-a-pid", 48 * HOUR_MS);
        cleanup({ retentionMs: 0 });
        assert.equal(existsSync(unrelated), true);
        assert.equal(existsSync(unattributable), true);
    });

    void it("keeps a dir that disappears mid-scan and continues the scan", () => {
        const vanishing = makeRunDir("pi-tmux-661", 48 * HOUR_MS);
        const stale = makeRunDir("pi-tmux-662", 48 * HOUR_MS);
        cleanup({
            retentionMs: 0,
            isAlive: (pid) => {
                if (pid === 661) {
                    // Another pi process reaped it between readdir and stat.
                    rmSync(vanishing, { recursive: true, force: true });
                }
                return false;
            },
        });
        assert.equal(existsSync(vanishing), false);
        assert.equal(existsSync(stale), false);
    });

    void it("returns quietly when the root directory cannot be read", () => {
        assert.doesNotThrow(() => {
            cleanup({ rootDir: join(root, "does-not-exist"), retentionMs: 0 });
        });
    });

    void it("uses the env-resolved retention when the option is omitted", () => {
        process.env[RETENTION_ENV] = "0";
        try {
            const dir = makeRunDir("pi-tmux-777", 0);
            cleanupStaleTmuxRunDirs({
                rootDir: root,
                now: () => NOW_MS,
                isAlive: () => false,
                runTmux: () => "",
            });
            assert.equal(existsSync(dir), false);
        } finally {
            delete process.env[RETENTION_ENV];
        }
    });
});

void describe("orphaned tmux session reaping", () => {
    /** Fake tmux whose only session is one pi-bg session with the given panes. */
    function tmuxWithPanes(panes: string): {
        calls: string[];
        runTmux: (command: string) => string;
    } {
        const calls: string[] = [];
        return {
            calls,
            runTmux: (command) => {
                calls.push(command);
                if (command.startsWith("tmux list-sessions")) {
                    return "pi-bg-alpha-1\nother-session\n";
                }
                if (command.startsWith("tmux list-panes")) {
                    return panes;
                }
                return "";
            },
        };
    }

    void it("kills pi-bg sessions whose panes are all dead", () => {
        const { calls, runTmux } = tmuxWithPanes("4242\n4243\n");
        cleanup({ runTmux });
        assert.deepEqual(calls, [
            "tmux list-sessions -F '#{session_name}'",
            "tmux list-panes -t pi-bg-alpha-1 -F '#{pane_pid}'",
            "tmux kill-session -t pi-bg-alpha-1",
        ]);
    });

    void it("keeps pi-bg sessions that still have a live pane", () => {
        const { calls, runTmux } = tmuxWithPanes("4242\n4243\n");
        cleanup({ runTmux, isAlive: (pid) => pid === 4243 });
        assert.equal(
            calls.some((command) => command.startsWith("tmux kill-session")),
            false
        );
    });

    void it("does not delete a retained run dir while reaping sessions", () => {
        const { runTmux } = tmuxWithPanes("4242\n");
        const dir = makeRunDir("pi-tmux-888", HOUR_MS, "kept log");
        cleanup({ runTmux, isAlive: () => false });
        assert.equal(existsSync(dir), true);
        assert.equal(
            readFileSync(join(dir, "pi-bg-job.out"), "utf-8"),
            "kept log"
        );
    });
});

void describe("run dir retention resolution", () => {
    void it("defaults when unset", () => {
        assert.equal(resolveRunDirRetentionMs({}), RUN_DIR_RETENTION_MS);
    });

    void it("accepts an explicit value including zero", () => {
        assert.equal(resolveRunDirRetentionMs({ [RETENTION_ENV]: "0" }), 0);
        assert.equal(
            resolveRunDirRetentionMs({ [RETENTION_ENV]: String(HOUR_MS) }),
            HOUR_MS
        );
        assert.equal(
            resolveRunDirRetentionMs({ [RETENTION_ENV]: ` ${HOUR_MS} ` }),
            HOUR_MS
        );
    });

    void it("rejects malformed values", () => {
        for (const raw of ["1e9", "-5", "20.5", "abc", "", "12h"]) {
            assert.equal(
                resolveRunDirRetentionMs({ [RETENTION_ENV]: raw }),
                RUN_DIR_RETENTION_MS,
                `expected fallback for ${JSON.stringify(raw)}`
            );
        }
    });

    void it("clamps values above the ceiling", () => {
        assert.equal(
            resolveRunDirRetentionMs({
                [RETENTION_ENV]: String(MAX_RUN_DIR_RETENTION_MS * 10),
            }),
            MAX_RUN_DIR_RETENTION_MS
        );
    });

    void it("falls back for integers outside the safe range", () => {
        assert.equal(
            resolveRunDirRetentionMs({ [RETENTION_ENV]: "9".repeat(30) }),
            RUN_DIR_RETENTION_MS
        );
    });
});
