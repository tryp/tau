import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

const root = process.cwd();
const tempDirs: string[] = [];
afterEach(() =>
    tempDirs
        .splice(0)
        .forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);

function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "pi-tau-ledger-"));
    tempDirs.push(dir);
    return dir;
}

function stubAnalyzer(dir: string) {
    const script = join(dir, "scripts", "record-deploy");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
        script,
        '#!/bin/sh\nprintf "%s\\n" "$PWD" > "$LEDGER_CALL"\n'
    );
    chmodSync(script, 0o755);
}

void test("deploy wires ledger recording after the successful verify and smoke-test path", () => {
    const result = spawnSync("make", ["--no-print-directory", "-n", "deploy"], {
        cwd: root,
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /record-deploy-ledger/);
    assert.ok(
        result.stdout.indexOf("smoke-test") <
            result.stdout.indexOf("record-deploy-ledger")
    );
});

void test("ledger recording runs from this checkout and skips cleanly without analyzer", () => {
    const analyzer = tempDir();
    const log = join(tempDir(), "called");
    stubAnalyzer(analyzer);
    const called = spawnSync(
        "make",
        [
            "--no-print-directory",
            "record-deploy-ledger",
            `PI_SESSION_ANALYSIS_DIR=${analyzer}`,
        ],
        {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, LEDGER_CALL: log },
        }
    );
    assert.equal(called.status, 0, called.stderr);
    assert.equal(readFileSync(log, "utf8").trim(), root);

    const missing = spawnSync(
        "make",
        [
            "--no-print-directory",
            "record-deploy-ledger",
            `PI_SESSION_ANALYSIS_DIR=${join(tempDir(), "missing")}`,
        ],
        {
            cwd: root,
            encoding: "utf8",
        }
    );
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(
        missing.stdout,
        /Skipping deploy ledger recording: pi-session-analysis recorder not found/
    );

    const skipped = spawnSync(
        "make",
        [
            "--no-print-directory",
            "record-deploy-ledger",
            `PI_SESSION_ANALYSIS_DIR=${analyzer}`,
        ],
        {
            cwd: root,
            encoding: "utf8",
            env: {
                ...process.env,
                SKIP_DEPLOY_LEDGER: "1",
                LEDGER_CALL: join(analyzer, "should-not-call"),
            },
        }
    );
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(
        skipped.stdout,
        /Skipping deploy ledger recording \(SKIP_DEPLOY_LEDGER=1\)/
    );
    assert.equal(existsSync(join(analyzer, "should-not-call")), false);
});
