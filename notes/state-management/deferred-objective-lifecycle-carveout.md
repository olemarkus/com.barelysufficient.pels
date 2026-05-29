# Lifecycle off the planner: clock-driven smart-task producer + direct disable actuator

Status: **design — second verification pass.** Supersedes the first draft (which proposed a
generic "device-prep layer"; that framing was revised after round-1 review — see *Verification
status*). Reviewers: this is the current design — attack it.

## Goal (two-fold, one decoupling)

The smart-task (deferred-objective) lifecycle should come off the planner on **both ends**:

1. **Off the planner's clock (input).** Lifecycle state is *clock-driven* (deadline,
   hours-remaining, progress vs time). The planner is *reactive* — driven by power samples and
   device events. Today `buildDeferredObjectiveDiagnostics` runs **inside** `planBuilder`, so
   lifecycle state only advances when a power event wakes the planner. **Concrete bug:** in
   `power_source = flow` mode, plan cycles can be hours apart, so deadline transitions / ended
   events / hours-remaining crossings **lag until the next power event**. The lifecycle needs
   its own clock tick.

2. **Off the planner's path (output).** The terminal turn-off is currently smuggled out as a
   per-cycle `shed_release` plan intent riding the capacity shed actuation path. It should
   actuate **lifecycle-actuator → transport**, on the lifecycle's own clock — never through
   the plan→executor capacity path.

## Vocabulary (load-bearing)

- **Shed** = a *capacity cause* ("over budget → reduce load"). Stays "shed" in the plan path;
  that path genuinely sheds.
- **Disable / limit** = the *effect*: drive a device to its configured **fallback posture**
  (fully off = disable; stepped-down / lower setpoint = limit).
- **Lifecycle-end** = a *different cause* invoking the **same** disable/limit effect (task done
  → return device to fallback). It is **not** a shed.
- **Shared reason-blind effect primitive**: "drive device to posture P." Both capacity-shed
  and lifecycle-disable invoke it; the causes live in their own layers.
- Today's `shedBehavior` / `OVERSHOOT_BEHAVIORS` config *is* the device's fallback posture.
  Renaming that config vocabulary touches settings keys + UI + logs — a **follow-up**, not in
  scope here.

## Target architecture (three components)

1. **Clock-driven lifecycle producer** — the existing `lib/plan/deferredObjectives/` subsystem
   (status `statusBus`/`statusTransitions`, lifecycle `activePlanRecorder`, `endedEventBus`,
   horizon `rescueReplan`/`policyHorizon`), **relocated out of `lib/plan`** (expand
   `lib/objectives/` or a new `lib/smartTasks/`) and advanced on its **own clock tick**. Pure:
   emits flat facts (status, decision, ended event, deadline floor, boost request). It already
   has non-plan consumers (`flowCards/deadlineObjectiveCards.ts`, `smartTaskTokens.ts`,
   `smartTaskRescueCard.ts`) — evidence it is a producer, not plan-internal.

2. **Clock-driven lifecycle actuator** — on each lifecycle tick, for any task in a **terminal**
   state on a **`controllable === false`** device still observed `on`, drive it to its
   configured fallback posture (**disable/limit**) via the **transport**. Self-healing
   (per-tick re-check survives dropped writes / unknown-observation), idempotent (observed-on
   gate), no flow-mode lag (clock-driven). Writes at the executor/transport layer, wired by
   `app.ts`. This is today's release-actuation logic, decoupled from the capacity path and
   re-homed onto the clock loop. It is **not** a one-shot.

3. **Power-driven planner** — `lib/plan`, reactive. Consumes the producer's **flat facts** for
   cross-device arbitration (boost/caps/floor during active hours); decides capacity **sheds**,
   which invoke the same disable/limit effect via the executor. No objective lifecycle inside.

**No second-writer contention:** the lifecycle actuator only touches `controllable === false`
devices — exactly the ones the planner has let go of (`shouldEmitTerminalRelease` already gates
on this). The "caps-off-first, then disable" ordering is structural, not timing-dependent.

## Capacity-marker fix (increment 1 — the live bug, independent)

Separate from the relocation. The live bug: the **binary** disable path stamps capacity cooldown
markers (`applyShedReleaseBinaryOff → applyBinarySheddingToDevice → recordShedActuation`,
`binaryExecutor.ts:542`), polluting `lastInstabilityMs` / `lastDeviceShedMs` for a non-capacity
event → mis-paced restores. (Temperature & stepped paths already route through the
diagnostic-only recorder; the binary axis was missed.)

Fix: route the binary disable through a **reason-blind disable dispatch off the capacity path**
(records diagnostics only, skips `shouldSkipShedding`/`pendingSheds`, keeps the observed-on gate).
**It must cover flow-backed devices too:** for flow-backed binary control the marker stamp is
deferred to `handleConfirmedBinaryCommand` on a later cycle, and the `pendingBinaryCommands` entry
carries no release-vs-shed discriminator — so tag the pending entry with a lifecycle-release
discriminator (a dedicated field, **not** overloaded `logContext`) and branch
`handleConfirmedBinaryCommand` to the diagnostic-only recorder. Without this, flow-backed binary
devices keep polluting the markers — the exact population this serves. Plus the marker-ownership
corrections the round-1 pass forced:
- Per-device shed marker (B) becomes **plan-decision-time, edge-set, NOT cleared on departure**
  (recovering readers compare it vs `lastRestoreMs`, `candidates.ts:452`).
- **Do not** naively drop the executor `lastInstabilityMs` stamp — the plan stamps it only on a
  *fresh shed selection* (`buildSheddingPlan.ts:174`), not on reconcile-after-drift re-sheds
  (`binaryExecutor:542`, `steppedLoadExecutor:377`, `targetExecutor:115/179`); cover reconcile
  or explicitly accept the relaxed restore back-off.
- Defer a separate write-time field (C) — onset serves the throttle + reconciliation acceptably.
- `logContext`/`capacity_control_off` demotion is a **pure rename**, NOT a persisted-state
  migration: it is a runtime reason-code enum with zero `settings.get/set`, and `lastDeviceShedMs`
  is itself in-memory only. The rename must update the shared-domain log helper
  (`planReasonSemanticsCore.ts`) in the same change for log parity
  (`feedback_ui_text_shared_with_logs`).
- Capture the two extra direct stamp/read sites (`binaryExecutor:498`, `:126`).

The lifecycle-end **EV pause** (`ev_pause` via `applyDeferredEvCommand`) is the same bug on the
EV axis — a binary `evcharger_charging` off through a sibling call site — and is fixed identically
(`lifecycleRelease` + skip the capacity throttle). The EV charger is the primary smart-task device,
so it must not be left polluting; increment 1 covers both the non-EV `shed_release` and the EV
`ev_pause` lifecycle disables.

This is the first down-payment on goal 2 (disable off the capacity write path), supersedes
#1249, and is shippable now.

## Verification status (round-2 findings)

- **Relocation REQUIRES a `PlanInputDevice` type-hoist** (corrects the earlier claim that it
  doesn't). Today `plan → deferredObjectives` is a runtime edge (`planBuilder.ts:53-62`) and
  `deferredObjectives → planTypes` is a type edge (×7) — bidirectional, kept legal only because
  both halves sit inside `lib/plan`. Splitting it is a real `no-circular` violation (this cruiser
  config sets no `tsPreCompilationDeps`, so `import type` does not save it). `lib/objectives/` is
  additionally forbidden by `no-objectives-to-peer-except-power`. Precondition: hoist
  `PlanInputDevice` (+ its `planTypes` type-only deps) into a shared contract (`lib/planContract`
  or `packages/contracts`); a new `lib/smartTasks/` peer is viable only after that and needs its
  own dep-cruiser rule. The clock loop wires in `setup/`.
- **`concurrentEligibleCount` is a producer-owned per-bucket RESOLVER, not a flat input.** It is a
  stateful `ConcurrentEligibleTaskTracker` (cross-cycle grace map, per-bucket deadline filter)
  returning `(bucketStartMs) => number`. The producer must own the tracker + closure; the seam
  carries stateful bucket-parameterized logic, not a scalar.
- **The one-shot lifecycle manager was a self-heal downgrade** — replaced by the clock-driven
  per-tick self-healing actuator above.
- **The lifecycle state tracking already exists** — this is relocation + re-clocking, not new
  machinery.

## Increments

1. **Now:** reason-blind binary-disable dispatch off the capacity path + marker-ownership
   corrections. Supersedes #1249. Independent, shippable, fixes the live bug.
2. **North-star program (separate, multi-PR):** relocate the lifecycle subsystem out of
   `lib/plan` onto its own clock loop (producer) + the clock-driven disable actuator (completes
   goals 1 & 2); untangle `concurrentEligibleCount` into a flat capacity input. ~40 files;
   introduces a second loop.

## Open questions / risks (reviewers, attack these)

1. **Two loops (clock + power) touching shared state** — what snapshot/ordering discipline
   prevents the planner reading half-updated lifecycle state? Today's single loop sidesteps
   this; is immutable-per-tick-snapshot sufficient, and where does it live?
2. **Headroom-coupling extraction** — is `concurrentEligibleCount` cleanly expressible as a flat
   capacity input, or more entangled than it looks (it counts *objectives*, not just power)?
3. **Clock tick mechanism** — timer granularity (minute-ish?), restart behavior, DST 23/25 h.
   Does the actuator's per-tick self-heal hold in `flow` mode and across restart?
4. **`controllable === false` gate** — does it *fully* prevent lifecycle/planner write
   contention, including transitional cycles where a task is ending as caps releases?
5. **Relocation import graph** — does moving `deferredObjectives` out of `lib/plan` create
   cycles, given it consumes `lib/objectives`/`lib/dailyBudget`/`lib/power` and produces
   `PlanInputDevice`-shaped facts?
6. **Increment 1 independence** — is the binary-disable fix truly shippable without the
   relocation, and does it pass the five #1249 regression findings?
7. **Vocabulary churn** — is the shed/disable-limit split clarifying or confusing; is partial
   adoption (new actuator only, retained "shed" config) coherent?
