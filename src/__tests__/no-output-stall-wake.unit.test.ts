/**
 * Tests for the non-interactive foreground no-output watchdog.
 *
 * Incident: a subagent worker ran a gate test that deadlocked (0% CPU, futex
 * wait, zero output). The bash tool's auto-background timer deliberately
 * no-ops in non-interactive sessions, so nothing ever returned a tool result:
 * the worker hung for 14h and its parent session hung on the sync subagent
 * call for the same duration.
 *
 * Contract: resolveNonInteractiveStallWakeMs resolves the configurable budget
 * (default 4 minutes, PI_TAU_STALL_WAKE_MS override), and startNoOutputWatchdog
 * fires exactly once after the budget of no output growth, stays silent while
 * the log grows, and can be cancelled.
 */

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    NONINTERACTIVE_STALL_WAKE_MS,
    resolveNonInteractiveStallWakeMs,
} from "../utils.ts";
import { startNoOutputWatchdog } from "../features/background.ts";

void describe("resolveNonInteractiveStallWakeMs", () => {
    void it("defaults to 4 minutes", () => {
        assert.equal(
            resolveNonInteractiveStallWakeMs({}),
            NONINTERACTIVE_STALL_WAKE_MS
        );
        assert.equal(NONINTERACTIVE_STALL_WAKE_MS, 240_000);
    });

    void it("honours PI_TAU_STALL_WAKE_MS override", () => {
        assert.equal(
            resolveNonInteractiveStallWakeMs({ PI_TAU_STALL_WAKE_MS: "30000" }),
            30_000
        );
    });

    void it("falls back to the default on invalid overrides", () => {
        assert.equal(
            resolveNonInteractiveStallWakeMs({ PI_TAU_STALL_WAKE_MS: "abc" }),
            NONINTERACTIVE_STALL_WAKE_MS
        );
        assert.equal(
            resolveNonInteractiveStallWakeMs({ PI_TAU_STALL_WAKE_MS: "0" }),
            NONINTERACTIVE_STALL_WAKE_MS
        );
        assert.equal(
            resolveNonInteractiveStallWakeMs({ PI_TAU_STALL_WAKE_MS: "-5" }),
            NONINTERACTIVE_STALL_WAKE_MS
        );
        assert.equal(
            resolveNonInteractiveStallWakeMs({ PI_TAU_STALL_WAKE_MS: "1e6" }),
            NONINTERACTIVE_STALL_WAKE_MS
        );
        assert.equal(
            resolveNonInteractiveStallWakeMs({
                PI_TAU_STALL_WAKE_MS: "5000abc",
            }),
            NONINTERACTIVE_STALL_WAKE_MS
        );
    });
});

void describe("startNoOutputWatchdog", () => {
    const tempDirs: string[] = [];
    const makeLog = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "tau-no-output-"));
        tempDirs.push(dir);
        return join(dir, "job.log");
    };

    beforeEach(() => {
        mock.timers.enable({ apis: ["setInterval", "Date"] });
    });

    afterEach(() => {
        mock.timers.reset();
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("fires once after the stall budget of silence", () => {
        const logPath = makeLog();
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            400,
            () => {
                fired += 1;
            },
            50
        );
        for (let i = 0; i < 8; i++) mock.timers.tick(50);
        assert.equal(fired, 1);
        mock.timers.tick(500);
        assert.equal(fired, 1, "a fired watchdog must clear its interval");
        cancel();
    });

    void it("does not fire while the log keeps growing", () => {
        const logPath = makeLog();
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            500,
            () => {
                fired += 1;
            },
            50
        );
        for (let i = 0; i < 8; i++) {
            // Append distinct-length lines before each tick so growth is
            // observed at every interval, even when all lines have similar text.
            writeFileSync(logPath, `line ${i} ${"x".repeat(i + 1)}\n`, {
                flag: "a",
            });
            mock.timers.tick(50);
        }
        assert.equal(fired, 0);
        cancel();
    });

    void it("fires when an existing log stops growing", () => {
        const logPath = makeLog();
        writeFileSync(logPath, "initial output\n");
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            400,
            () => {
                fired += 1;
            },
            50
        );
        // The first tick establishes the existing file size as the baseline.
        for (let i = 0; i < 9; i++) mock.timers.tick(50);
        assert.equal(fired, 1);
        cancel();
    });

    void it("does not fire after cancel", () => {
        const logPath = makeLog();
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            400,
            () => {
                fired += 1;
            },
            50
        );
        mock.timers.tick(50);
        cancel();
        mock.timers.tick(800);
        assert.equal(fired, 0);
    });

    void it("treats a missing log file as no output", () => {
        const logPath = makeLog(); // never written
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            400,
            () => {
                fired += 1;
            },
            50
        );
        for (let i = 0; i < 8; i++) mock.timers.tick(50);
        assert.equal(fired, 1);
        cancel();
    });
});
