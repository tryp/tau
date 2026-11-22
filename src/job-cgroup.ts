import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface JobCgroupResult {
    ok: boolean;
    reason: string;
    path?: string;
}

export type JobCgroupEntry = (customType: string, data: unknown) => void;
export type JobCgroupJoiner = (
    pid: number,
    appendEntry?: JobCgroupEntry
) => JobCgroupResult;

export function resolveJobCgroup(
    value = process.env.PI_JOB_CGROUP
): string | undefined {
    if (!value || !isAbsolute(value)) return undefined;
    try {
        if (!existsSync(value) || !statSync(value).isDirectory()) {
            return undefined;
        }
        return value;
    } catch {
        return undefined;
    }
}

export function tierStatus(): JobCgroupResult {
    const value = process.env.PI_JOB_CGROUP;
    if (!value) return { ok: false, reason: "PI_JOB_CGROUP is unset" };
    if (!isAbsolute(value)) {
        return { ok: false, reason: "PI_JOB_CGROUP must be an absolute path" };
    }
    try {
        if (!existsSync(value) || !statSync(value).isDirectory()) {
            return {
                ok: false,
                reason: "PI_JOB_CGROUP is not an existing directory",
                path: value,
            };
        }
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
            path: value,
        };
    }
    return { ok: true, reason: "available", path: value };
}

export function joinJobCgroup(
    pid: number,
    appendEntry?: JobCgroupEntry,
    env: NodeJS.ProcessEnv = process.env,
    write: (path: string, data: string) => void = writeFileSync
): JobCgroupResult {
    const value = env.PI_JOB_CGROUP;
    let result: JobCgroupResult;
    if (!value) {
        result = { ok: false, reason: "PI_JOB_CGROUP is unset" };
    } else if (!isAbsolute(value)) {
        result = {
            ok: false,
            reason: "PI_JOB_CGROUP must be an absolute path",
        };
    } else if (pid === process.pid) {
        result = {
            ok: false,
            reason: "refusing to join pi's own process",
            path: value,
        };
    } else {
        try {
            if (!existsSync(value) || !statSync(value).isDirectory()) {
                result = {
                    ok: false,
                    reason: "PI_JOB_CGROUP is not an existing directory",
                    path: value,
                };
            } else {
                write(join(value, "cgroup.procs"), `${pid}\n`);
                result = { ok: true, reason: "joined", path: value };
            }
        } catch (error) {
            result = {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
                path: value,
            };
        }
    }

    try {
        appendEntry?.("pi-tier-join", {
            pid,
            ok: result.ok,
            reason: result.reason,
        });
    } catch {
        // Join failures and diagnostic recording must never block a child spawn.
    }
    return result;
}
