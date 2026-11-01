import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the private cache directory used for stage-0 pipeline captures. */
export function stageZeroDirectory(
    env: NodeJS.ProcessEnv = process.env,
    home = homedir()
): string {
    const cacheHome = env.XDG_CACHE_HOME || join(home, ".cache");
    return join(cacheHome, "pi-tau", "stage0");
}

export function stageZeroPathFor(
    toolCallId: string,
    directory = stageZeroDirectory()
): string {
    const bare = toolCallId.replace(/[^A-Za-z0-9_-]/g, "");
    return join(directory, `pi-pipe-stage0-${bare}.log`);
}
