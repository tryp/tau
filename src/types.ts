/**
 * Shared type definitions for Tau extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ─── Background jobs ────────────────────────────────────────────────

export type JobStatus = "running" | "completed" | "failed" | "killed";

/** Data retained while an agent_bg fork waits for the parent turn to settle. */
export interface PendingBackgroundAgent {
    jobId: string;
    promptFile: string;
    execCwd: string;
    modelArg?: string;
    thinkingLevel?: string;
    sessionFile?: string;
    conversationBytes: number;
    contextWindowTokens: number;
    settleTimer?: ReturnType<typeof setTimeout>;
}

/** Stable identifiers for indexed background-job output. */
export interface JobOutputIndex {
    sourceId: string;
    chunkIds: string[];
}

export type SidecarIndexStatus = "indexed" | "skipped" | "failed";

/** Outcome of an optional sidecar indexing operation. */
export interface SidecarIndexOutcome {
    status: SidecarIndexStatus;
    /** A non-empty result that would benefit from durable recovery. */
    eligible: boolean;
    source?: JobOutputIndex;
    reason?:
        | "empty_output"
        | "sidecar_unavailable"
        | "schema_unavailable"
        | "read_failed"
        | "index_failed";
    errorCategory?: "io" | "schema" | "unavailable" | "unknown";
}

/** Cumulative sidecar indexing counters for diagnostics and analysis. */
export interface SidecarIndexStats {
    attempts: number;
    eligible: number;
    indexed: number;
    skipped: number;
    failed: number;
    emptySkipped: number;
    unavailableSkipped: number;
    schemaSkipped: number;
}

/** Machine-readable metadata returned by background job tools. */
export interface JobResultDetails {
    jobId?: string;
    status?: JobStatus;
    queued?: boolean;
    exitCode?: number;
    logPath?: string;
    totalLines?: number;
    truncated?: boolean;
    empty?: boolean;
    error?: boolean;
    timedOut?: boolean;
    /**
     * OS PID of the direct child process backing the job. Present only when
     * the job is backed by a real process (spawn/detached). Tmux-backed jobs
     * have no single PID, so the field is omitted rather than faked.
     */
    pid?: number;
    /** Epoch ms at which the job started. */
    startTime?: number;
    /** Epoch ms at which the job reached a terminal state. Absent while running. */
    endTime?: number;
    /**
     * Runtime in ms: full duration once terminal, elapsed-so-far while running.
     * Computed as `(endTime ?? now) - startTime`, so a still-running job's
     * value grows between snapshots.
     */
    durationMs?: number;
    /** Source ID for the job's output in the context sidecar. */
    sourceId?: string;
    /** Stable context-sidecar chunk IDs for the indexed output. */
    chunkIds?: string[];
    /** Outcome of optional durable output indexing. */
    sidecarIndexStatus?: SidecarIndexStatus;
    /** Reason an output was skipped or failed to index. */
    sidecarIndexReason?: SidecarIndexOutcome["reason"];
    /** Sanitized category for an indexing failure or unavailable sidecar. */
    sidecarIndexErrorCategory?: SidecarIndexOutcome["errorCategory"];
    /** Original output was reduced before being returned inline. */
    partial?: boolean;
    /** Number of lines omitted by a head/tail or grep view, when known. */
    omittedLines?: number;
    /** Original output size in UTF-8 bytes, when known. */
    byteCount?: number;
    /** Durable output path for foreground results when sidecar indexing is unavailable. */
    fullOutputPath?: string;
}

export interface BackgroundJob {
    id: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    /** Epoch ms at which the job reached a terminal state; unset while running. */
    endTime?: number;
    logPath: string;
    proc?: ChildProcess;
    toolCallId: string;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    /** True while an agent_bg fork is waiting for the parent turn to settle. */
    queued?: boolean;
    /** True once the agent has consumed output via attach — suppresses completion notification. */
    outputConsumed?: boolean;
    /** True once the normal completion notification has been queued. */
    completionNotified?: boolean;
    /** True if running in background; false if foreground (not yet backgrounded). */
    isBackgrounded: boolean;
    /**
     * Set when a linked callback (remindDelay) fires while the job is still
     * running. Signals that the agent explicitly wanted to be reminded about
     * this job and should receive the completion notification when it finishes,
     * even though the original linked callback has already been consumed.
     */
    wantsCompletionNotification?: boolean;
    /** Indexed output identifiers, populated after terminal completion. */
    sourceId?: string;
    chunkIds?: string[];
    /** Resolves when terminal output indexing finishes. */
    outputIndexPromise?: Promise<JobOutputIndex | undefined>;
    /** Outcome of optional terminal-output indexing. */
    sidecarIndexStatus?: SidecarIndexStatus;
    sidecarIndexReason?: SidecarIndexOutcome["reason"];
    sidecarIndexErrorCategory?: SidecarIndexOutcome["errorCategory"];
    /** Optional triggers that fire async events when conditions are met. */
    triggers?: JobTrigger[];
    /** Stops the active trigger monitor, if one is running. */
    cancelTriggerMonitor?: () => void;
}

// ─── Job triggers ───────────────────────────────────────────────────

/**
 * A condition to monitor on a running background job.
 * When the condition is met, a `bg-trigger` custom event is sent to
 * the agent and the trigger is deactivated (one-shot).
 * Time-based values are in seconds (wallTime, cpuTime, ioBlock).
 */
export type JobTrigger =
    | {
          /** Numeric-threshold trigger types. */
          type:
              | "outputLines"
              | "rssKb"
              | "ioReadBytes"
              | "ioWriteBytes"
              | "cpuTime"
              | "ioBlock"
              | "wallTime";
          /** Threshold value (lines, KiB, bytes, or seconds). */
          value: number;
          /** Optional label for the agent's callback message. */
          label?: string;
      }
    | {
          type: "outputMatch";
          /**
           * JavaScript regular expression matched against the job log,
           * the same regex language used by the rest of the agent tool
           * surfaces (e.g. `jobs output grep`).
           */
          pattern: string;
          /**
           * Defaults to false: matching is case-insensitive unless this
           * is set to true (same default as `jobs output grep`).
           */
          caseSensitive?: boolean;
          /** Optional label for the agent's callback message. */
          label?: string;
      };

export interface RunningProcess {
    toolCallId: string;
    proc: ChildProcess;
    command: string;
    logPath: string;
    /** Resolves when the process should be backgrounded. Set by timeout or Ctrl+B. */
    triggerBackground: () => void;
    /** Resolves the execute() promise with the given result. */
    resolve?: (result: AgentToolResult<unknown>) => void;
    reject?: (error: Error) => void;
}

// ─── Minimal context interfaces ─────────────────────────────────────

export interface UiContext {
    // Sidecar indexing reads cwd/session identity off the same ctx. Optional
    // so pure-UI call sites (tests, widget-only paths) stay valid.
    cwd?: string;
    sessionManager?: {
        getSessionFile?: () => string | null | undefined;
        getSessionId?: () => string | null | undefined;
    };
    ui: {
        notify(
            message: string,
            level?: "info" | "success" | "warning" | "error"
        ): void;
        setWidget(name: string, content: string[] | undefined): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

// ─── Task ───────────────────────────────────────────────────────────

export type TaskStatus =
    | "todo"
    | "in-progress"
    | "done"
    | "blocked"
    | "cancelled";

export type LinkType = "blocks" | "depends-on" | "related" | "child-of";

export interface TaskLink {
    targetId: number;
    type: LinkType;
}

export interface Task {
    id: number;
    title: string;
    description?: string;
    status: TaskStatus;
    links: TaskLink[];
    createdAt: number;
}

export interface TaskDetails {
    action: "list" | "add" | "update" | "remove" | "move" | "link" | "unlink";
    tasks: Task[];
    nextId: number;
    error?: string;
}

// ─── Goal ──────────────────────────────────────────────────────────

export interface GoalState {
    condition: string;
    setAt: number;
    iterations: number;
}

// ─── Workflow ────────────────────────────────────────────────────────

/** Metadata block extracted from a workflow script's `export const meta`. */
export interface WorkflowMeta {
    name: string;
    description: string;
    phases?: Array<{ title: string; kind: "sequential" | "parallel" }>;
}

/** Cached result from a single agent() call within a workflow. */
export interface WorkflowAgentResult {
    /** SHA-256 hash derived from (prompt, opts). */
    key: string;
    prompt: string;
    opts?: Record<string, unknown>;
    /** Agent output text. */
    result: string;
    completedAt: number;
}

/** State for a single workflow run, persisted in session entries. */
export interface WorkflowRun {
    /** Unique run identifier (format: wf_<alphanumeric>). */
    runId: string;
    /** Workflow name from meta. */
    name: string;
    /** Full script source. */
    script: string;
    /** Persisted script file path (for resume/edit cycle). */
    scriptPath?: string;
    /** User-provided arguments, exposed as `args` global in the script. */
    args?: unknown;
    status: "running" | "completed" | "failed" | "killed";
    startedAt: number;
    completedAt?: number;
    /** Cached agent results for resumability. Keyed by agent cache key. */
    cachedResults: WorkflowAgentResult[];
    error?: string;
}
