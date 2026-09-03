# Actuation clocks and settle

Design-of-record for the ownership split between **settle** (has my write landed?) and
**cooldown** (may I decide another change yet?). This note is the constraint the whole arc is
held against.

Read [`observer-transport-split.md`](./observer-transport-split.md) and
[`actuator-write-seam.md`](./actuator-write-seam.md) first — this note assumes the four-box
model and the `planned / commanded / observed / pending` vocabulary.

> Status: PR 1 (executor stops enforcing planner pacing) and PR 2 (executor stops round-tripping
> through the planner for its own command state) are shipped. The pending-restore reservation is
> removed (below). The remaining open item is not in this note: it is whether the restore
> cooldown's base 60 s is long enough, recorded under "Accepted, and open" below.

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

- **The executor asked the planner about its own commands.** `executableSteppedLoadProjection.ts`
  called `lib/plan/planSteppedRestorePending.ts:resolveSteppedRestoreAttemptState` — twice, with
  identical arguments — to learn whether one of its own step commands was awaiting confirmation
  or in retry backoff. It discarded every planner number that came back (requested/baseline/delta
  kW, the countdowns) and read only `status`. It also called without a write clock, so the
  meter-settle branch could not fire; `awaiting_power_settle` was an unreachable variant in the
  executor-facing type. Closed in PR 2 by `lib/executor/steppedCommandAttempt.ts`.

  Note what this was **not**: `stepCommandStatus` arriving on `DevicePlanDevice` is producer-
  stamped by `setup/appDeviceControlHelpers.ts` from the runtime command store — the clean/
  trusted pattern working as intended, not a layering breach. An earlier draft of this note
  called the planner's whole restore-attempt composition a crossing; that was too broad. The
  planner composing ITS reservation with command state it was handed is its own business.
- **Cooldown was stamped, and enforced, by the executor.** `recordRestoreActuation` writes
  `state.lastRestoreMs` / `lastDeviceRestoreMs` (PR 3) — and `shouldSkipShedding` ran a 5 s
  per-device throttle **inside the write path**, vetoing a shed the planner had already
  decided (PR 1).

The meter-settle question (`measurementTs` vs the write clock) is still in the planner —
`restore/support.ts:computePendingRestorePowerKw`, `restore/accounting.ts`, and the power-settle
branch of `planSteppedRestorePending.ts`. That is a crossing and it moves in PR 3. An earlier
draft of this note argued it rightly stayed because it sits next to the restore reservation it
qualifies; **OWNER RULING (2026-08-27) overrides that**: *"if they are related to settlement, then
planner has no business with them. if they are related to cooldowns, they belong in planner
only."* The reservation is the planner's; the evidence that the write has been measured is not.

That rule is also the sizing test for PR 3, and it makes it much smaller than a clock-by-clock
migration would suggest. Classified by the question each READ serves rather than by which field
it touches, nearly every planner read of `lastDeviceRestoreMs` / `lastDeviceShedMs` /
`lastInstabilityMs` is cooldown and is already in the right layer:
`planHeadroomState.ts` (per-device countdowns), `planDevices.ts:isRecentlyRestored` and
`shedding/overshoot.ts` (re-shed grace), `planShedRecovery.ts` (restored-since-shed ordering),
`planBuilderOvershoot.ts` (attribution, whose purpose is to block that device's restore), and
`restore/timing.ts` (the cooldown and its backoff ladder). Those stay. Only the settlement
cluster above moves.

That last one is the mirror of `inc_26449fb9`. The incident was *apply-without-decide*: the
executor acting on a decision it had not been handed. The throttle was
**decide-without-apply**: the executor silently dropping one it had. Both are the same
boundary, and `lib/executor/AGENTS.md` now names both directions.

## Why the throttle was deleted, not relocated (PR 1)

The 5 s guard had no job. `shouldSkipShedding` gates two axes, and each already has its own
idempotency and in-flight guards one level down — longer, and on better evidence:

- **Binary** — `shouldSkipBinaryControl` (`lib/plan/planBinaryControlHelpers.ts`):
  `already_matched` (observed state equals desired) and `already_pending` (a matching command in
  flight for the whole confirmation window — 90 s, `CONTROL_COMMAND_CONFIRMATION_MS`,
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

### A third outcome: the write nobody answered

"Failed" and "succeeded" are not the whole set. A write PELS abandons — the transport's own
timeout on the native channel, the trigger-acceptance timeout on the Flow one — is **unknown**:
the command may still be on its way. `binaryControlDispatch.ts` resolves that case exactly like
a slow success and lets the settle window decide, and `executeSteppedLoadCommand` does the same
for the stepped axis. The pending record is written with confirmation still `required`, so the
device is not settled and observed truth keeps coming only from telemetry.

The cooldown clocks are stamped as if the command landed, in **both** directions. Every clock
here is restrictive with respect to future actuation — `recordShedActuation` writes
`lastInstabilityMs`, which drives the exponential restore back-off, and `recordRestoreActuation`
writes `lastRestoreMs`, the restore cooldown itself — so assuming an unconfirmed write happened
delays the next resume whichever way it went, and a resume is the direction that adds load.

Skipping a stamp is the aggressive choice, not the cautious one. If an unacknowledged step-up
did land (the common case for a socket abandoned on a slow-but-alive hub) and nothing stamps the
clock, the next rebuild may resume another device with no cooldown at all, stacking load onto a
meter that has not yet seen the first increase. Both clocks are home-wide, so neither direction
is the safe one to skip on blast-radius grounds; the tie is broken by which way the error points.

What an unacknowledged write must not do is conclude something about the **device**. It opens no
starvation activation attempt — that is a claim the device began drawing, on evidence that never
arrived.

Abandoning the wait is not the same as closing the socket. The request stays open
purely so its answer can be recorded — a cloud device's owning app can take 22-60 s
to reply, and that reply is the only place its real error is ever visible
(`homey_request_late_response`). A late 2xx there is worth reading: it says the
write LANDED after PELS stopped waiting, which is the one fact an unknown outcome
cannot learn on its own.

For the same reason an unacknowledged write arms no target-power reachability probe: a probe
that settles unobserved records a failure and backs off 15-60 minutes, which would let an
abandoned socket conclude the charger cannot reach a rung it was never seen to refuse. The
pacing that used to be credited to the cooldown comes from the pending record's own retry ladder
(`STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS`, 30 s → 2 m → 5 m → 15 m).

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

## The pending-restore reservation, and why it was removed

Removed 2026-08-28, with nothing put in its place. `reserveHeadroomForPendingRestores`
(`lib/plan/restore/support.ts`), `computePendingRestorePowerKw` (`restore/accounting.ts`) and the
stepped power-settle branch of `planSteppedRestorePending.ts` all held headroom back for a device
that had been restored but had not yet drawn.

**The reason is not tuning.** It is that the release condition cannot be evidenced.

- **The whole-home meter is a sum, so it cannot attribute.** A heater switching off while a
  charger starts nets to roughly nothing on the main meter — indistinguishable from the charger
  never starting. No window length fixes that; the signal is absent, not attenuated. Any
  settle rule keyed on the whole-home reading is unsound *in principle*.
- **The stepped branch was inert anyway.** It released on `measurementTs > lastRestoreMs` — the
  next sample. Samples arrive every 3–4 s; an EV charger takes 14–30 s just to apply the step. The
  reserve was gone before the device had begun.
- **The binary branch's confirm-on-draw was sound but was not the protection.**
  `actualKw >= expectedKw * PENDING_RESTORE_CONFIRMED_FRACTION` reads the DEVICE's own
  `measure_power`, which is attributable. But it only ever released *early*; what actually held
  the line was `PENDING_RESTORE_WINDOW_MS = 3 min`. Strip the confirm check and protection is
  unchanged. Strip the window and there is none. It was a timer with an early exit.

So the mechanism was a second pacing timer competing with the restore cooldown, sized against one
fixed window for a 20 s-to-never distribution. Two timers for one question is what produced the
both-ends-wrong behaviour the P1 recorded: under-hold at the tail, over-hold for a car that never
draws.

**What protects now:** the planner's restore cooldown, alone. That is the correct owner under the
settlement/cooldown split above — pacing is planner admission — and it is the only mechanism whose
ceiling can bracket the tail, since its backoff ladder reaches 5 minutes where the reservation's
window stopped at 3.

**Accepted, and open:** the cooldown's base 60 s does not reach the measured p90 of 129.7 s, and it
extends only via a backoff keyed on instability rather than on restore latency. Removing the
reservation therefore keeps the protection that was actually load-bearing and loses none that was —
but whether that protection is *enough* is a separate question, still open: that p90 is the
measurement any resizing of the cooldown has to answer to.

### The rule this leaves behind

**`lib/power` answers "how much room is there". It cannot answer "did my write land".** The first
is a capacity question about a sum; the second is attribution, and a sum cannot attribute. Anything
that needs to know whether a specific device responded must read that device — never the
whole-home meter. This note previously proposed a `lib/power`-owned reservation released on the
main meter's sample clock; that design was wrong on both counts and was never merged.

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
