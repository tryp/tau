/**
 * Tests for the agent-background feature — context extraction and path choosing.
 *
 * All tests import directly from the source module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
    buildBackgroundSpawnArgs,
    chooseBackgroundPath,
    extractTextFromContent,
    extractLastAssistantSummary,
    extractOriginalPrompt,
    estimateConversationBytes,
    LAST_SUMMARY_MAX_CHARS,
    ORIGINAL_PROMPT_MAX_CHARS,
} from "../features/agent-background.ts";
import { TauState } from "../state.ts";
import { cancelPendingBackgroundAgent } from "../utils.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// ─── chooseBackgroundPath ────────────────────────────────────────────

void describe("chooseBackgroundPath", () => {
    void it("chooses fork when conversation is small", () => {
        // 4KB conversation, 128K context → ~1K tokens / 128K ≈ 0.8%
        assert.equal(chooseBackgroundPath(4096, 131072), "fork");
    });

    void it("chooses summary when conversation exceeds 40%", () => {
        // 250KB / 4 = 62.5K tokens / 128K ≈ 49%
        assert.equal(chooseBackgroundPath(250000, 128000), "summary");
    });

    void it("chooses fork at boundary 39%", () => {
        // boundary = 1.6 * tokens. 128000 * 1.6 = 204800
        assert.equal(chooseBackgroundPath(204000, 128000), "fork");
    });

    void it("chooses summary at boundary 41%", () => {
        assert.equal(chooseBackgroundPath(205000, 128000), "summary");
    });

    void it("defaults to fork for empty persisted conversation", () => {
        assert.equal(chooseBackgroundPath(0, 32768), "fork");
    });

    void it("uses summary mode when no session file is available", () => {
        assert.equal(chooseBackgroundPath(0, 32768, false), "summary");
    });

    void it("uses summary mode for an invalid context window", () => {
        assert.equal(chooseBackgroundPath(0, 0), "summary");
    });
});

// ─── buildBackgroundSpawnArgs ────────────────────────────────────────

void describe("buildBackgroundSpawnArgs", () => {
    void it("adds --fork only for fork mode", () => {
        assert.deepEqual(
            buildBackgroundSpawnArgs({
                mode: "fork",
                sessionFile: "/tmp/source.jsonl",
                modelArg: "provider/model",
                thinkingLevel: "high",
                promptFile: "/tmp/prompt.md",
            }),
            [
                "--fork",
                "/tmp/source.jsonl",
                "-p",
                "--mode",
                "text",
                "--model",
                "provider/model",
                "--thinking",
                "high",
                "@/tmp/prompt.md",
            ]
        );
    });

    void it("does not silently construct an invalid fork", () => {
        assert.throws(
            () =>
                buildBackgroundSpawnArgs({
                    mode: "fork",
                    promptFile: "/tmp/prompt.md",
                }),
            /requires a persisted session file/
        );
    });

    void it("omits fork and thinking flags in summary mode when unset", () => {
        assert.deepEqual(
            buildBackgroundSpawnArgs({
                mode: "summary",
                promptFile: "/tmp/prompt.md",
            }),
            ["-p", "--mode", "text", "@/tmp/prompt.md"]
        );
    });
});

// ─── cancelPendingBackgroundAgent ─────────────────────────────────────

void describe("cancelPendingBackgroundAgent", () => {
    void it("kills a queued job and removes its prompt file", () => {
        const state = new TauState();
        const jobId = "job-test-queued";
        const promptFile = `${tmpdir()}/pi-bg-test-${jobId}.md`;
        writeFileSync(promptFile, "queued prompt");
        const job = {
            id: jobId,
            command: "pi --fork (background agent)",
            pid: 0,
            startTime: Date.now(),
            status: "running" as const,
            queued: true,
            logPath: `${tmpdir()}/pi-bg-test-${jobId}.log`,
            toolCallId: "tool-test",
            isBackgrounded: true,
        };
        state.backgroundJobs.set(jobId, job);
        state.pendingBackgroundAgents.set(jobId, {
            jobId,
            promptFile,
            execCwd: tmpdir(),
            conversationBytes: 0,
            contextWindowTokens: 32768,
        });

        const cancelled = cancelPendingBackgroundAgent(state, jobId);

        assert.equal(cancelled, job);
        assert.equal(job.status, "killed");
        assert.equal(job.queued, undefined);
        assert.equal(state.pendingBackgroundAgents.has(jobId), false);
        assert.equal(existsSync(promptFile), false);
        try {
            unlinkSync(promptFile);
        } catch {
            /* already removed */
        }
    });
});

// ─── extractTextFromContent ──────────────────────────────────────────

void describe("extractTextFromContent", () => {
    void it("extracts from string content", () => {
        const result = extractTextFromContent("hello");
        assert.equal(result, "hello");
    });

    void it("extracts from text blocks", () => {
        const content = [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
        ];
        const result = extractTextFromContent(content);
        assert.equal(result, "line 1\nline 2");
    });

    void it("skips non-text blocks", () => {
        const content = [
            { type: "text", text: "visible" },
            { type: "thinking", thinking: "hidden" },
        ];
        const result = extractTextFromContent(content);
        assert.equal(result, "visible");
    });

    void it("returns empty string for empty array", () => {
        const result = extractTextFromContent([]);
        assert.equal(result, "");
    });
});

// ─── extractLastAssistantSummary ─────────────────────────────────────

void describe("extractLastAssistantSummary", () => {
    void it("extracts the last assistant message", () => {
        const entries = [
            makeMessage("user", "hello"),
            makeMessage("assistant", "first response"),
            makeMessage("user", "continue"),
            makeMessage("assistant", "final response with more detail"),
        ];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result, "final response with more detail");
    });

    void it("truncates to LAST_SUMMARY_MAX_CHARS characters", () => {
        const longText = "x".repeat(LAST_SUMMARY_MAX_CHARS + 2000);
        const entries = [makeMessage("assistant", longText)];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result.length, LAST_SUMMARY_MAX_CHARS);
        assert.ok(result.endsWith("x".repeat(LAST_SUMMARY_MAX_CHARS)));
    });

    void it("keeps summary content at the cap boundary", () => {
        const atCap = "s".repeat(LAST_SUMMARY_MAX_CHARS);
        const entries = [makeMessage("assistant", atCap)];
        assert.equal(
            extractLastAssistantSummary(entries).length,
            LAST_SUMMARY_MAX_CHARS
        );
    });

    void it("returns empty string when no assistant messages exist", () => {
        const entries = [makeMessage("user", "hello")];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result, "");
    });

    void it("skips non-message entries", () => {
        const entries: SessionEntry[] = [
            { type: "compaction" } as SessionEntry,
            makeMessage("assistant", "visible"),
        ];
        const result = extractLastAssistantSummary(entries);
        assert.equal(result, "visible");
    });
});

// ─── extractOriginalPrompt ───────────────────────────────────────────

void describe("extractOriginalPrompt", () => {
    void it("extracts the first user message", () => {
        const entries = [
            makeMessage("user", "original prompt"),
            makeMessage("assistant", "response"),
            makeMessage("user", "follow-up"),
        ];
        const result = extractOriginalPrompt(entries);
        assert.equal(result, "original prompt");
    });

    void it("truncates to ORIGINAL_PROMPT_MAX_CHARS characters", () => {
        const longText = "y".repeat(ORIGINAL_PROMPT_MAX_CHARS + 2000);
        const entries = [makeMessage("user", longText)];
        const result = extractOriginalPrompt(entries);
        assert.equal(result.length, ORIGINAL_PROMPT_MAX_CHARS);
        assert.ok(result.startsWith("y".repeat(ORIGINAL_PROMPT_MAX_CHARS)));
    });

    void it("keeps prompt content at the cap boundary", () => {
        const atCap = "p".repeat(ORIGINAL_PROMPT_MAX_CHARS);
        const entries = [makeMessage("user", atCap)];
        assert.equal(
            extractOriginalPrompt(entries).length,
            ORIGINAL_PROMPT_MAX_CHARS
        );
    });

    void it("returns empty string when no user messages", () => {
        const entries = [makeMessage("assistant", "hello")];
        const result = extractOriginalPrompt(entries);
        assert.equal(result, "");
    });
});

// ─── estimateConversationBytes ───────────────────────────────────────

void describe("estimateConversationBytes", () => {
    void it("counts string content length", () => {
        const entries = [makeMessage("user", "hello")];
        const result = estimateConversationBytes(entries);
        assert.equal(result, 5);
    });

    void it("sums across multiple messages", () => {
        const entries = [
            makeMessage("user", "hello"),
            makeMessage("assistant", "world"),
        ];
        const result = estimateConversationBytes(entries);
        assert.equal(result, 10);
    });

    void it("counts UTF-8 bytes for text content", () => {
        const entries = [makeMessage("user", "🙂")];
        assert.equal(estimateConversationBytes(entries), 4);
    });

    void it("counts text block content", () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "hello" },
                        { type: "thinking", thinking: "hidden" },
                    ],
                },
            } as SessionEntry,
        ];
        const result = estimateConversationBytes(entries);
        assert.equal(result, 5);
    });

    void it("returns 0 for empty entries", () => {
        const result = estimateConversationBytes([]);
        assert.equal(result, 0);
    });
});

// ─── Test helpers ────────────────────────────────────────────────────

function makeMessage(role: string, text: string): SessionEntry {
    return {
        type: "message",
        message: { role, content: text },
    } as SessionEntry;
}
