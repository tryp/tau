# Background deadline and reminder repair: blocked predeclaration

Date: 2026-10-19. **BLOCKED, incomplete, documentation only. Not an executable
repair contract.** This document records requirements and unresolved decisions;
it authorizes no implementation, imports, tests, timer/process/signalling probes,
deployment, reload, or numerical work. All acceptance cases below are prospective.

## Ownership and incident boundary

The owning repository is `/home/dev/src/pi-tau`, per [AGENTS.md](../AGENTS.md).
The inspected baseline is `56dcebe1b28331b3564f09636fb02d60052a48b9`.
The deployed mirror `/home/dev/.pi/agent/local/pi-tau` is not a development
checkout and must not be edited. No live pi-tau owner was listed during the
2026-10-19 coordination check. The Sippi session authors this document only;
**implementation ownership/handoff is absent**, not implicitly assigned.

The triggering Sippi record is
[canonical shared-edge comparison outcome](file:///home/dev/src/sippi/doc/research/2026-10-19-canonical-shared-edge-comparison-outcome.md)
(Sippi commit `4aa7f8171`). This is a machine-local cross-checkout link, not a
vendored dependency. Its
D6_80 value remains **unknown**, G remains **unrun**, and numerical work remains
frozen. Neither this document nor a future tooling pass authorizes D/G replay,
changes to the numerical 90-second budget, or physics acceptance.

At the inspected baseline, `src/features/background.ts:2663-2714` returns from
the tmux `bash_bg` route before the direct-spawn timeout/reminder registration
at `2717-2789`. The fallback timeout requests SIGTERM only. The tmux helper
polls completion; an exit sentinel or window disappearance is not independent
proof that every owned descendant terminated. This establishes an **on-disk
source defect**, not the incident's loaded implementation. The source defect
explains the incident **if those bytes were loaded**; incident-time loaded
runtime identity is **unknown**, so unconditional causal attribution is blocked.

Both original independent verdicts are preserved unchanged under
`tmp/deadline-repair/2026-10-19/reviews/`:

- `incident-source.log`: source bypass established, causal attribution conditional.
- `incident-ops.log`: overrun accepted, underlying incident attribution blocked.

Original review run:
`/home/dev/tmp/pi-subagents-uid-1001/async-subagent-runs/5ec9a82d-49cb-4054-9710-77630685d797/output-{0,1}.log`.
The complete incident evidence remains in Sippi's
`tmp/accurate-simulation/canonical-pair-comparison/phase2/reviewed/`.
Do not rewrite historical receipts, infer missing monotonic readings, or invent
an exact exit time from UTC, log mtimes, displayed age, or a kill acknowledgement.

## Blocking decisions and phase gates

| Gate | Missing decision/evidence | Current authority |
| --- | --- | --- |
| Independent outer guard | Select a mechanism independent of repaired `bash_bg`, job timers, callbacks and extension lifecycle; inventory static capabilities and failure containment, review it, then obtain explicit capability-check and exact-command authority. No method or capability is established here. | BLOCKED; no probes or harness runs |
| Owning implementation handoff | Identify a live source-repository owner, obtain acknowledgement and bounded writer/file ownership. | BLOCKED; docs author is not an implementation handoff |
| Runtime identity and containment design | Select and review genuine loaded-code provenance and owned-tree containment, including tmux descendants and lifecycle independence. | BLOCKED; no configuration is qualified |
| Implementation | Resolve preceding gates, review an actual bounded source plan, then obtain separate implementation authority. | NOT AUTHORIZED |
| Nonnumerical verification | Authorize an independently guarded harness, exact harmless payloads, commands and evidence location after source review. | NOT AUTHORIZED |
| Deployment/reload | Source commit, acceptance evidence and explicit owner approval; use owning deployment workflow, verify disk content, then establish the newly loaded identity separately. | NOT AUTHORIZED |
| Numerical use | Separate Sippi decision after operations evidence; no automatic unfreeze. | FROZEN |

A guard budget without an authorized, verified mechanism is not supervision.
The independent guard must contain the entire test, including any private tmux
server and descendants; merely killing a wrapper PGID is insufficient if work
escapes it. Its own verification/cleanup cannot depend on the broken path.
Capability-check execution itself needs separate bounded authorization. If that
cannot be supplied, stop with this blocker rather than run an experiment.

## Required execution contract, not implemented guarantees

1. **Distinct policies.** `bash_bg.timeout` is a requested whole-workload kill
   deadline in seconds, not background-after. `jobs.attach.timeout` is wait-only
   and must not kill or modify the job deadline. `remindDelay` is a linked,
   nonterminating notification, not a kill mechanism. Validate finite positive
   timeout/delay values and supported units before starting requested work.
2. **Backend admission.** Inventory tmux-backed background, detached direct
   spawn, and foreground manual/automatic background transfer. For each policy
   combination, either preserve supervision across the full execution path or
   reject unsupported combinations before spawning the requested workload.
   Background transfer never resets the original start/deadline. Modes without
   a requested policy must not be advertised as supervised. Reject supervised
   tmux mode if reliable owned containment cannot be ensured.
3. **Prepare, arm, release.** Requested/prepared/armed/released are distinct
   states. Do not execute payload before genuine supervision is armed and its
   receipt durably persisted. Prefer admission rejection before spawn. If a
   gated wrapper must first be created, payload remains blocked until arming
   and persistence succeed; on failure never release it, perform bounded
   containment cleanup, and report unresolved cleanup honestly. No live payload
   may run through an unsupported or partially armed path.
4. **Lifecycle ownership.** An independently owned supervisor must remain
   responsible until observed terminal state, including reload/session shutdown,
   or the requested mode must be rejected before spawn. Pi documents
   `session_shutdown` during reload and continued execution of the old command
   frame (`pi-mono/packages/coding-agent/docs/extensions.md:1317-1325` at inspection).
   In-memory extension timers alone do not establish lifecycle-independent
   enforcement. Ownership transfer must be explicit and evidenced, not assumed.
5. **Deadline outcome.** Deadline breach never becomes successful execution,
   even if a late exit is zero. Record a termination request separately from
   observation. A signal result, parent-shell exit, tmux-window disappearance or
   stale PID lookup alone does not prove empty owned containment. Cancellation
   and manual kill remain distinguishable from timeout.
6. **Reminder lifecycle.** Require an actual durable armed-queue record, linked
   job identity and owner, not just parsed delay or an intended callback. Emit
   once while eligible, cancel on observed terminal state, and avoid silent
   loss or duplicate delivery across reload. Arming/persistence failure is
   explicit and prevents releasing a payload that requested that policy.

### Prospective finite escalation

Define monotonic payload release `S` and deadline `D = S + timeout`. Arming and
persistence precede release. Record the actual release/deadline observations;
never substitute command launch UTC. If this release/arming protocol cannot be
implemented without an unprotected execution gap, fail closed.

- At D, request TERM for the owned containment unless already proven empty.
- At D+1 second, request KILL once if still live. Unknown ownership/identity is
  not permission to signal unrelated processes; record an enforcement failure.
- At D+2 seconds, end this bounded observation/escalation attempt. Without
  proof of empty containment, record `termination_failed` (known live) or
  `unknown` (unobservable). Retain an unresolved-ownership warning and evidence;
  no repeated signal loop, successful-execution verdict, or false cleanup claim.
- If containment is proven empty, record observed termination and deadline
  outcome, never successful execution after timeout.

These are intended offsets, not hard-real-time guarantees. Late scheduling is
recorded and fails prospective timing acceptance; it is not hidden by shifting
D. A delayed TERM must not restart grace periods. The later implementation plan
must specify overdue-event ordering and prove it cannot prolong the cutoff.
The independent outer guard must bound any remaining cleanup; that guard is
still unresolved, so this sequence is not execution-ready.

## Persisted evidence contract

Persist append-only, crash-detectable job events before releasing requested
work. Each event binds schema version, sequence/job/run identity, command/cwd
identity, backend, supervisor owner, containment identity (PID/PGID with reuse
protection or stable tmux/server/window/run identity), requested policy,
preparation, actual arming and persistence outcomes. Record release, cancellation,
reminder fire/cancel, deadline fire, each termination action, observation source,
and terminal or unresolved state separately.

Runtime provenance must identify the implementation actually loaded, including
relevant modules/supervisor version and the mechanism establishing that identity.
A current disk hash or `.deployed-commit` alone proves neither loaded bytes nor
incident identity. Unknown identity stays explicit and cannot qualify a run.

Store real raw monotonic readings with clock domain/instance and units for
release/start, deadline, arming, fire, signal/action and observed termination;
store UTC separately for correlation. Across clock domains, do not subtract
unrelated readings. Missing observations are null/unknown with reasons. Persist
requested versus actual armed deadlines/reminders distinctly. A sentinel exit
code is evidence only for what it observes; record independent containment
observation and exit status separately. Evidence-write failure cannot be turned
into a successful arm or execution verdict.

## Prospective nonnumerical acceptance matrix — none authorized or run

Proposed OPS-only parameters are frozen for this draft: timeout **2 s**, reminder
**1 s**, harmless sentinel lifetime **10 s**, independent outer bound **15 s per
case**, and **120 s per batch**. These are not armed budgets, capability evidence,
execution authorization, or changes to numerical budgets. A batch may contain
only as many cases as fit; never exceed the batch bound to finish the matrix.
The later exact-command plan must enumerate batches and account for cleanup.

Prospective deadline criteria: actual deadline fire in `[D, D+0.5 s]`, proof of
empty containment by `D+2 s`, and no payload progress after that observation.
Late/missing evidence fails; record actual timing rather than promising real-time
service. Reminder delivery criterion: once in `[S+1 s, S+1.5 s]` while eligible,
or no delivery after an earlier observed terminal state. Deterministic clock/
fault-injection cases may later test boundary races without real sleeps, but
are also unrun and require authorization. No retry/tolerance change follows a
failure without a separate review.

| Case | Required future evidence |
| --- | --- |
| Invalid/nonfinite/nonpositive timeout or delay; unsupported backend/policy | Explicit refusal and independent proof payload was never spawned/released |
| Short normal exit; manual cancellation | Observed terminal state, cancelled deadline/reminder, no later action |
| Long harmless payload, per accepted backend | Requested/armed/released receipts, deadline event, finite escalation, independent observed empty containment |
| Descendant ignoring TERM, including tmux | Own-tree identity, bounded KILL, no surviving descendant; no shared tmux server touched |
| Reminder while live; early terminal cancellation | Exactly-once eligible delivery and durable cancellation; no orphan or duplicate notification |
| Attach wait expiry | Returns without killing or changing original deadline |
| Manual/automatic background transfer | Same release/start, unchanged deadline/reminder and stable ownership, or pre-spawn refusal |
| Arming/persistence failure, including gated-wrapper creation | Payload never released; bounded cleanup status and evidence of unresolved containment if necessary |
| Reload/shutdown | Independently retained ownership/delivery or admission refusal; no unowned live work |
| Identity/drift and termination-observation failures | Honest loaded provenance, unknowns remain unknown, no fabricated success or rewritten history |

Future OPS artifacts belong under this repository's `tmp/deadline-repair/`,
not Sippi's numerical fixtures or shared `/tmp`. The future isolated harness
must not load project numerical payloads. No environment installation or live
tooling changes are part of documenting this matrix.

## Review disposition and next decision

Fresh parallel Luna source/operations review `131962fe-a9f7-4405-adf0-5b6b8971a775`
accepted the direction but **blocked execution/complete-contract acceptance** on
outer-guard authority/capability and incomplete escalation. Follow-up reviews
`e7c6a31d` and `a9149618` accepted only writing this honest BLOCKED document with
finite escalation and explicit unresolved gates. They did not resolve the guard,
assign an implementation owner, or authorize any experiment.

Next decision: obtain an acknowledged owning-repository handoff and a separately
reviewed, explicitly authorized independent outer-guard plan. Until then, pause
this lane at documentation. No repair-completion or numerical-acceptance claim.

## Disposition — 2026-10-19 (owner decision)

Supersedes the blocked status above. The repository owner directed the repair
in the authoring session on this date; the decisions and their grounds are
recorded here without rewriting any prior content.

### Decisions

1. **Finite TERM→KILL escalation is rejected as policy.** Agents set timeouts
   too short; an automatic kill at the deadline destroys in-flight work and
   invites duplicate re-runs. The controlling model is deadline-as-wake: at the
   deadline the agent is woken to inspect progress and decide (extend,
   `jobs kill`, or ignore). The incident itself supports this: the requested
   90-second deadline was tighter than the 84.8 s observed D6_50 runtime, and
   the attach-wait wake plus manual `jobs(kill)` already recovered correctly.
2. **Escalation is also infeasible on the tmux backend as written.** tmux jobs
   carry a `pid: -1` sentinel (`src/features/background.ts:3874` at
   inspection), so PGID signaling cannot reach the workload; the escalation
   sequence could not be implemented on the primary backend without new
   containment machinery.
3. **Incident-time loaded identity is resolved to byte evidence.** A read-only
   `rsync --checksum` comparison of a throwaway `git archive 56dcebe` tree
   against the deployed mirror `/home/dev/.pi/agent/local/pi-tau` found zero
   differences. The deploy was stamped 2026-10-11, predating the 2026-10-19
   incident, with no redeploy since. Residual honesty note retained: this
   proves on-disk bytes, not which bytes the incident-time Node process had
   mapped; it is no longer treated as a blocking gate.
4. **Implementation ownership is resolved** by this repository's AGENTS.md
   deploy model: this checkout is the source of truth and changes ship with
   `make deploy`. The handoff blocker above reflected the authoring session's
   coordination context, not this repository's.
5. **A bounded notification-parity repair is authorized**: the tmux `bash_bg`
   route must honor deadline-wake and reminder requests identically to the
   direct-spawn route (or refuse before spawn), with deterministic unit tests
   pinning the behavior. Executed in isolated parallel worktrees. The
   independent outer-guard, containment-supervision, and append-only
   evidence-platform lanes are closed as disproportionate for this extension;
   containment via manual `jobs(kill)` held in the incident (window killed,
   process scan found no survivors).
6. **The Sippi numerical lane remains frozen.** This repair does not unfreeze
   it, does not replay D6_80 or G, and makes no numerical claims.

### Gate disposition

| Gate | Disposition |
| --- | --- |
| Independent outer guard | CLOSED — rejected as disproportionate (decision 5) |
| Owning implementation handoff | RESOLVED — AGENTS.md deploy model; owner directive 2026-10-19 (decision 4) |
| Runtime identity and containment design | Identity RESOLVED to byte evidence (decision 3); containment RESOLVED as notification parity with honest reporting, no auto-kill (decisions 1, 5) |
| Implementation | AUTHORIZED — bounded notification-parity repair in progress (decision 5) |
| Nonnumerical verification | RESOLVED as deterministic unit tests; the live OPS harness and its 2 s / 1 s / 10 s / 15 s / 120 s parameters were never armed and are now moot |
| Deployment/reload | Governed by the standard AGENTS.md workflow (`make deploy`, verify, `.deployed-commit`) |
| Numerical use | UNCHANGED — FROZEN (decision 6) |

### Contract item disposition

| Item | Disposition |
| --- | --- |
| 1. Distinct policies | ADAPTED — `bash_bg.timeout` becomes a deadline-wake (never kills); `jobs.attach.timeout` stays wait-only; finite-positive validation before spawn |
| 2. Backend admission | ADAPTED as notification parity — tmux route arms the same wake/reminder as the direct-spawn route or refuses before spawn; tmux mode retained |
| 3. Prepare, arm, release | Heavy receipt-blocking form REJECTED; trivial form adopted — policies armed before the "Started background job" return, arming failure surfaced |
| 4. Lifecycle ownership | ADAPTED — linked-reminder persistence reused; orphaned-restore drop fixed; no independent supervisor |
| 5. Deadline outcome | ADOPTED — termination request recorded separately from observed exit; no terminal status assigned on signal request alone |
| 6. Reminder lifecycle | ADAPTED — existing reminder machinery reused on both routes; exactly-once durable queue not built |
| 7. Finite escalation | REJECTED — policy (decision 1) and infeasibility (decision 2) |
| 8. Persisted evidence contract | SLIMMED — deadline/termination fields in existing job records and notifications; no append-only platform (`status.json`/`events.jsonl` is pi-subagents infrastructure, not pi-tau) |
| 9. Acceptance matrix | Case list KEPT as deterministic fake-clock unit tests; live OPS parameters CLOSED, never authorized, never run |
| 10. Review disposition | See gate table above |

Supporting analysis produced during disposition:
`tmp/deadline-repair/2026-10-19/luna-source-trace.md` (source trace at
`f869b07`: tmux route supervision inventory, fallback honesty, reminder
persistence, deployed-byte comparison) and
`tmp/deadline-repair/2026-10-19/luna-proposal-eval.md` (proposal-by-proposal
policy evaluation).
