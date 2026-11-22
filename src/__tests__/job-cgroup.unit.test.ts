import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinJobCgroup, resolveJobCgroup } from "../job-cgroup.ts";
import { spawnBashProcess } from "../features/background.ts";
import { spawnAndJoinAgentProcess } from "../features/agent-background.ts";
import { spawnAndJoinWorkflowAgent } from "../features/workflow.ts";

void describe("job cgroup tier", () => {
    void it("passes the direct bash_bg child pid to the join helper", async () => {
        let joinedPid: number | undefined;
        const child = spawnBashProcess(
            "exit 0",
            process.cwd(),
            { stdio: "ignore" },
            (pid) => {
                joinedPid = pid;
                return { ok: true, reason: "test" };
            }
        );
        assert.ok(child.pid);
        assert.equal(joinedPid, child.pid);
        await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", () => resolve());
        });
    });

    void it("passes the detached agent child pid to the join helper", async () => {
        let joinedPid: number | undefined;
        const child = spawnAndJoinAgentProcess(
            process.execPath,
            ["-e", "process.exit(0)"],
            process.cwd(),
            (pid) => {
                joinedPid = pid;
                return { ok: true, reason: "test" };
            }
        );
        assert.ok(child.pid);
        assert.equal(joinedPid, child.pid);
        await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", () => resolve());
        });
    });

    void it("passes the workflow agent child pid to the join helper", async () => {
        let joinedPid: number | undefined;
        const child = spawnAndJoinWorkflowAgent(
            process.execPath,
            ["-e", "process.exit(0)"],
            process.cwd(),
            (pid) => {
                joinedPid = pid;
                return { ok: true, reason: "test" };
            }
        );
        assert.ok(child.pid);
        assert.equal(joinedPid, child.pid);
        await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", () => resolve());
        });
    });

    void it("writes the child pid and records the join result", () => {
        const writes: Array<{ path: string; value: string }> = [];
        const entries: Array<{ type: string; data: unknown }> = [];
        const cgroup = mkdtempSync(join(tmpdir(), "pi-job-cgroup-test-"));
        const result = joinJobCgroup(
            4242,
            (type, data) => entries.push({ type, data }),
            { PI_JOB_CGROUP: cgroup },
            (path, value) => writes.push({ path, value })
        );
        assert.deepEqual(result, {
            ok: true,
            reason: "joined",
            path: cgroup,
        });
        assert.deepEqual(writes, [
            { path: `${cgroup}/cgroup.procs`, value: "4242\n" },
        ]);
        assert.deepEqual(entries, [
            {
                type: "pi-tier-join",
                data: { pid: 4242, ok: true, reason: "joined" },
            },
        ]);
        rmSync(cgroup, { recursive: true, force: true });
    });

    void it("reports an invalid tier without throwing, and records it", () => {
        let recorded: unknown;
        assert.doesNotThrow(() => {
            recorded = joinJobCgroup(4242, (_type, data) => (recorded = data), {
                PI_JOB_CGROUP: "relative/path",
            });
        });
        assert.equal((recorded as { ok: boolean }).ok, false);
        assert.equal(typeof (recorded as { reason: string }).reason, "string");
        assert.equal(resolveJobCgroup("relative/path"), undefined);
    });

    void it("records nothing per spawn when no tier is configured", () => {
        // Unset is the default configuration, not a failure. Recording it on
        // every spawn put an entry in the session for every bash_bg, agent and
        // workflow launch of every flat session; the startup record covers it.
        const entries: unknown[] = [];
        const result = joinJobCgroup(
            4242,
            (_type, data) => entries.push(data),
            {}
        );
        assert.equal(result.ok, false);
        assert.equal(result.reason, "PI_JOB_CGROUP is unset");
        assert.deepEqual(entries, []);
    });
});
