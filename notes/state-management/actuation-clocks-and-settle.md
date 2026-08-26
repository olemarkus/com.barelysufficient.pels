# Actuation clocks and settle

Design-of-record for the ownership split between **settle** (has my write landed?) and
**cooldown** (may I decide another change yet?). The arc spans three PRs; this note is the
constraint they are all held against.

Read [`observer-transport-split.md`](./observer-transport-split.md) and
[`actuator-write-seam.md`](./actuator-write-seam.md) first — this note assumes the four-box
model and the `planned / commanded / observed / pending` vocabulary.

> Status: **in progress** — PR 1 (executor stops enforcing planner pacing) is the PR that adds
> this note. PR 2 (settle moves into `lib/executor`) and PR 3 (one direction-free actuation
> clock) are outstanding.

---

## Two questions, two layers

| Question | Owner | Shape |
|---|---|---|
| **Settle** — has my write landed, and has the meter seen it? | `lib/executor` | Per device, **evidence-driven**: ends the moment a measurement taken after the write arrives. The window is a *ceiling* on the wait, not the wait. |
| **Cooldown** — may I decide another change yet? | `lib/plan` | Global admission, **policy**: flat window plus an instability backoff, gating `shouldPlanRestores`. |

They look redundant because they are stamped off the same clock and the constant says
*"Base cooldown after restore for power to stabilize"*. They are not. One is a fact about a
write; the other is a decision about the next one.

This matches the rule already written in [`notes/AGENTS.md`](../AGENTS.md): *"planner decides
desired state, observer/device-manager supplies current state and transport, **executor issues
commands and handles pending/materialization**."*

## The crossing

Before this arc, each layer implemented the other's question.

- **Settle lived in the planner.** `lib/plan/planSteppedRestorePending.ts` asks whether a write
  materialized — so `stepCommandStatus` is projected onto `DevicePlanDevice` purely so the
  planner can read `=== 'success'`. (PR 2.)
- **Cooldown was stamped, and enforced, by the executor.** `recordRestoreActuation` writes
  `state.lastRestoreMs` / `lastDeviceRestoreMs` (PR 3) — and `shouldSkipShedding` ran a 5 s
  per-device throttle **inside the write path**, vetoing a shed the planner had already
  decided (PR 1).

That last one is the mirror of `inc_26449fb9`. The incident was *apply-without-decide*: the
executor acting on a decision it had not been handed. The throttle was
**decide-without-apply**: the executor silently dropping one it had. Both are the same
boundary, and `lib/executor/AGENTS.md` now names both directions.

## Why the throttle was deleted, not relocated (PR 1)

The 5 s guard had no job. `shouldSkipShedding` gates two axes, and each already has its own
idempotency and in-flight guards one level down — longer, and on better evidence:

- **Binary** — `shouldSkipBinaryControl` (`lib/plan/planBinaryControlHelpers.ts`):
  `already_matched` (observed state equals desired) and `already_pending` (a matching command in
  flight for the whole confirmation window — 90 s local / 3 min cloud,
  `lib/observer/controlCommandConfirmation.ts`). The pending entry is recorded by
  `dispatchBinaryControlDecision` *before* the write and survives a timeout, so this covers the
  flow-backed path too, where confirmation only ever arrives via telemetry.
- **Shed temperature** — `handleTargetCommandPreflight` (`lib/executor/targetExecutor.ts`):
  `already_matched` on the observed value, plus `getPendingTargetCommandDecision` retry
  suppression, which is unconditional precisely because bypassing it was half of
  `inc_26449fb9`.

The stepped axis never went through `shouldSkipShedding` at all — `applySteppedLoadCommand`
carries its own guards — so nothing there changes.

It also never protected the case it looks like it should: a write that *fails*. The clock it
read is stamped by `recordShedActuation`, which runs on confirmation, on a successful
shed-temperature write, or on a step-down — never on a failed dispatch. So a device whose
writes keep failing was already retried at rebuild cadence, throttle or no throttle.

Meanwhile it could veto a real decision. `lastDeviceShedMs` is stamped by a stepped step-down
(`steppedLoadExecutorCommand.ts`) and by a shed-temperature write (`targetExecutor.ts`), not
only by a binary off. So a stepped device that stepped down, whose next plan escalated it to
fully off because the rung was not enough, had that off write dropped for up to 5 s — under
exactly the capacity pressure that produced the escalation. Pinned by *"sheds a device the
planner escalated to off seconds after its last shed write"* in
`test/integration/planExecutor.test.ts`.

No test ever covered the throttle. The one that claimed to
(`lifecycleEndReleaseNonEv.integration.test.ts`) documented in its own comments that
`lastDeviceShedMs` was never set on that path and that the real gate was the pending record;
its title and comments were corrected in the same PR.

## The rule going forward

- The executor may skip a write only for facts about **the write itself** — the device is
  unreachable, the state already matches, one of my own commands is in flight. Never for how
  recently something else happened.
- Pacing lives in planner admission, where a blocked decision is visible as a plan reason
  rather than a dropped write.
- Direction (`shed` vs `restore`) is a planner conclusion. The executor's contribution to the
  clocks is one direction-free fact — *I wrote to device X at T* — which is why PR 3 can delete
  `recordRestoreOnTargetApply`, `isRestoring`, and the recorder-selection trio.

The instability backoff in `lib/plan/restore/timing.ts:resolveRestoreCooldown` stays, and is
not a settle mechanism: it is *"you keep getting this wrong, slow down."* Do not fold it into
the settle window.
