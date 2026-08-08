/**
 * Unit tests for evaluateTrigger from trigger-check.ts.
 *
 * Tests each trigger type's evaluation logic using the current process's
 * /proc entries (always readable), temp log files, and controlled clock.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateTrigger,
    type TriggerAccum,
} from "../features/trigger-check.ts";
import { writeFileSync, unlinkSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let logPath: string;

before(() => {
    tmpDir = mkdtempSync("/tmp/pi-trigger-test-");
    logPath = join(tmpDir, "test.log");
});

after(() => {
    try {
        unlinkSync(logPath);
    } catch {
        /* file may already be gone */
    }
    try {
        unlinkSync(tmpDir);
    } catch {
        /* dir may already be gone */
    }
});

function writeLog(lines: string[]) {
    writeFileSync(logPath, lines.join("\n") + "\n");
}

function acc(overrides: Partial<TriggerAccum> = {}): TriggerAccum {
    return {
        prevSize: 0,
        prevLines: 0,
        ioBlockStartMs: undefined,
        jobStartMs: Date.now(),
        matchPrevSize: 0,
        matchTail: "",
        ...overrides,
    };
}

// ─── wallTime ───────────────────────────────────────────────────────

void describe("evaluateTrigger — wallTime", () => {
    void it("fires when seconds elapsed exceed threshold", () => {
        const a = acc({ jobStartMs: Date.now() - 5_000 }); // started 5s ago
        const result = evaluateTrigger(
            { type: "wallTime", value: 3 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.ok(
            result.current >= 3,
            `current=${result.current} should be >= 3`
        );
    });

    void it("does not fire before threshold", () => {
        const a = acc({ jobStartMs: Date.now() }); // just started
        const result = evaluateTrigger(
            { type: "wallTime", value: 9999 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
        assert.ok(result.current < 9999);
    });

    void it("fires immediately with value=0", () => {
        const a = acc({ jobStartMs: Date.now() - 100 });
        const result = evaluateTrigger(
            { type: "wallTime", value: 0 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
    });
});

// ─── outputLines ────────────────────────────────────────────────────

void describe("evaluateTrigger — outputLines", () => {
    void it("fires when log has N+ lines", () => {
        writeLog(["a", "b", "c", "d", "e"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputLines", value: 5 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.equal(result.current, 5);
    });

    void it("does not fire when log has fewer lines than threshold", () => {
        writeLog(["a", "b"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputLines", value: 10 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
    });

    void it("accumulates lines across multiple polls", () => {
        writeLog(["line1"]);
        const a = acc();
        // First poll: 1 line
        const r1 = evaluateTrigger(
            { type: "outputLines", value: 3 },
            process.pid,
            logPath,
            a
        );
        assert.equal(r1.met, false);
        assert.equal(r1.current, 1);

        // Second poll: append more lines
        writeLog(["line1", "line2", "line3"]);
        const r2 = evaluateTrigger(
            { type: "outputLines", value: 3 },
            process.pid,
            logPath,
            a
        );
        assert.equal(r2.met, true);
        assert.ok(r2.current >= 3, `current=${r2.current} should be >= 3`);
    });

    void it("resets counter when log file is truncated", () => {
        writeLog(["a", "b", "c"]);
        const a = acc();
        // First poll: 3 lines
        const r1 = evaluateTrigger(
            { type: "outputLines", value: 5 },
            process.pid,
            logPath,
            a
        );
        assert.equal(r1.current, 3);

        // Simulate log truncation: truly empty file
        writeFileSync(logPath, "");
        const r2 = evaluateTrigger(
            { type: "outputLines", value: 5 },
            process.pid,
            logPath,
            a
        );
        assert.equal(r2.current, 0);
    });
});

// ─── rssKb ──────────────────────────────────────────────────────────

void describe("evaluateTrigger — rssKb", () => {
    void it("reads RSS from /proc/self/status and compares", () => {
        const a = acc();
        const result = evaluateTrigger(
            { type: "rssKb", value: 1 },
            process.pid, // our own PID
            logPath,
            a
        );
        // Our process should definitely have RSS > 1 KB
        assert.equal(result.met, true);
        assert.ok(
            result.current > 100,
            `current=${result.current} should be > 100 Kb`
        );
    });

    void it("does not fire for unrealistically high threshold", () => {
        const a = acc();
        const result = evaluateTrigger(
            { type: "rssKb", value: 9_999_999_999 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
    });
});

// ─── ioReadBytes / ioWriteBytes ─────────────────────────────────────

void describe("evaluateTrigger — ioReadBytes / ioWriteBytes", () => {
    void it("reads I/O bytes from /proc/self/io", () => {
        const a = acc();
        // Read a file to generate read_bytes
        const result = evaluateTrigger(
            { type: "ioReadBytes", value: 0 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.ok(typeof result.current === "number");
    });

    void it("reads write_bytes from /proc/self/io", () => {
        const a = acc();
        const result = evaluateTrigger(
            { type: "ioWriteBytes", value: 0 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.ok(typeof result.current === "number");
    });

    void it("does not fire for large threshold", () => {
        const a = acc();
        const result = evaluateTrigger(
            { type: "ioReadBytes", value: 9_999_999_999_999 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
    });
});

// ─── cpuTime ────────────────────────────────────────────────────────

void describe("evaluateTrigger — cpuTime", () => {
    void it("reads CPU ticks from /proc/self/stat and converts to seconds", () => {
        const a = acc();
        const result = evaluateTrigger(
            { type: "cpuTime", value: 0 },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.ok(typeof result.current === "number");
        // At process start, CPU time might be 0, so value=0 should always fire
    });
});

// ─── ioBlock ────────────────────────────────────────────────────────

void describe("evaluateTrigger — ioBlock", () => {
    void it("does not fire when process is running (not in D state)", () => {
        const a = acc();
        const result = evaluateTrigger(
            { type: "ioBlock", value: 1 },
            process.pid,
            logPath,
            a
        );
        // Our process shouldn't be in D state
        assert.equal(result.met, false);
        assert.equal(result.current, 0);
    });

    void it("accumulates time while in D state and resets when leaving", () => {
        const a = acc();

        // Simulate first poll: process in D state
        // We can't actually put the process in D state, but we can set the
        // ioBlockStartMs timestamp to simulate having been in D state
        a.ioBlockStartMs = Date.now() - 5_000; // blocked for 5s

        // Now evaluate with current process (will NOT be in D state)
        // The ioBlock handler will see state !== "D" and reset ioBlockStartMs
        const result = evaluateTrigger(
            { type: "ioBlock", value: 3 },
            process.pid,
            logPath,
            a
        );
        // Since the process is NOT in D state, it should reset and not fire
        assert.equal(result.met, false);
        assert.equal(a.ioBlockStartMs, undefined);
    });
});

// ─── outputMatch ────────────────────────────────────────────────────

void describe("evaluateTrigger — outputMatch", () => {
    void it("fires when the pattern appears in the log", () => {
        writeLog(["started", "benchmark complete in 4m33s", "done"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputMatch", pattern: "benchmark complete" },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.equal(result.current, 1);
    });

    void it("is case-insensitive by default", () => {
        writeLog(["Benchmark COMPLETE"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputMatch", pattern: "benchmark complete" },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
    });

    void it("respects caseSensitive: true", () => {
        writeLog(["Benchmark COMPLETE"]);
        const a = acc();
        const result = evaluateTrigger(
            {
                type: "outputMatch",
                pattern: "benchmark complete",
                caseSensitive: true,
            },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
    });

    void it("does not fire when the pattern is absent", () => {
        writeLog(["nothing", "to see here"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputMatch", pattern: "ERROR|FAILED" },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
        assert.equal(result.current, 0);
    });

    void it("matches only newly appended bytes on later polls", () => {
        writeLog(["first phase done"]);
        const a = acc();
        const r1 = evaluateTrigger(
            { type: "outputMatch", pattern: "ready" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r1.met, false);

        writeLog(["first phase done", "server ready"]);
        const r2 = evaluateTrigger(
            { type: "outputMatch", pattern: "ready" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r2.met, true);
    });

    void it("matches patterns spanning incremental-chunk boundaries", async () => {
        const { appendFileSync } = await import("node:fs");
        writeFileSync(logPath, "building the ");
        const a = acc();
        const r1 = evaluateTrigger(
            { type: "outputMatch", pattern: "building the widget" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r1.met, false);

        // Append the rest of the match across the scan boundary.
        appendFileSync(logPath, "widget\n");
        const r2 = evaluateTrigger(
            { type: "outputMatch", pattern: "building the widget" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r2.met, true);
    });

    void it("resets the scan when the log is truncated", async () => {
        const { appendFileSync } = await import("node:fs");
        writeLog(["old content"]);
        const a = acc();
        const r1 = evaluateTrigger(
            { type: "outputMatch", pattern: "fresh" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r1.met, false);

        // Rotation observed mid-poll: empty file resets the incremental scan.
        writeFileSync(logPath, "");
        const r2 = evaluateTrigger(
            { type: "outputMatch", pattern: "fresh" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r2.met, false);

        // Fresh content written after rotation is scanned from the start.
        writeFileSync(logPath, "fresh start\n");
        const r3 = evaluateTrigger(
            { type: "outputMatch", pattern: "fresh" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r3.met, true);

        // A smaller file after the scan also resets the incremental offset.
        writeFileSync(logPath, "fresh start\n");
        const r4 = evaluateTrigger(
            { type: "outputMatch", pattern: "fresh" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r4.met, false); // nothing new appended
        appendFileSync(logPath, "more fresh\n");
        const r5 = evaluateTrigger(
            { type: "outputMatch", pattern: "fresh" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r5.met, true);
    });

    void it("counts multiple matches across the scanned region", () => {
        writeLog(["a", "b", "a"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputMatch", pattern: "a" },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.equal(result.current, 2);
    });

    void it("reports an error for an invalid pattern", () => {
        writeLog(["anything"]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputMatch", pattern: "(" },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, false);
        assert.ok(result.error, "error should be set for invalid regex");
    });

    void it("keeps ^ and $ line-anchored with the multiline flag", () => {
        writeLog([
            "  ERROR: indented, not at line start",
            "ERROR at line start",
        ]);
        const a = acc();
        const result = evaluateTrigger(
            { type: "outputMatch", pattern: "^ERROR" },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
        assert.equal(result.current, 1, "only the line-start match counts");
    });

    void it("caseSensitive: true fires when the exact case is present", () => {
        writeLog(["Benchmark COMPLETE"]);
        const a = acc();
        const result = evaluateTrigger(
            {
                type: "outputMatch",
                pattern: "Benchmark COMPLETE",
                caseSensitive: true,
            },
            process.pid,
            logPath,
            a
        );
        assert.equal(result.met, true);
    });

    void it("stays pending when the log does not exist yet, then fires once created", () => {
        const missing = join(tmpDir, "later.log");
        try {
            const a = acc();
            const r1 = evaluateTrigger(
                { type: "outputMatch", pattern: "ready" },
                process.pid,
                missing,
                a
            );
            assert.equal(r1.met, false);
            assert.equal(r1.error, undefined);
            assert.equal(a.matchPrevSize, 0, "nothing scanned yet");

            writeFileSync(missing, "server ready\n");
            const r2 = evaluateTrigger(
                { type: "outputMatch", pattern: "ready" },
                process.pid,
                missing,
                a
            );
            assert.equal(r2.met, true);
        } finally {
            try {
                unlinkSync(missing);
            } catch {
                /* already gone */
            }
        }
    });

    void it("bounds the incremental read when a poll sees a huge delta", async () => {
        const { appendFileSync } = await import("node:fs");
        writeLog(["start"]);
        const a = acc();
        const r1 = evaluateTrigger(
            { type: "outputMatch", pattern: "needle" },
            process.pid,
            logPath,
            a
        );
        assert.equal(r1.met, false);

        // More than the 4 MiB per-poll cap written between polls: the
        // tail read must still find the pattern at the end, and the scan
        // offset must advance to the new size.
        appendFileSync(logPath, "x".repeat(8 * 1024 * 1024) + "needle\n");
        const r2 = evaluateTrigger(
            { type: "outputMatch", pattern: "needle" },
            process.pid,
            logPath,
            a
        );
        assert.equal(
            r2.met,
            true,
            "pattern at the tail of a huge delta must match"
        );
        assert.equal(a.matchPrevSize, statSync(logPath).size);
    });
});

// ─── error handling ─────────────────────────────────────────────────

void describe("evaluateTrigger — error handling", () => {
    void it("throws on non-existent PID for fs-backed triggers", () => {
        const a = acc();
        assert.throws(() => {
            evaluateTrigger({ type: "rssKb", value: 1 }, 999999999, logPath, a);
        });
    });

    void it("throws on non-existent log path for outputLines", () => {
        const a = acc();
        assert.throws(() => {
            evaluateTrigger(
                { type: "outputLines", value: 1 },
                process.pid,
                "/nonexistent/path.log",
                a
            );
        });
    });

    void it("wallTime never throws", () => {
        const a = acc();
        assert.doesNotThrow(() => {
            evaluateTrigger(
                { type: "wallTime", value: 0 },
                999999, // bad PID but wallTime doesn't read /proc
                "/nonexistent",
                a
            );
        });
    });
});
