# Stale completion handoff requeue

## Change

A rejected completion handoff now records `delivery-requeued`, restores each job to the existing wake-visible pending state with the `stale-send-rearm` trigger, and calls wake evaluation. It no longer records a terminal `cancelled` outcome when the host did not accept the message. A later healthy completion attempt can deliver the notice.

Updated the stale-host regression test to verify requeue followed by a successful retry. Existing ack/kill suppression and shutdown-drop behavior remain covered by the same completion regression suite.

## Files changed

- `src/features/background.ts`
- `src/__tests__/job-completion-regressions.unit.test.ts`

## Validation

- `node --experimental-strip-types --test src/__tests__/job-completion-regressions.unit.test.ts`: 43 passed, 0 failed. Covers stale rejection/retry, ack and kill suppression, and `dropped-at-shutdown`.
- `pnpm test`: 1,690 passed, 0 failed.
- `pnpm check`: passed.
- `git diff --check`: passed.

## Setup and residual risks

- `pnpm install --frozen-lockfile` passed. The worktree's `file:../pi-context` dependency required a temporary sibling symlink at `/home/dev/src/wt/pi-context`; it was removed after validation.
- No known implementation risks. A stale context cannot itself deliver the retry; the notice is restored to wake-visible state for a later healthy attempt.

---

# Heartbeat session-identity fix

## Root cause

pi-tau filtered background-work provider items against the bare UUID returned by `getSessionId()`, while pi-subagents publishes the session identity as `getSessionFile() ?? getSessionId()` (path-first). Since live provider items carry the parent `.jsonl` path, the exact-match filter discarded every child item and the heartbeat saw no sources.

## Changes

- `src/features/wakeup.ts` now resolves its session identity path-first, falling back to the session UUID when no session file is available. A contract comment points to the pi-subagents `session-identity.ts` helper.
- The provider collection returns bounded diagnostic counts and classifies the first unmatched identity as path, UUID, or other without persisting the raw identity. When there are provider items but none match and the heartbeat has no sources, pi-tau appends `heartbeat-skip-no-sources` once per parent idle gap. Telemetry uses the existing best-effort, never-throwing writer. An empty provider list remains silent.
- `src/state.ts` tracks whether the mismatch event has been recorded in the current idle gap; a new parent request resets the rate limit.
- `src/__tests__/wakeup.unit.test.ts` covers path-form matching, UUID fallback without a session file, mismatch telemetry and rate limiting, silence for an empty list, and silence when at least one provider item matches.

## Validation

- Focused: `node --experimental-strip-types --test src/__tests__/wakeup.unit.test.ts` — 33 tests passed, 0 failed.
- Full: `pnpm test` — 1,693 tests passed, 0 failed, 0 skipped; exit 0.
- Typecheck: `pnpm check` — exit 0.
- `git diff --check` — clean.

## Commit

The final commit hash is included in the structured completion report. A Git commit cannot embed its own object hash in `REPORT.md` without changing that hash.
