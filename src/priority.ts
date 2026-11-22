import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    spawn as nodeSpawn,
    type ChildProcess,
    type SpawnOptions,
} from "node:child_process";

export type PriorityMode = "off" | "elevate" | "demote";
export type DemotionMode = "nice" | "idle";

export interface PriorityConfig {
    mode: PriorityMode;
    demotion: DemotionMode;
    childNice: number;
}

export interface PriorityCounters {
    elevationApplied: number;
    elevationSkipped: Record<string, number>;
    childrenDemoted: number;
    demotionUnavailable: number;
}

export const priorityCounters: PriorityCounters = {
    elevationApplied: 0,
    elevationSkipped: {},
    childrenDemoted: 0,
    demotionUnavailable: 0,
};

export function resolvePriorityConfig(
    env: NodeJS.ProcessEnv = process.env,
    settingsPath = join(homedir(), ".pi", "agent", "settings.json")
): PriorityConfig {
    let setting: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
            string,
            unknown
        >;
        setting =
            parsed.tauPriority && typeof parsed.tauPriority === "object"
                ? (parsed.tauPriority as Record<string, unknown>)
                : {};
    } catch {
        /* optional settings file */
    }
    const modeRaw = env.PI_PRIORITY ?? setting.mode;
    const mode: PriorityMode =
        modeRaw === "off" || modeRaw === "elevate" || modeRaw === "demote"
            ? modeRaw
            : "elevate";
    const demotion = setting.demotion === "idle" ? "idle" : "nice";
    const childNice =
        typeof setting.childNice === "number" &&
        Number.isInteger(setting.childNice)
            ? Math.max(1, Math.min(19, setting.childNice))
            : 19;
    return { mode, demotion, childNice };
}

export function demoteCommand(
    cmd: string,
    args: readonly string[],
    config = resolvePriorityConfig()
): [string, string[]] {
    if (config.mode === "off") return [cmd, [...args]];
    return config.demotion === "idle"
        ? ["chrt", ["--idle", "0", "--", cmd, ...args]]
        : ["nice", ["-n", String(config.childNice), "--", cmd, ...args]];
}

export function spawnDemoted(
    cmd: string,
    args: readonly string[],
    options?: SpawnOptions,
    config = resolvePriorityConfig()
): ChildProcess {
    const [executable, argv] = demoteCommand(cmd, args, config);
    if (config.mode === "off")
        return nodeSpawn(executable, argv, options ?? {});
    try {
        const child = nodeSpawn(executable, argv, options ?? {});
        priorityCounters.childrenDemoted++;
        child.once("error", () => {
            priorityCounters.demotionUnavailable++;
        });
        return child;
    } catch (error) {
        priorityCounters.demotionUnavailable++;
        throw error;
    }
}

function skip(reason: string): void {
    priorityCounters.elevationSkipped[reason] =
        (priorityCounters.elevationSkipped[reason] ?? 0) + 1;
    console.error(`[pi-tau priority] elevation skipped: ${reason}`);
}

export async function elevateMainThread(
    config = resolvePriorityConfig(),
    platform = process.platform,
    limitsPath = "/proc/self/limits",
    run = (command: string, args: string[]) =>
        new Promise<void>((resolve, reject) => {
            const child = nodeSpawn(command, args, {
                stdio: "ignore",
                timeout: 250,
            });
            child.once("error", reject);
            child.once("exit", (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error(`${command} exit ${code}`))
            );
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`${command} timeout`));
            }, 250);
            timer.unref();
        })
): Promise<void> {
    if (config.mode === "off") return skip("disabled");
    if (config.mode === "demote") return skip("mode-demote");
    if (platform !== "linux") return skip("non-linux");
    let limits: string;
    try {
        limits = readFileSync(limitsPath, "utf8");
    } catch {
        return skip("limits-unavailable");
    }
    const line = limits
        .split("\n")
        .find((value) => value.startsWith("Max nice"));
    const hard = line?.trim().split(/\s+/).at(-1);
    const hardLimit = Number(hard);
    if (!Number.isFinite(hardLimit) || hardLimit <= 0)
        return skip("hard-limit-zero-or-invalid");
    try {
        await run("/usr/bin/prlimit", [
            "--pid",
            String(process.pid),
            `--nice=${hardLimit}:${hardLimit}`,
        ]);
        await run("/usr/bin/renice", ["-n", "0", "-p", String(process.pid)]);
        priorityCounters.elevationApplied++;
    } catch (error) {
        skip(
            error instanceof Error
                ? error.message.includes("timeout")
                    ? "exec-timeout"
                    : "exec-failed"
                : "exec-failed"
        );
    }
}
