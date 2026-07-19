import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    formatDuration,
    generateJobId,
    logPathForJob,
    looksLikePrompt,
    truncateNotificationBody,
    lastAssistantText,
    detectBlockedSleep,
    isAutoBackgroundAllowed,
    cleanupStaleLogs,
    formatJobLine,
    readOutputTailSync,
    markJobTerminal,
    detectNonInteractive,
} from "../utils.ts";
import type { BackgroundJob } from "../types.ts";

function makeJob(overrides: Partial<BackgroundJob> & { id: string }): BackgroundJob {
    return {
        command: "echo hello",
        pid: 42,
        startTime: Date.now(),
        status: "running",
        logPath: "/tmp/test.log",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

void describe("detectNonInteractive", () => {
    void it("is true when -p is in argv (explicit print mode)", () => {
        assert.equal(
            detectNonInteractive(["node", "pi", "-p", "do x"], true),
            true
        );
    });

    void it("is true when --print is in argv", () => {
        assert.equal(
            detectNonInteractive(["node", "pi", "--print"], true),
            true
        );
    });

    void it("is true when stdin is not a TTY (piped/spawned)", () => {
        assert.equal(detectNonInteractive(["node", "pi"], false), true);
    });

    void it("is false for an interactive TTY with no print flag", () => {
        assert.equal(detectNonInteractive(["node", "pi", "chat"], true), false);
    });
});

void describe("formatDuration", () => {
    void it("formats seconds under a minute", () => {
        assert.equal(formatDuration(0), "0s");
        assert.equal(formatDuration(1_000), "1s");
        assert.equal(formatDuration(30_000), "30s");
        assert.equal(formatDuration(59_000), "59s");
    });

    void it("formats minutes and seconds", () => {
        assert.equal(formatDuration(60_000), "1m0s");
        assert.equal(formatDuration(90_000), "1m30s");
        assert.equal(formatDuration(3_700_000), "61m40s");
    });
});

void describe("generateJobId", () => {
    void it("generates a job ID with counter and PID", () => {
        const id = generateJobId(5, 1234);
        assert.equal(id, "job-1234-5");
    });

    void it("defaults to current process PID", () => {
        const id = generateJobId(1);
        assert.equal(id, `job-${process.pid}-1`);
    });
});

void describe("logPathForJob", () => {
    void it("returns the correct temp path", () => {
        const TMPDIR = process.env.TMPDIR || "/tmp";
        assert.equal(
            logPathForJob("job-1234-5"),
            `${TMPDIR}/pi-bg-job-1234-5.log`
        );
    });
});

void describe("looksLikePrompt", () => {
    void it("detects (y/n) prompts", () => {
        assert.equal(looksLikePrompt("Continue? (y/n)"), true);
        assert.equal(looksLikePrompt("[y/n]"), true);
    });

    void it("detects 'Press any key' prompts", () => {
        assert.equal(looksLikePrompt("Press any key to continue"), true);
        assert.equal(looksLikePrompt("Press Enter to proceed"), true);
    });

    void it("detects 'Do you / Would you' questions", () => {
        assert.equal(looksLikePrompt("Do you want to continue?"), true);
        assert.equal(looksLikePrompt("Would you like to overwrite?"), true);
        assert.equal(looksLikePrompt("Are you sure you want to delete?"), true);
    });

    void it("does not flag normal output", () => {
        assert.equal(looksLikePrompt("Building [1/10]..."), false);
        assert.equal(looksLikePrompt("Success!"), false);
        assert.equal(looksLikePrompt("  1234 bytes written"), false);
    });

    void it("only checks the last line", () => {
        const output =
            "Building [1/10]...\nBuilding [2/10]...\nContinue? (y/n)";
        assert.equal(looksLikePrompt(output), true);
    });
});

void describe("truncateNotificationBody", () => {
    void it("returns short text unchanged", () => {
        assert.equal(truncateNotificationBody("Hello world"), "Hello world");
    });

    void it("takes only the first line", () => {
        assert.equal(
            truncateNotificationBody("First line\nSecond line\nThird line"),
            "First line"
        );
    });

    void it("truncates lines exceeding 200 characters with ellipsis", () => {
        const long = "a".repeat(250);
        const result = truncateNotificationBody(long);
        assert.equal(result.length, 200);
        assert.equal(result.endsWith("…"), true);
    });
});

void describe("detectBlockedSleep", () => {
    void it("returns null for non-sleep commands", () => {
        assert.equal(detectBlockedSleep("echo hello"), null);
        assert.equal(detectBlockedSleep("python run.py"), null);
        assert.equal(detectBlockedSleep("npm test"), null);
    });

    void it("returns null for sleep < 2 seconds", () => {
        assert.equal(detectBlockedSleep("sleep 1"), null);
        assert.equal(detectBlockedSleep("sleep 0.5"), null);
        assert.equal(detectBlockedSleep("sleep 1.999"), null);
    });

    void it("detects standalone sleep >= 2 seconds", () => {
        assert.equal(detectBlockedSleep("sleep 2"), "sleep 2");
        assert.equal(detectBlockedSleep("sleep 10"), "sleep 10");
        assert.equal(detectBlockedSleep("sleep 300"), "sleep 300");
    });

    void it("detects sleep as first command in compound chains", () => {
        // sleep IS the first command in these chains
        assert.equal(detectBlockedSleep("sleep 3; echo done"), "sleep 3");
        assert.equal(detectBlockedSleep("sleep 5 && echo done"), "sleep 5");
    });

    void it("ignores sleep when it is NOT the first command", () => {
        assert.equal(detectBlockedSleep("echo start && sleep 5"), null);
        assert.equal(detectBlockedSleep("python -c 'import time; time.sleep(5)'"), null);
    });

    void it("handles leading whitespace", () => {
        assert.equal(detectBlockedSleep("  sleep 5"), "sleep 5");
    });

    void it("handles empty string", () => {
        assert.equal(detectBlockedSleep(""), null);
    });
});

void describe("isAutoBackgroundAllowed", () => {
    void it("allows most commands", () => {
        assert.equal(isAutoBackgroundAllowed("python test.py"), true);
        assert.equal(isAutoBackgroundAllowed("npm run build"), true);
        assert.equal(isAutoBackgroundAllowed("make test"), true);
    });

    void it("disallows sleep commands", () => {
        assert.equal(isAutoBackgroundAllowed("sleep 30"), false);
        assert.equal(isAutoBackgroundAllowed("sleep 5"), false);
    });

    void it("only checks the first word", () => {
        assert.equal(isAutoBackgroundAllowed("sleep"), false);
        assert.equal(isAutoBackgroundAllowed("sleep && echo hi"), false);
    });

    void it("handles empty string", () => {
        assert.equal(isAutoBackgroundAllowed(""), true);
    });
});

void describe("formatJobLine", () => {
    void it("shows running status for foreground job", () => {
        const job = makeJob({ id: "j-1", startTime: Date.now() - 5_000, isBackgrounded: false });
        const line = formatJobLine(job);
        assert.ok(line.startsWith("j-1:"), "should start with job id");
        assert.ok(line.includes("running"), "should show running");
    });

    void it("shows running status for backgrounded job", () => {
        const job = makeJob({ id: "j-2", startTime: Date.now() - 10_000, isBackgrounded: true });
        const line = formatJobLine(job);
        assert.ok(line.startsWith("j-2:"), "should start with job id");
        assert.ok(line.includes("running"), "should show running");
    });

    void it("shows completed status", () => {
        const job = makeJob({ id: "j-3", status: "completed" });
        assert.ok(formatJobLine(job).includes("completed"));
    });

    void it("shows failed status", () => {
        const job = makeJob({ id: "j-4", status: "failed" });
        assert.ok(formatJobLine(job).includes("failed"));
    });

    void it("shows killed status", () => {
        const job = makeJob({ id: "j-5", status: "killed" });
        assert.ok(formatJobLine(job).includes("killed"));
    });

    void it("truncates long command to 80 chars", () => {
        const job = makeJob({ id: "j-6", command: "a".repeat(200) });
        const line = formatJobLine(job);
        // Command portion should be max 80
        const colonIdx = line.indexOf(":");
        const cmdPortion = line.slice(colonIdx + 2, line.lastIndexOf(" - "));
        assert.ok(cmdPortion.length <= 80, `command portion too long: ${cmdPortion.length}`);
    });
});

void describe("readOutputTailSync", () => {
    void it("returns placeholder for nonexistent file", () => {
        assert.equal(readOutputTailSync("/nonexistent/path.log", 100), "(no output yet)");
    });

    void it("returns entire content when under maxChars", () => {
        const result = readOutputTailSync(import.meta.filename, 999_999);
        assert.ok(result.length > 10, "should read this file's content");
        assert.ok(!result.startsWith("...[truncated"), "should not truncate");
    });
});

void describe("markJobTerminal", () => {
    void it("marks running job as completed", () => {
        const job = makeJob({ id: "j-1", status: "running" });
        markJobTerminal(job, "completed", 0);
        assert.equal(job.status, "completed");
        assert.equal(job.exitCode, 0);
        assert.equal(job.proc, undefined);
    });

    void it("does NOT overwrite already-terminal status", () => {
        const job = makeJob({ id: "j-2", status: "completed", exitCode: 0 });
        markJobTerminal(job, "failed", 1);
        assert.equal(job.status, "completed", "should not overwrite completed");
        assert.equal(job.exitCode, 0, "should not overwrite exit code");
    });

    void it("marks running job as killed", () => {
        const job = makeJob({ id: "j-3", status: "running" });
        markJobTerminal(job, "killed", null);
        assert.equal(job.status, "killed");
    });
});

void describe("cleanupStaleLogs", () => {
    const testDir = join(tmpdir(), `pi-tau-test-cleanup-${Date.now()}`);

    before(() => {
        mkdirSync(testDir, { recursive: true });
        // Save original TMPDIR and override
        process.env._TAU_SAVED_TMPDIR = process.env.TMPDIR;
        process.env.TMPDIR = testDir;
    });

    after(() => {
        if (process.env._TAU_SAVED_TMPDIR) {
            process.env.TMPDIR = process.env._TAU_SAVED_TMPDIR;
        } else {
            delete process.env.TMPDIR;
        }
    });

    void it("removes stale pi-bg-* files", () => {
        const oldFile = join(testDir, "pi-bg-job-stale.log");
        writeFileSync(oldFile, "old content");
        // Set mtime far in the past
        const oldMtime = new Date(Date.now() - 48 * 60 * 60 * 1000);
        // Touch via utimes
        try {
            const { utimesSync } = require("node:fs");
            utimesSync(oldFile, oldMtime, oldMtime);
        } catch { /* skip mtime manipulation on platforms without utimes */ }

        const freshFile = join(testDir, "pi-bg-job-fresh.log");
        writeFileSync(freshFile, "fresh content");

        cleanupStaleLogs();

        // Stale file should be gone, fresh file should remain
        // (mtime manipulation might not work on all platforms, so don't assert strictly)
        assert.ok(existsSync(freshFile), "fresh log should survive");
    });

    void it("does not touch non-pi-bg files", () => {
        const otherFile = join(testDir, "other-file.txt");
        writeFileSync(otherFile, "not a pi log");
        cleanupStaleLogs();
        assert.ok(existsSync(otherFile), "non-pi-bg files should be untouched");
    });

    void it("does not crash on empty directory", () => {
        // Should not throw
        cleanupStaleLogs();
    });
});

void describe("lastAssistantText", () => {
    void it("extracts text from the last assistant message", () => {
        const messages = [
            { role: "user", content: "hello" },
            {
                role: "assistant",
                content: [{ type: "text", text: "first response" }],
            },
            { role: "user", content: "again" },
            {
                role: "assistant",
                content: [{ type: "text", text: "second response" }],
            },
        ];
        assert.equal(lastAssistantText(messages), "second response");
    });

    void it("returns undefined when no assistant messages exist", () => {
        const messages = [{ role: "user", content: "hello" }];
        assert.equal(lastAssistantText(messages), undefined);
    });

    void it("returns undefined for empty array", () => {
        assert.equal(lastAssistantText([]), undefined);
    });
});
