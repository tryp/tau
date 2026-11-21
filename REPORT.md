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
