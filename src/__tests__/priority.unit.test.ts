import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDemoted } from "../priority.ts";
import {
    demoteCommand,
    elevateMainThread,
    resolvePriorityConfig,
} from "../priority.ts";

const base = {
    mode: "demote" as const,
    demotion: "nice" as const,
    childNice: 19,
};

void test("priority demotion argv supports nice, idle, and off", () => {
    assert.deepEqual(demoteCommand("echo", ["hello"], base), [
        "nice",
        ["-n", "19", "--", "echo", "hello"],
    ]);
    assert.deepEqual(
        demoteCommand("echo", ["hello"], { ...base, demotion: "idle" }),
        ["chrt", ["--idle", "0", "--", "echo", "hello"]]
    );
    assert.deepEqual(
        demoteCommand("echo", ["hello"], { ...base, mode: "off" }),
        ["echo", ["hello"]]
    );
});

void test("priority settings use env override then settings defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "priority-settings-"));
    try {
        const path = join(dir, "settings.json");
        writeFileSync(
            path,
            JSON.stringify({ tauPriority: { mode: "demote", childNice: 15 } })
        );
        assert.deepEqual(resolvePriorityConfig({}, path), {
            mode: "demote",
            demotion: "nice",
            childNice: 15,
        });
        assert.equal(
            resolvePriorityConfig({ PI_PRIORITY: "off" }, path).mode,
            "off"
        );
        assert.equal(
            resolvePriorityConfig({}, join(dir, "absent")).mode,
            "elevate"
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("elevation skips unsupported platform and zero hard limit", async () => {
    await elevateMainThread(base, "darwin", "/missing", async () => {
        throw new Error("unexpected");
    });
    const limits = mkdtempSync(join(tmpdir(), "priority-limits-"));
    try {
        const path = join(limits, "limits");
        writeFileSync(path, "Max nice 0 0\n");
        await elevateMainThread(base, "linux", path, async () => {
            throw new Error("unexpected");
        });
    } finally {
        rmSync(limits, { recursive: true, force: true });
    }
});

void test("elevation records missing executable failures and continues", async () => {
    await elevateMainThread(base, "linux", "/proc/self/limits", async () => {
        throw new Error("ENOENT");
    });
});

void test("real demoted child has strictly lower scheduling priority than parent", async () => {
    await elevateMainThread({ ...base, mode: "elevate" });
    const child = spawnDemoted(
        process.execPath,
        [
            "-e",
            "const s=require('fs').readFileSync('/proc/self/stat','utf8'); console.log(s.slice(s.lastIndexOf(') ')+2).split(/\\s+/)[16])",
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
        base
    );
    const output = await new Promise<string>((resolve, reject) => {
        let data = "";
        child.stdout?.on("data", (chunk) => (data += chunk));
        child.once("error", reject);
        child.once("close", (code) =>
            code === 0
                ? resolve(data.trim())
                : reject(new Error(`child exit ${code}`))
        );
    });
    const parentStat = (await import("node:fs")).readFileSync(
        `/proc/${process.pid}/stat`,
        "utf8"
    );
    const parentNice = Number(
        parentStat.slice(parentStat.lastIndexOf(") ") + 2).split(/\s+/)[16]
    );
    assert.ok(
        Number(output) > parentNice,
        `child nice ${output} should be greater than parent nice ${parentNice}`
    );
});
