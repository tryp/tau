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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    });
});

void describe("startNoOutputWatchdog", () => {
    const makeLog = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "tau-no-output-"));
        return join(dir, "job.log");
    };

    void it("fires once after the stall budget of silence", async () => {
        const logPath = makeLog();
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            120,
            () => {
                fired += 1;
            },
            30
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        cancel();
        assert.equal(fired, 1);
    });

    void it("does not fire while the log keeps growing", async () => {
        const logPath = makeLog();
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            200,
            () => {
                fired += 1;
            },
            30
        );
        for (let i = 0; i < 8; i++) {
            // Append distinct-length lines so the file size grows each write.
            writeFileSync(
                logPath,
                `"${logPath}" line ${i} ${"x".repeat(i + 1)}\n`,
                { flag: "a" }
            );
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        cancel();
        assert.equal(fired, 0);
    });

    void it("does not fire after cancel", async () => {
        const logPath = makeLog();
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            100,
            () => {
                fired += 1;
            },
            30
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        cancel();
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(fired, 0);
    });

    void it("treats a missing log file as no output", async () => {
        const logPath = makeLog(); // never written
        let fired = 0;
        const cancel = startNoOutputWatchdog(
            logPath,
            120,
            () => {
                fired += 1;
            },
            30
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        cancel();
        assert.equal(fired, 1);
    });
});
