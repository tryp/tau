/**
 * Tool-hints regression tests.
 *
 * The predicates are deliberately strict, so most of this file is about what
 * must NOT fire: a hint on a command that was already the right tool, on a
 * failed result, or for the fourth time in a session is worse than silence.
 * The corpus numbers behind each rule are in `../features/tool-hints/index.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    ExtensionAPI,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { TauState } from "../state.ts";
import {
    POLL_THRESHOLD,
    findDiagnosticPosition,
    jobIdOf,
    matchSedRange,
} from "../features/tool-hints/hints.ts";
import {
    DEFAULT_MAX_FIRES,
    DEFAULT_REARM_AFTER,
    HintGate,
} from "../features/tool-hints/gate.ts";
import { registerToolHints } from "../features/tool-hints/index.ts";
import { HINT_PREFIX } from "../features/tool-hints/messages.ts";

/** A real `lsp_diagnostics` result, sampled from a session corpus. */
const DIAGNOSTICS_ERRORS = [
    "LSP diagnostics for /home/dev/src/x/scripts/join.py (pyright):",
    "Showing 1-2 of 2.",
    '- error 207:27 Argument of type "tuple[Path, dict]" cannot be assigned.',
    "- error 88:5 Cannot find name 'foo'.",
].join("\n");

/** A hint-only result: nothing to fix, so nothing to say. */
const DIAGNOSTICS_HINT_ONLY = [
    "LSP diagnostics for /home/dev/src/x/scripts/join.py (pyright):",
    "Showing 1-1 of 1.",
    '- hint 217:5 "telemetry_text" is not accessed [Pyright]',
].join("\n");

void describe("tool-hints sed-range predicate", () => {
    void it("matches a quoted numeric range on one file", () => {
        assert.deepEqual(matchSedRange("sed -n '10,40p' src/app.ts"), {
            path: "src/app.ts",
            start: 10,
            end: 40,
        });
    });

    void it("matches an unquoted range and the -e form", () => {
        assert.deepEqual(matchSedRange("sed -n 10,40p src/app.ts"), {
            path: "src/app.ts",
            start: 10,
            end: 40,
        });
        assert.deepEqual(matchSedRange("sed -n -e '1,5p' f.txt"), {
            path: "f.txt",
            start: 1,
            end: 5,
        });
    });

    void it("declines a range that is one segment of a larger command", () => {
        // `read` is not a drop-in replacement inside a pipeline, so the hint
        // would be wrong rather than unhelpful.
        for (const command of [
            "cd /tmp && sed -n '1,5p' f.txt",
            "sed -n '1,5p' f.txt | head",
            "sed -n '1,5p' f.txt; echo done",
            "cat f.txt | sed -n '1,5p'",
        ]) {
            assert.equal(matchSedRange(command), null, command);
        }
    });

    void it("declines anything that is not a fixed numeric view", () => {
        for (const command of [
            "sed -n '/pattern/p' f.txt", // a grep, not a range view
            "sed -i '1,5d' f.txt", // an edit, not a view
            "sed -n '5,1p' f.txt", // inverted range
            "sed -n '0,5p' f.txt", // ranges are 1-based
            "sed -n '1,5p'",
            "rg -n 'foo' f.txt",
        ]) {
            assert.equal(matchSedRange(command), null, command);
        }
        assert.equal(matchSedRange(undefined), null);
        assert.equal(matchSedRange(42), null);
    });
});

void describe("tool-hints diagnostics predicate", () => {
    void it("finds the first error position", () => {
        assert.deepEqual(findDiagnosticPosition(DIAGNOSTICS_ERRORS), {
            path: "/home/dev/src/x/scripts/join.py",
            line: 207,
            column: 27,
            severity: "error",
        });
    });

    void it("treats a warning as actionable and a hint as not", () => {
        const warning = [
            "LSP diagnostics for /tmp/a.py (pyright):",
            "Showing 1-1 of 1.",
            "- warning 4:1 Something smells.",
        ].join("\n");
        assert.equal(findDiagnosticPosition(warning)?.severity, "warning");
        assert.equal(findDiagnosticPosition(DIAGNOSTICS_HINT_ONLY), null);
    });

    void it("declines a clean result and non-string input", () => {
        assert.equal(
            findDiagnosticPosition(
                "LSP diagnostics for /tmp/a.py (pyright):\nNo diagnostics."
            ),
            null
        );
        assert.equal(findDiagnosticPosition(undefined), null);
    });
});

void describe("tool-hints job polling", () => {
    void it("reads either job id field", () => {
        assert.equal(jobIdOf({ jobId: "abc" }), "abc");
        assert.equal(jobIdOf({ id: "abc" }), "abc");
        assert.equal(jobIdOf({ jobId: "  " }), null);
        assert.equal(jobIdOf({}), null);
    });
});

void describe("tool-hints registration", () => {
    function fakePi() {
        const handlers = new Map<string, unknown[]>();
        const appended: Array<{ customType: string; data: unknown }> = [];
        const pi = {
            on(event: string, handler: unknown) {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
            appendEntry(customType: string, data: unknown) {
                appended.push({ customType, data });
            },
        } as unknown as ExtensionAPI;
        return { pi, handlers, appended };
    }

    function resultHandler(handlers: Map<string, unknown[]>) {
        return handlers.get("tool_result")?.[0] as
            | ((event: ToolResultEvent) => unknown)
            | undefined;
    }

    function bashResult(
        command: string,
        opts: { isError?: boolean } = {}
    ): ToolResultEvent {
        return {
            type: "tool_result",
            toolCallId: `call-${Math.abs(hash(command))}`,
            toolName: "bash",
            input: { command },
            content: [{ type: "text", text: "  10\tline ten" }],
            isError: opts.isError ?? false,
            // A custom-tool result carries `details`; the fixtures omit it, so
            // the cast goes through unknown rather than claiming a shape the
            // object does not have.
        } as unknown as ToolResultEvent;
    }

    function hash(text: string): number {
        let h = 0;
        for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return h;
    }

    function hintBlocks(result: unknown): string[] {
        // A handler that returns nothing left the result alone, which is what
        // "suppressed" looks like from the outside; `result` is undefined there.
        const content = (
            result as { content?: Array<{ text?: string }> } | undefined
        )?.content;
        return (content ?? [])
            .map((block) => block.text ?? "")
            .filter((text) => text.startsWith(HINT_PREFIX));
    }

    void it("appends the hint after the payload and leaves the payload alone", async () => {
        const { pi, handlers } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const result = await handler(bashResult("sed -n '10,40p' src/app.ts"));
        const content = (result as { content: Array<{ text: string }> })
            .content;
        assert.equal(content.length, 2);
        assert.equal(content[0].text, "  10\tline ten");
        assert.match(
            content[1].text,
            /^\[hint\] read does this without a shell/
        );
        assert.match(content[1].text, /offset=10, limit=31/);
    });

    void it("holds the hint back on a single repeat and records the suppression", async () => {
        const { pi, handlers, appended } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const first = await handler(bashResult("sed -n '1,5p' a.txt"));
        assert.equal(hintBlocks(first).length, 1);

        const second = await handler(bashResult("sed -n '1,5p' b.txt"));
        assert.equal(second, undefined);
        assert.equal(
            appended.filter((e) => e.customType === "tool-hints").length,
            1
        );
        const suppressed = appended.filter(
            (e) => e.customType === "tool-hints-suppressed"
        );
        assert.equal(suppressed.length, 1);
        assert.deepEqual(suppressed[0].data, {
            rule: "sed-range",
            reason: "pending",
        });
    });

    void it("stays silent on a failed call", async () => {
        const { pi, handlers, appended } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const result = await handler(
            bashResult("sed -n '1,5p' a.txt", { isError: true })
        );
        assert.equal(result, undefined);
        assert.equal(appended.length, 0);
    });

    void it("respects the feature toggle", async () => {
        const { pi, handlers } = fakePi();
        registerToolHints(pi, {
            globalFeatures: { "tool-hints": false },
        } as unknown as TauState);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const result = await handler(bashResult("sed -n '1,5p' a.txt"));
        assert.equal(result, undefined);
    });

    void it("keeps other tools untouched", async () => {
        const { pi, handlers } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const event = {
            type: "tool_result",
            toolCallId: "call-read",
            toolName: "read",
            input: { path: "a.txt" },
            content: [{ type: "text", text: "1\tfoo" }],
            isError: false,
        } as unknown as ToolResultEvent;
        assert.equal(await handler(event), undefined);
    });

    void it("hints the third poll of a job, not the second", async () => {
        const { pi, handlers } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const poll = (jobId: string): ToolResultEvent =>
            ({
                type: "tool_result",
                toolCallId: `call-${jobId}-${Math.abs(hash(jobId))}`,
                toolName: "jobs",
                input: { action: "output", jobId },
                content: [{ type: "text", text: "Output for job (running)" }],
                isError: false,
            }) as unknown as ToolResultEvent;

        for (let i = 1; i < POLL_THRESHOLD; i++) {
            assert.equal(await handler(poll("job-a")), undefined, `poll ${i}`);
        }
        const third = await handler(poll("job-a"));
        assert.equal(hintBlocks(third).length, 1);
        assert.match(hintBlocks(third)[0], /job_decide ends this poll loop/);

        // A second job is still reachable in the same session.
        for (let i = 1; i < POLL_THRESHOLD; i++) await handler(poll("job-b"));
        const other = await handler(poll("job-b"));
        assert.equal(hintBlocks(other).length, 1);

        // ...but the same job is not hinted twice.
        assert.equal(await handler(poll("job-a")), undefined);
    });

    void it("re-offers after a sustained pattern, then stops for good", async () => {
        // Compaction replaces old tool results but not this counter, so the
        // gate -- not the context window -- is what decides whether an ignored
        // hint ever comes back.
        const { pi, handlers, appended } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        let fired = 0;
        const calls =
            1 +
            DEFAULT_MAX_FIRES +
            DEFAULT_MAX_FIRES * (DEFAULT_REARM_AFTER + 1);
        for (let i = 0; i < calls; i++) {
            const result = await handler(
                bashResult(`sed -n '1,${i + 2}p' a.txt`)
            );
            if (hintBlocks(result).length > 0) fired++;
        }
        // Exactly the budget: more is noise, fewer means an ignored hint was
        // retired for good.
        assert.equal(fired, DEFAULT_MAX_FIRES);

        // The progression is in the record, not just in memory: `pending` while
        // re-arming and `capped` once the budget is spent.
        const reasons = appended
            .filter((e) => e.customType === "tool-hints-suppressed")
            .map((e) => (e.data as { reason: string }).reason);
        assert.deepEqual(reasons.sort(), ["capped", "pending"]);
    });

    void it("never marks a result as an error", async () => {
        const { pi, handlers } = fakePi();
        registerToolHints(pi);
        const handler = resultHandler(handlers);
        assert.ok(handler);

        const result = await handler(bashResult("sed -n '1,5p' a.txt"));
        assert.ok(result);
        assert.equal(
            Object.prototype.hasOwnProperty.call(result, "isError"),
            false
        );
    });
});

void describe("tool-hints gate", () => {
    void it("fires the first match immediately", () => {
        const gate = new HintGate();
        const first = gate.offer("sed-range");
        assert.equal(first.fire, true);
        assert.equal(first.fires, 1);
        // The reason is what the session record reports, so it is pinned too.
        assert.equal(first.reason, "first");
    });

    void it("counts suppressed matches instead of forgetting them", () => {
        const gate = new HintGate({ maxFires: 2, rearmAfter: 2 });
        gate.offer("r"); // fires
        const a = gate.offer("r");
        const b = gate.offer("r");
        assert.deepEqual(
            [a.fire, a.sinceFire, b.fire, b.sinceFire],
            [false, 1, false, 2]
        );
        assert.equal(a.reason, "pending");
        const third = gate.offer("r"); // the rearm fires
        assert.equal(third.fire, true);
        assert.equal(third.fires, 2);
        assert.equal(third.reason, "rearm");
    });

    void it("goes quiet once maxFires is reached", () => {
        const gate = new HintGate({ maxFires: 1, rearmAfter: 0 });
        assert.equal(gate.offer("r").fire, true);
        for (let i = 0; i < 5; i++) {
            const decision = gate.offer("r");
            assert.equal(decision.fire, false);
            assert.equal(decision.suppressed, true);
            // `capped` is distinguishable from `pending`: a rule that never
            // converted anyone stops being counted as still arming.
            assert.equal(decision.reason, "capped");
        }
        assert.equal(gate.fireCount("r"), 1);
    });

    void it("keys independently, so a second job is still reachable", () => {
        const gate = new HintGate({ maxFires: 1 });
        assert.equal(gate.offer("job-a").fire, true);
        assert.equal(gate.offer("job-a").fire, false);
        assert.equal(gate.offer("job-b").fire, true);
    });
});
