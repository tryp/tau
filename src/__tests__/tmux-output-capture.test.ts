/**
 * Tests for tmux output capture reliability.
 *
 * Bug 1 (tau): the wrapper script used `(command) 2>&1 | tee -a "$__output_file"`,
 * which loses output ~28% of the time because tee never receives data from
 * the pipe (race with tmux PTY setup).
 *
 * Fix: redirect the subshell directly to the output file without any pipe.
 *
 * Bug 2 (pi core): waitForChildProcess calls stdout.destroy() unconditionally
 * 100ms after exit, discarding buffered data still in the kernel pipe.
 * Fix: gate destroy() on process.platform === "win32".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBashScript } from "../tmux.ts";

const RUN_DIR = "/tmp/pi-test-script-gen";
const SESSION = "pi-test-script-gen";

void describe("createBashScript output capture", () => {
    void it("does not use tee or pipes for output capture", () => {
        // The old pattern was: (command) 2>&1 | tee -a "$__output_file"
        // The fix must eliminate the pipe-through-tee pattern.
        const paths = {
            id: "test-id",
            outputFile: `${RUN_DIR}/${SESSION}.test-id.out`,
            exitCodeFile: `${RUN_DIR}/${SESSION}.test-id.exit`,
        };

        const { scriptPath } = createBashScript(
            RUN_DIR,
            SESSION,
            "echo hello",
            paths
        );
        const script = readFileSync(scriptPath, "utf-8");

        assert.ok(
            !script.includes("| tee"),
            `script must not pipe through tee. Got:\n${script}`
        );
        assert.ok(
            !script.includes("PIPESTATUS"),
            `script must not use PIPESTATUS (no pipe). Got:\n${script}`
        );
        // Must redirect subshell output directly to the output file
        assert.ok(
            script.includes(">>") || script.includes(">"),
            `script must redirect subshell output to file. Got:\n${script}`
        );
    });

    void it("records owner and wrapper boot-id/start-tick identity for orphan reaping", () => {
        const paths = {
            id: "owner-test",
            outputFile: `${RUN_DIR}/${SESSION}.owner-test.out`,
            exitCodeFile: `${RUN_DIR}/${SESSION}.owner-test.exit`,
            owner: { pid: 123, ppid: 1, bootId: "boot-id", startTicks: "456" },
        };
        const { scriptPath } = createBashScript(
            RUN_DIR,
            SESSION,
            "echo hello",
            paths
        );
        const script = readFileSync(scriptPath, "utf-8");
        assert.ok(script.includes('"pid":123'));
        assert.ok(script.includes('"bootId":"boot-id"'));
        assert.ok(script.includes("/proc/$$/stat"));
        assert.ok(script.includes("/proc/sys/kernel/random/boot_id"));
        assert.ok(script.includes(`${SESSION}.owner-test.owner.json`));
    });

    void it("captures both stdout and stderr", () => {
        const paths = {
            id: "test-id",
            outputFile: `${RUN_DIR}/${SESSION}.test-id.out`,
            exitCodeFile: `${RUN_DIR}/${SESSION}.test-id.exit`,
        };

        const { scriptPath } = createBashScript(
            RUN_DIR,
            SESSION,
            "echo hello",
            paths
        );
        const script = readFileSync(scriptPath, "utf-8");

        // The redirect must include stderr (2>&1 equivalent)
        assert.ok(
            script.includes("2>&1") || script.includes("&>"),
            `script must capture stderr. Got:\n${script}`
        );
    });

    void it("captures the subshell exit code directly", () => {
        const paths = {
            id: "test-id",
            outputFile: `${RUN_DIR}/${SESSION}.test-id.out`,
            exitCodeFile: `${RUN_DIR}/${SESSION}.test-id.exit`,
        };

        const { scriptPath } = createBashScript(
            RUN_DIR,
            SESSION,
            "exit 42",
            paths
        );
        const script = readFileSync(scriptPath, "utf-8");

        // Must capture $? directly, not PIPESTATUS[0]
        assert.ok(
            script.includes("$?"),
            `script must capture exit code via $?. Got:\n${script}`
        );
        assert.ok(
            !script.includes("PIPESTATUS"),
            `script must not use PIPESTATUS. Got:\n${script}`
        );
    });
});
