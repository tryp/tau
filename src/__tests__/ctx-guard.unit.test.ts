/**
 * Unit tests for the stale-extension-ctx guard (ctx-guard.ts) and for the
 * crash it prevents:
 *
 * A real session showed `pi exiting due to uncaughtException` from
 * bash-tmux.ts's 500ms completion poll timer after the extension/session
 * context was replaced (reload or session switch) while a background job
 * was still running. pi invalidates captured extension APIs on replacement;
 * the next timer tick dereferenced the stale `pi`/`ctx`, the loader's
 * assertActive threw, and the uncaughtException terminated pi.
 *
 * These tests build the same shape (a captured pi/ctx whose every
 * action-method/guarded-getter access throws the loader's stale-ctx error)
 * and assert the extension no longer lets that throw escape.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    isStaleCtxError,
    staleSafe,
    staleSafeAsync,
} from "../features/ctx-guard.ts";
import {
    cancelQueuedBackgroundNotifications,
    flushCompletionBatch,
    getActiveBackgroundControlTools,
    handleTmuxCompletion,
    notifyCompletion,
    updateWidget,
} from "../features/background.ts";
import { finalizeTmuxCompletion } from "../features/bash-tmux.ts";
import { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";

/** Exact message used by pi's loader assertActive (runner.invalidate). */
const STALE_MESSAGE =
    "This extension ctx is stale after session replacement or reload. " +
    "Do not use a captured pi or command ctx after ctx.newSession(), " +
    "ctx.fork(), ctx.switchSession(), or ctx.reload().";

function staleError(): Error {
    return new Error(STALE_MESSAGE);
}

/**
 * Fake ExtensionAPI that mirrors pi's loader behavior after invalidation:
 * every action method throws the stale-ctx assertion. Records which methods
 * were attempted so tests can prove the guarded code still walked the
 * completion path without letting the throw escape.
 */
function makeStalePi(): { pi: never; attempted: string[] } {
    const attempted: string[] = [];
    const throwing = (name: string) => {
        return () => {
            attempted.push(name);
            throw staleError();
        };
    };
    return {
        pi: {
            cancelQueuedMessage: throwing("cancelQueuedMessage"),
            sendMessage: throwing("sendMessage"),
            sendUserMessage: throwing("sendUserMessage"),
            appendEntry: throwing("appendEntry"),
            getActiveTools: throwing("getActiveTools"),
            getSessionName: throwing("getSessionName"),
        } as never,
        attempted,
    };
}

/**
 * Fake context whose ui surface throws the stale-ctx assertion on access,
 * mirroring loader.js createContext()'s guarded getters.
 */
function makeStaleCtx(): { ctx: never } {
    return {
        ctx: {
            ui: {
                notify() {
                    throw staleError();
                },
                setWidget() {
                    throw staleError();
                },
                setStatus() {
                    throw staleError();
                },
                theme: {
                    fg: () => "",
                },
            },
        } as never,
    };
}

function makeJob(
    overrides: Partial<BackgroundJob> & { id: string }
): BackgroundJob {
    return {
        command: "sleep 30",
        pid: -1,
        startTime: 0,
        status: "completed",
        logPath: "/tmp/does-not-exist",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tau-ctx-guard-"));
    // Reset module-level completion-batch state between tests.
    // (flushCompletionBatch drains it; tests that don't flush leave no
    // pending timer because notifyCompletion's enqueue is synchronous when
    // outputIndexPromise is absent.)
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    // Drain any scheduled batch timers so unref'd timers never fire later.
    try {
        flushCompletionBatch();
    } catch {
        /* non-stale errors would surface as test failures already */
    }
});

// ─── Guard primitives ───────────────────────────────────────────────

void describe("stale-ctx guard primitives", () => {
    void it("recognizes the loader's stale-ctx error message", () => {
        assert.equal(isStaleCtxError(staleError()), true);
        assert.equal(
            isStaleCtxError(
                new Error(
                    "extension ctx is stale after session replacement or reload"
                )
            ),
            true
        );
        assert.equal(isStaleCtxError(new Error("something else")), false);
        assert.equal(isStaleCtxError("not an error"), false);
        assert.equal(isStaleCtxError(undefined), false);
    });

    void it("staleSafe returns the value for live contexts", () => {
        const result = staleSafe(() => 42);
        assert.equal(result, 42);
    });

    void it("staleSafe converts the stale-ctx assertion to 'stale'", () => {
        const result = staleSafe(() => {
            throw staleError();
        });
        assert.equal(result, "stale");
    });

    void it("staleSafe rethrows unrelated errors", () => {
        const boom = new Error("real bug");
        assert.throws(() =>
            staleSafe(() => {
                throw boom;
            })
        );
    });

    void it("staleSafeAsync resolves 'stale' on stale rejection", async () => {
        const result = await staleSafeAsync(async () => {
            throw staleError();
        });
        assert.equal(result, "stale");
    });

    void it("staleSafeAsync passes through successful async values", async () => {
        const result = await staleSafeAsync(async () => "value");
        assert.equal(result, "value");
    });
});

// ─── Crash replication: background completion paths ─────────────────

void describe("tmux completion under a stale ctx (reload/session switch)", () => {
    void it("handleTmuxCompletion with a stale pi does not throw", () => {
        const state = new TauState();
        const { pi, attempted } = makeStalePi();
        const { ctx } = makeStaleCtx();
        const job = makeJob({ id: "stale-tmux-job" });
        state.backgroundJobs.set(job.id, job);

        // Before the fix this propagated the loader's assertActive throw out
        // of the tmux poll timer callback — the exact uncaughtException that
        // killed pi.
        assert.doesNotThrow(() =>
            handleTmuxCompletion(job, state, pi, ctx, true)
        );
        // The cancellation path still walked through pi, but the throw was
        // contained. The job lifecycle is preserved (removed from active map).
        assert.ok(attempted.includes("cancelQueuedMessage"));
        assert.equal(state.backgroundJobs.has(job.id), false);
        assert.equal(job.completionNotified, true);
    });

    void it("handleTmuxCompletion(notify:false) under a stale ctx does not throw", () => {
        const state = new TauState();
        const { pi } = makeStalePi();
        const { ctx } = makeStaleCtx();
        const job = makeJob({ id: "stale-tmux-silent" });
        state.backgroundJobs.set(job.id, job);

        assert.doesNotThrow(() =>
            handleTmuxCompletion(job, state, pi, ctx, false)
        );
        assert.equal(state.backgroundJobs.has(job.id), false);
        assert.equal(job.suppressAutonomousWake, true);
    });

    void it("notifyCompletion with a stale pi/ctx does not throw or crash the flush", () => {
        const state = new TauState();
        const { pi } = makeStalePi();
        const { ctx } = makeStaleCtx();
        const job = makeJob({ id: "stale-notify" });
        state.backgroundJobs.set(job.id, job);

        assert.doesNotThrow(() => notifyCompletion(job, state, pi, ctx));
        // Flushing the batch must not crash either — sendQueuedMessage is
        // guarded the same way.
        assert.doesNotThrow(() => flushCompletionBatch());
        assert.equal(state.backgroundJobs.has(job.id), false);
    });

    void it("notifyCompletion with a failed sidecar index shows no stale toast crash", () => {
        const state = new TauState();
        const { pi } = makeStalePi();
        const { ctx } = makeStaleCtx();
        const job = makeJob({
            id: "stale-sidecar-failed",
            sidecarIndexStatus: "failed",
            sidecarIndexErrorCategory: "io",
        });
        state.backgroundJobs.set(job.id, job);

        // The sidecar-failure toast is delivered inside the indexing
        // promise; the ctx.ui access there must be guarded too.
        assert.doesNotThrow(() => notifyCompletion(job, state, pi, ctx));
        assert.doesNotThrow(() => flushCompletionBatch());
    });

    void it("cancelQueuedBackgroundNotifications with a stale pi does not throw", () => {
        const { pi } = makeStalePi();
        assert.doesNotThrow(() =>
            cancelQueuedBackgroundNotifications(pi, "job-id")
        );
    });

    void it("finalizeTmuxCompletion (poll timer body) contains the stale throw", () => {
        const state = new TauState();
        const { pi, attempted } = makeStalePi();
        const { ctx } = makeStaleCtx();
        const job = makeJob({ id: "stale-finalize", status: "running" });
        state.backgroundJobs.set(job.id, job);

        // The poll-timer path: onCompletion carries handleTmuxCompletion,
        // which is where the stale assertion used to escape.
        const onCompletion = (j: BackgroundJob) =>
            handleTmuxCompletion(j, state, pi, ctx, true);

        assert.doesNotThrow(() =>
            finalizeTmuxCompletion(job, 0, ctx, onCompletion)
        );
        assert.equal(job.status, "completed");
        assert.ok(attempted.includes("cancelQueuedMessage"));
    });

    void it("updateWidget with a stale ctx does not throw", () => {
        const state = new TauState();
        const { ctx } = makeStaleCtx();
        const job = makeJob({ id: "stale-widget", status: "running" });
        state.backgroundJobs.set(job.id, job);
        assert.doesNotThrow(() => updateWidget(state, ctx));
    });

    void it("getActiveBackgroundControlTools reports none under a stale pi", () => {
        const { pi } = makeStalePi();
        assert.deepEqual(getActiveBackgroundControlTools(pi), []);
    });

    void it("completion batch delivery under a stale pi does not throw", () => {
        const state = new TauState();
        const { pi, attempted } = makeStalePi();
        const { ctx } = makeStaleCtx();
        const job = makeJob({ id: "stale-batch" });
        state.backgroundJobs.set(job.id, job);
        job.wantsCompletionNotification = true;

        handleTmuxCompletion(job, state, pi, ctx, true);
        assert.doesNotThrow(() => flushCompletionBatch());
        // Delivery was attempted through the guarded send path, then
        // suppressed — the assertion never escaped.
        assert.ok(attempted.includes("sendMessage"));
    });
});

// ─── Sidecar-indexing path ──────────────────────────────────────────

void describe("sidecar indexing under a stale ctx", () => {
    void it("indexing a real log resolves without an unhandled rejection", async () => {
        const state = new TauState();
        makeStalePi();
        const logPath = join(tmp, "job.log");
        writeFileSync(logPath, "some output\n");
        const job = makeJob({ id: "stale-index", logPath });
        state.backgroundJobs.set(job.id, job);

        // ctx with a sessionManager that throws the stale assertion on
        // access (loader.rs guarded getter).
        const staleSessionCtx = {
            sessionManager: {
                getSessionFile() {
                    throw staleError();
                },
                getSessionId() {
                    throw staleError();
                },
            },
        } as never;

        // await the sidecar-turnaround promise chain used by completion
        // paths; it must resolve (index skipped) rather than reject.
        await assert.doesNotReject(async () => {
            const { trackJobOutputIndex } =
                await import("../features/sidecar.ts");
            await trackJobOutputIndex(job, staleSessionCtx, "bash_bg");
        });
        assert.equal(job.sidecarIndexStatus, "failed");
    });
});
