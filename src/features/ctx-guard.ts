/**
 * Guard against pi's stale-extension-context assertion escaping deferred
 * callbacks (timers and promises) and killing the host process.
 *
 * When the session is replaced (ctx.newSession()/fork()/switchSession()) or
 * extensions are reloaded (ctx.reload()), pi invalidates the ExtensionAPI and
 * command contexts captured by in-flight executions. Every subsequent
 * action-method call or guarded-getter access throws
 *
 *   "This extension ctx is stale after session replacement or reload..."
 *
 * If that throw happens inside a setTimeout/setInterval callback or a promise
 * chain, it surfaces as an uncaughtException / unhandledRejection and pi
 * terminates (session analysis: 9-hour GPU session crashed on
 * bash-tmux.ts poll timer after a reload while a tmux job was still running).
 *
 * These helpers convert the assertion into a defined "stale" outcome so
 * deferred callbacks can fall back to cleanup that does not need pi
 * (kill tmux windows, clear timers, drop delivery) instead of crashing.
 * Non-stale errors are rethrown so real bugs stay visible.
 */

const STALE_CTX_ERROR =
    /extension ctx is stale after session replacement or reload/i;

/**
 * True when the error is pi's stale-extension-ctx assertion (see loader.js
 * assertActive / runner.invalidate). Other errors are matched on the stable
 * message fragment so the guard keeps working across pi versions.
 */
export function isStaleCtxError(error: unknown): boolean {
    return error instanceof Error && STALE_CTX_ERROR.test(error.message);
}

/**
 * Run fn; if the only failure is pi's stale-ctx assertion, return "stale"
 * instead of letting the throw escape (which would crash pi from a timer or
 * become an unhandled rejection from a promise).
 */
export function staleSafe<T>(fn: () => T): T | "stale" {
    try {
        return fn();
    } catch (error) {
        if (isStaleCtxError(error)) return "stale";
        throw error;
    }
}

/**
 * Async variant for promise chains that dereference pi/ctx. A stale
 * rejection resolves to "stale" rather than becoming an unhandled rejection.
 */
export async function staleSafeAsync<T>(
    fn: () => Promise<T>
): Promise<T | "stale"> {
    try {
        return await fn();
    } catch (error) {
        if (isStaleCtxError(error)) return "stale";
        throw error;
    }
}
