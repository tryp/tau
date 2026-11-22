# Process priority prototype

## Change map

- `src/priority.ts:33` config; `:64` argv construction; `:75` typed Node child spawn wrapper; `:103` async best-effort elevation.
- `src/index.ts:130` starts `elevateMainThread()` at extension initialization; `:832` appends `priority-counters` to the session on shutdown.
- `src/features/background.ts:231` routes background `bash -c` through `spawnDemoted`.
- `src/features/agent-background.ts:265` routes detached `pi` agents through `spawnDemoted`.
- `src/features/workflow.ts:331` routes workflow agent invocations through `spawnDemoted`.
- `src/__tests__/priority.unit.test.ts:19` argv/config/failure-path cases; `:82` actual child-vs-parent `/proc` nice check.

## Configuration and behavior

Global settings may contain `"tauPriority": { "mode": "elevate", "demotion": "nice", "childNice": 19 }` in `~/.pi/agent/settings.json`. `PI_PRIORITY=off|elevate|demote` overrides the mode. Default is `elevate`: attempt to raise pi's own process to nice 0, while routing the load-producing direct child spawns through `nice -n 19 --`. Mode `off` disables both; `demote` leaves child demotion enabled while skipping elevation. `demotion: "idle"` selects `chrt --idle 0 --` instead. Child nice is clamped to 1..19.

Elevation uses `/usr/bin/prlimit --pid PID --nice=HARD:HARD` then `/usr/bin/renice -n 0 -p PID`. It reads the hard limit from `/proc/self/limits`, caps at nice 0, handles non-Linux/missing limits/zero or invalid hard limit/missing execs/timeouts without throwing, and logs/counts skips. This uses existing unprivileged utilities rather than adding a native binding for Node's missing setpriority/setrlimit APIs. It runs asynchronously with short exec timeout, so extension startup does not await it.

Counters are appended as a `priority-counters` session entry during `session_shutdown`, not sent as model context. Counters include elevation-applied, elevation-skipped keyed by reason, children-demoted, and demotion-unavailable.

## Evidence

`src/__tests__/priority.unit.test.ts` starts a real `nice`-wrapped child and reads Linux `/proc/<pid>/stat` field 19 (nice) for child and parent. It first invokes the same elevation helper used at extension initialization. Focused test passed: 5 tests, 5 passed. Independent runtime probe ran `node --experimental-strip-types --input-type=module -e '…'` in this worktree and observed `{pid:702764,parentNice:"0",childPid:702773,childNice:"19",field:19}`. Thus the main process after the elevation helper was nice 0 and a real spawned child was nice 19. This is a helper/startup-path probe, not a live full pi UI session.

## Spawn inventory

- `src/features/background.ts` direct `bash -c`: routed through `spawnDemoted`; CPU-heavy user batch commands are the workload of concern.
- `src/features/agent-background.ts` detached `pi`: routed through `spawnDemoted`; agent subprocesses can run batch work.
- `src/features/workflow.ts` workflow agent command: routed through `spawnDemoted`; workflow subprocesses can run batch work.
- `src/tmux.ts` `spawnInTmux` pane: deliberately not routed in this prototype. An attempted wrapper replaced the executable wrapper script and broke its session creation/exit-sentinel bookkeeping; tmux lifecycle tests failed. Change was reverted to the base implementation. Do not claim tmux pane demotion is active.
- `src/tmux.ts` `execSync`/`spawnSync` management calls: deliberately not routed; these are bounded tmux/git discovery and control-client operations, not launched workload processes.
- `src/features/bash-tmux.ts` foreground/background helpers: use the `spawnInTmux` path above; pane command remains at inherited priority because the pane exec is done by the tmux server.
- `src/features/web-browse/applescript.ts` `execFile`: deliberately not routed; short AppleScript UI automation, not a batch compute producer.
- `src/features/web-browse/index.ts`, `cdp.ts`, `github-structure.ts` exec calls: deliberately not routed; browser/CDP and bounded git/tree inspection helpers, not the pi batch workload.
- `src/features/handoff.ts` exec calls: deliberately not routed; bounded git/osascript/tmux session-control operations.
- `src/utils.ts` `notifyutil` execFile and `src/notifications/terminal.ts` PowerShell notification: deliberately not routed; short platform notification probes/delivery.
- Test-only `child_process` imports under `src/__tests__`: deliberately not routed; they are test harness processes, not extension runtime work.
- LSP servers: launched by pi's host, outside these extension spawn sites; deliberately left at inherited nice 19 pending hover-latency measurement.

## Gates

Baseline on the clean base `bde208b` before edits: `pnpm test` 1693 passed / 0 failed; `pnpm check` passed; `pnpm lint` passed.

After-change: `pnpm test` 1698 passed / 0 failed; `pnpm check` passed; `pnpm lint` passed.

## Deliberately not done and retirement event

The tmux server is pi's parent. Its pty echo hop remains at inherited nice 19 until tmux is restarted from an elevated launcher. LSP children remain at nice 19 until hover latency is measured and shows a need. This is a scoped prototype, not a claim that every child in the tree is demoted.

Retire this transitional mechanism when pi/core or Node exposes supported priority-setting and spawn-priority APIs and a tested host-level policy can replace the wrappers, or when measured UI latency shows the split is no longer needed. Revisit tmux pane routing after a wrapper design can preserve its bookkeeping and pass the lifecycle suite.

## Review finding (parent session, 2026-11-22)

The inventory above says LSP servers "remain at nice 19". That holds only for
servers started *before* elevation. `nice` is copied at fork, so anything the
elevated main thread spawns afterwards inherits `nice 0`:

    renice: 715666 (process ID) old priority 19, new priority 0
    self nice: 0, unwrapped child nice: 0

Verified by running the same prlimit+renice sequence and then spawning an
unwrapped child and reading `/proc/<pid>/stat` field 19. LSP servers are spawned
by the pi host, not by any extension spawn site, so they are exactly the
unwrapped case: after this prototype elevates, every restarted `marksman` runs at
interactive priority.

That is the failure mode the two-sided design exists to prevent, and it is why
this branch is not landed. To land it, either route the host's LSP spawn through
the demotion helper (core support, or a wrapper the extension owns), or ship
`mode: "demote"` as the default so demotion is active and elevation stays opt-in.
Demotion alone is monotone and safe today: the routed children are already at
nice 19 by inheritance, so the wrapper only makes that explicit and keeps holding
once elevation is enabled. Elevation should stay opt-in until both the LSP spawn
and the tmux pane command are routed, because those two are where the load and
the tooling actually live.
