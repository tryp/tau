import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    appendFileSync,
    statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    classifyLine,
    countLines,
    firstErrorLine,
    JobLogEvidenceTracker,
    MAX_LOG_SCAN_BYTES,
} from "../features/log-classify.ts";

const dirs: string[] = [];

void describe("log severity classifier", () => {
    void it("matches phase-1 strong errors and warning cases", () => {
        for (const line of [
            "Traceback (most recent call last):",
            "Traceback (innermost last):",
            "ERROR: database unavailable",
            "[FATAL] process exited",
            "TypeError: bad input",
            "panic: runtime error",
            "Unhandled exception occurred",
            "segmentation fault",
        ])
            assert.equal(classifyLine(line), "err", line);

        for (const line of [
            "WARN retrying",
            "[WARNING] delayed",
            "Deprecated API",
            "build failed",
        ]) {
            assert.equal(classifyLine(line), "warn", line);
        }
        assert.equal(classifyLine("0 errors, tests passed"), null);
        assert.equal(classifyLine("error handler tests passed"), null);
        assert.equal(classifyLine("read /tmp/errors.log"), null);
    });

    void it("counts every line and ignores a final newline as an extra line", () => {
        assert.deepEqual(countLines("ERROR: bad\nWARN retry\ninfo\n"), {
            err: 1,
            warn: 1,
            total: 3,
        });
        assert.deepEqual(countLines(""), { err: 0, warn: 0, total: 0 });
    });

    void it("returns only a capped first strong-error line", () => {
        assert.equal(
            firstErrorLine("info\nERROR: " + "x".repeat(200), 12),
            "ERROR: xxxxx"
        );
        assert.equal(firstErrorLine("WARN failed\ninfo"), undefined);
    });
});

void describe("JobLogEvidenceTracker", () => {
    function fixture() {
        const dir = mkdtempSync(join(tmpdir(), "tau-log-evidence-"));
        dirs.push(dir);
        return { dir, log: join(dir, "job.log") };
    }

    void it("tracks cumulative counts and deltas by byte offset", () => {
        const { log } = fixture();
        writeFileSync(log, "INFO started\nERROR: failed\n");
        const tracker = new JobLogEvidenceTracker();
        const first = tracker.scan("job-1", log);
        assert.deepEqual(first?.counts, { err: 1, warn: 0, total: 2 });
        assert.deepEqual(first?.delta, { err: 1, warn: 0, total: 2 });
        assert.equal(first?.firstError, "ERROR: failed");

        appendFileSync(log, "WARN retrying\nINFO done\n");
        const second = tracker.scan("job-1", log);
        assert.deepEqual(second?.counts, { err: 1, warn: 1, total: 4 });
        assert.deepEqual(second?.delta, { err: 0, warn: 1, total: 2 });
        assert.equal(second?.grew, true);
    });

    void it("resets counts and offset when the log shrinks", () => {
        const { log } = fixture();
        writeFileSync(log, "INFO long line\nWARN another\n");
        const tracker = new JobLogEvidenceTracker();
        tracker.scan("job-2", log);
        writeFileSync(log, "ERROR: replacement\n");
        const after = tracker.scan("job-2", log);
        assert.equal(after?.rotated, true);
        assert.deepEqual(after?.counts, { err: 1, warn: 0, total: 1 });
        assert.deepEqual(after?.delta, { err: 1, warn: 0, total: 1 });
    });

    void it("caps each scan and carries the offset forward", () => {
        const { log } = fixture();
        writeFileSync(
            log,
            "INFO line\n".repeat(Math.ceil(MAX_LOG_SCAN_BYTES / 10) + 100)
        );
        const tracker = new JobLogEvidenceTracker();
        const first = tracker.scan("job-3", log);
        assert.equal(first?.truncated, true);
        const second = tracker.scan("job-3", log);
        assert.equal(second?.truncated, false);
        assert.ok(
            second?.counts.total &&
                second.counts.total > (first?.counts.total ?? 0)
        );
        assert.equal(statSync(log).size, first?.fileSize);
    });

    void it("finalizes an unterminated final line once", () => {
        const { log } = fixture();
        writeFileSync(log, "ERROR: final");
        const tracker = new JobLogEvidenceTracker();
        assert.equal(tracker.scan("job-4", log)?.counts.total, 0);
        const final = tracker.scan("job-4", log, true);
        assert.deepEqual(final?.counts, { err: 1, warn: 0, total: 1 });
        assert.deepEqual(tracker.scan("job-4", log, true)?.delta, {
            err: 0,
            warn: 0,
            total: 0,
        });
    });

    void it("fails open for missing files", () => {
        const tracker = new JobLogEvidenceTracker();
        assert.equal(tracker.scan("gone", "/tmp/no-such-log"), undefined);
    });
});

afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
