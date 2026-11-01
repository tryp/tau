/** Schedule background-job restore after session_start has returned. */
export function scheduleBackgroundJobRestore(
    restore: () => void,
    delayMs = 100
): ReturnType<typeof setTimeout> {
    const timer = setTimeout(restore, delayMs);
    timer.unref?.();
    return timer;
}
