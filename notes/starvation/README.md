# Temperature Device Starvation Detection v1

> The agent-facing invariants digest for this subsystem lives next to the code in
> `lib/diagnostics/AGENTS.md`; this note is the design-of-record behind it.

This note captures the intended starvation model and the remaining rollout target.
Core intended-target / suppression-state diagnostics now exist in `lib/plan/planDiagnostics.ts`
and `lib/diagnostics/deviceDiagnosticsService.ts`, but flows/insights and any remaining
integration gaps should still follow this note.

> **Model correction (2026-06) — starve only when PELS holds a device below its
> mode target.** The original model below measured starvation by comparing the
> device's PHYSICAL temperature against a deficit threshold derived from the
> intended target. That mislabelled any device sitting below its target — even
> one PELS was commanding in full (`keep`) — as "starved", and the overview
> bucketed those `keep`/paused episodes as a "Manual hold". The shipped criterion
> is now: **a device is starved only when PELS's COMMANDED effective target is
> below its intended/mode target** (`commandedTargetC < intendedNormalTargetC`)
> AND a real counting suppression (capacity/budget/shortfall/…) is active. A
> device PELS commands in full is never starved, however cold it physically is.
> Consequences, reflected throughout the sections below:
>
> - The physical-temperature entry/exit thresholds and the anchor/step-deficit
>   table (`lib/diagnostics/starvationThresholds.ts`) are GONE.
> - `keep` / `inactive` / `invalid_observation` can no longer START starvation.
> - A starved episode always carries a granular counting cause
>   (`capacity` / `daily_budget` / `hourly_budget` / `shortfall` / …), retained
>   across pauses. The `manual` and `external` causes are removed.
> - **There is no overview/badge cause bucket** (removed 2026-08-04). The flat
>   `capacity | budget` fold this document used to specify was overwritten on
>   every accumulation tick, so a device held steadily across a budget-bound and
>   a capacity-bound cycle flipped its badge, its copy, and its rescue button
>   with nothing about the device having changed. The granular counting cause
>   survives and still feeds device detail and the `device_starvation_*` logs;
>   the overview carries `isStarved` and `accumulatedMs` only (`startedAtMs` was
>   removed 2026-08-07 — it had no reader on any surface).

> **v2 — user-initiated budget-exempt rescue (shipped).** The v1 DETECTION model
> below is unchanged: the planner still never auto-mitigates starvation. What v2
> adds is a separate, explicitly user-initiated lane: the starvation-rescue
> dashboard widget (`widgets/starvation_rescue/`) lets a user grant a held-back
> device a bounded smart task with budget leeway and, where the device can honor
> it, lower-priority limiting and pausing. The widget excludes devices that
> already have an open smart task, so the action is a fresh create through the
> same engine as the New smart task widget, not a merge into an existing
> deadline. So the system is no longer "detection-only" for temperature devices —
> but the new behaviour is gated behind explicit user action, not automatic
> mitigation.
>
> **The rescue is offered on both axes** (2026-08-04). It was originally
> budget-only, on the reasoning that capacity is physical. But
> `buildRescueCandidate` always requested `pauseLowerPriorityDevices` and
> `limitLowerPriorityDevices` alongside `exemptFromBudget`, precisely because the
> offering surfaces cannot see which constraint binds — and both of those clear
> room UP TO, never above, the hard cap. So the rescue already worked on a
> capacity-held device; the gate withheld a working action on the strength of a
> bucket that flipped mid-hold. The hard cap is still never raised and never
> suggested as a remedy (`feedback_hard_cap_is_physical`).
>
> The widget's row status chip shows the live duration: `Held back · N min`,
> rolling over into hours past 60 minutes (`Held back · 2 h 15 min`). The "do not
> append duration to the badge" rule in the *Overview UI* section below governs
> the OVERVIEW HERO surface, not this standalone action widget, where the
> duration is the primary signal for choosing what to rescue. The overview device
> CARD does carry the duration, in its one reason line — see
> `notes/ui-terminology.md` § "Device cards say what a device needs".

The detection feature is detection only:

- no priority changes
- no restore-order changes
- no shed-order changes
- no fairness logic
- no automatic mitigation
- no budget adjustment **except** through the bounded weather-advisor loop
  described below (the v2 widget rescue is the other, user-initiated, exception)

## The weather-advisor lane: demand feedback

Weather auto-apply remains explicitly opted in. It changes only the daily
allowance; diagnostics do not change admission, priority, or physical capacity.
Starvation retains its commanded-target entry/clear rules. Budget feedback has
an independent recovery criterion: observed physical temperature.

The annual weather signature predicts typical usage. Budget headroom is the
larger of its annual residual quantile and the recent fortnight's residual
quantile, so occupancy/equipment changes can increase the allowance without
inventing missing energy. Ordinary days use q80; proven unresolved budget
shortfall enables q90 for the trailing 14 usable days.

`budgetDeniedKwh` remains a cumulative diagnostic of all observed unmet-demand
spans below sustainable daily capacity. It is not a magnitude of unmet daily
energy and does not drive the recommendation. Neither legacy hold duration nor
a starvation latch proves how much energy remained unserved.

The revised `budgetUnservedKwh` is separate, persisted per device and local day:

- The planner resolves a metered, eligible temperature device being held below
  its intended target, physically short of that target, with counting cause
  `daily_budget`. Capacity, cooldown, owner holds and task deferrals do not
  contribute. This evidence is not disabled by the old daily-capacity gate.
  Current budget pace must bind without a capacity breach: a carried budget
  reason alone cannot price new intervals after capacity becomes binding.
  Earlier accrued budget evidence remains pending until observed recovery.
- Diagnostics integrates only observed intervals, priced at expected device
  power. Gaps over ten minutes contribute nothing.
- Commanding the intended target does not clear pending evidence. An observed
  temperature reaching the intended target clears that device's pending estimate
  for the current local day. Recovery the following day cannot rewrite a closed
  weather record. Heating/cooling comparisons remain thermostat-owned facts.
- A restart retains accrued evidence but does not price the unobserved gap.
  Old aggregates lack this field; their cumulative counters are not substituted.

At rollup, heater shortfall is `max(0, kwhBudgetCounted + budgetUnservedKwh - appliedBudgetKwh)`.
`kwhBudgetCounted` is the day's usage on the budget's own pacing axis, metered
less budget-exempt kWh hour by hour, read from the daily-budget owner
(`resolveBudgetCountedDayKwh`) and stamped next to `appliedBudgetKwh`. Whole-home
`kwhTotal` also counts exempt load the budget never paced, so it is not used for
the balance. Unused allowance therefore absorbs pending heater demand: a hold with sufficient
spare daily energy calls for pacing/scheduling, not a bigger energy allowance.
Unreliable/missing meter readings cannot prove spare allowance or heater shortfall,
and neither can a record without `kwhBudgetCounted` (rolled up before the field
existed): absent is not zero, and the whole-home total does not stand in.
A finalized, priced task miss remains independent evidence at its deadline
when its recorded delivery blockers establish budget alone. The smart-task
history recorder answers that question (`getBudgetOnlyMisses`, rules in
`lib/objectives/deferredObjectives/budgetOnlyMiss.ts`); the weather rollup only
dates and sizes the misses it is handed. Budget alone means `budget_limited`
is the primary cause and every contributor is either `budget_limited` or a
provably short `control_pending`. `control_pending` covers PELS settling its own
decision (restore or shed cooldown, meter settling, a throttled or queued
restore, startup stabilization) but also `no_decision`, unobserved actuator axes
and convergence that never completes, so it is excused only on interval
evidence: every recorded `control_pending` interval is at most 5 minutes (the
planner's longest settle window, `RESTORE_COOLDOWN_MAX_MS`) and together they
cover at most 15 minutes. A listed `control_pending` contributor with no
recorded interval, or any longer stretch, disqualifies the miss. A
`legacy_unrecorded` contributor (a run that crossed the upgrade) disqualifies
it too: an unrecorded stretch cannot establish budget alone. Device cutoffs and any other contributor
(capacity, priority, control failure, uncontrolled, observation or progress
unavailable, rate or estimate) are mixed blockers and do not qualify. Plan-time
budget exhaustion and floor snapshots do not establish this attribution. It uses `max(0, initialEnergyExpectedKWh - deliveredKWh)` from the
anchored entry figures, never a remaining-energy revision. Missing figures do
not become zero delivery. The larger of heater shortfall and terminal task
shortfall avoids counting one heater task twice.

The correction grows by at most 10 kWh per day from that shortfall or a reliable
measured budget overshoot (`kwhBudgetCounted - appliedBudgetKwh`), whichever is greater. Measured overshoot alone
corrects the allowance without claiming device damage or enabling q90.
Shortfalls below 0.25 kWh do not grow correction or select q90.
On other days it decays by 0.75 and credits up to 10 kWh of reliably unused
allowance. It snaps to zero below 0.25 kWh. `throughDateKey` prevents duplicate
integration, and the planning ceiling (`planningPowerCeiling`: hard cap minus
safety margin, or the grid import target, whichever enabled limit is lower) times
the actual local-day length bounds both the correction and the final suggestion.
With no power limit enabled neither is bounded by a ceiling.

Auto-apply follows the recommendation in either direction. The correction is
already included in that recommendation and cannot veto decreases. Version 3
corrections measure budget-counted energy. Earlier corrections are discarded
on load because neither cumulative holds nor whole-home overshoot can be
reconstructed on this axis. Their cached suggestions are discarded and refitted
at startup; startup alone does not apply a new setting. Measurement history and
the last-applied audit are preserved.

Historical evaluation and reproducible replay instructions are in
`notes/budget-feedback-replay.md`.

## Scope

Starvation applies only to devices that are formally eligible in the PELS device model.

A device is eligible only when all are true:

- supported by PELS
- `deviceType === 'temperature'`
- `deviceClass` is one of `thermostat`, `heater`, `heatpump`, `airconditioning`, `airtreatment` (resolved once by device configuration into `starvationSupported`; the planner reads that flag, never the class)
- device is managed
- device is capacity-controlled
- device is available

Does not apply in this version to:

- generic binary on/off loads
- EV chargers
- other non-temperature devices
- unmanaged devices
- devices with capacity control off

Eligibility must be based on the formal PELS device model and current planner state, not on
vendor-specific diagnostic quirks.

## Core Rule

A device is starved only when both are true:

1. PELS's COMMANDED effective target is below the device's intended/mode target
   (`commandedTargetC < intendedNormalTargetC`, by at least the target step) —
   i.e. PELS is actively limiting the device, not waiting for it to reach a
   target it is already commanding in full.
2. a real counting suppression (capacity/budget/shortfall/…) is active.

This replaces the old "physical temperature below a deficit threshold" rule. A
device PELS commands in full (`keep`) is never starved, however cold it
physically is — that is the device not reaching its own target, not PELS holding
it back.

A hold PELS did not impose — `keep`, `inactive`, a step-up `restore_need` — and
the owner-set holds (`deferred_objective_avoid`, `awaiting_solar_surplus`) PAUSE
a latched episode: they do not start one and they do not add counted time. PELS's
own cooldowns, retry backoff, pending restores and startup reservations do NOT
pause — since 2026-08-08 they count, because the device is still off and PELS is
still the reason (see "Hold / Retry Attribution"). The original counting cause is
retained across a pause for diagnostic attribution.

Starvation is orthogonal metadata, not a new planner state:

- keep `plannedState = keep | shed | inactive`
- keep the existing planner `reason`
- add starvation metadata on top

Required live metadata:

- `isStarved`
- `starvationEpisodeStartedAt`
- `starvedAccumulatedMs`
- `starvationLastResumedAt`
- `starvationCause`
- `starvationPauseReason`

## Normalized Evaluation Inputs

Starvation logic must consume structured per-sample inputs.
It must not depend directly on UI status text or free-form planner reason strings.

Each eligible plan sample must normalize into:

- `eligibleForStarvation: boolean`
- `currentTemperatureC: number | null` (display/telemetry only — NOT the entry signal)
- `intendedNormalTargetC: number | null`
- `commandedTargetC: number | null` (the effective target PELS is commanding now:
  `plannedTarget ?? currentTarget`)
- `targetStepC: number | null` (used as the below-target epsilon, not for a deficit threshold)
- `suppressionState: 'counting' | 'paused' | 'none'`
- `countingCause`
- `pauseReason`

`countingCause` must be one of:

- `capacity`
- `daily_budget`
- `hourly_budget`
- `shortfall`
- `swap_pending`
- `swapped_out`
- `insufficient_headroom`
- `cooldown`
- `restore`
- `restore_throttled`
- `activation_backoff`
- `reserved_for_start`

`pauseReason` must be one of:

- `keep`
- `inactive`
- `restore`
- `deferred_objective_avoid`
- `awaiting_solar_surplus`
- `invalid_observation`
- `sample_gap`
- `suppression_none`
- `unknown_suppression_reason`

`restore` appears in both lists, and the split is which device it lands on:
`restore_pending` / `waiting_for_other_devices` hold a device that is OFF, so
they count; `restore_need` lands on a keep-state device that is ON and merely
wants a step up, so it pauses. Both render the same user-facing label — a user
cannot tell them apart, and does not need to.

Unknown or newly introduced planner reasons should keep explicit `unknown_suppression_reason`
attribution when the device is otherwise held by PELS, rather than disappearing from the starvation
episode. Note this is a PAUSE, deliberately: an unattributable hold is not counted, because
the counting cause is what device detail and the `device_starvation_*` logs report, and a
cause we cannot name is not one worth counting. Adding a new planner reason that holds a
device off means adding it to one of the two tables above.

## Target Used For Evaluation

The intended normal target is the user's normal comfort/storage target:

- use the operating-mode target that represents the user's normal comfort/storage target
- do not include optional cheap/expensive price-optimization deltas in the starvation baseline

The COMMANDED target is what PELS is applying right now: the planned setpoint this
cycle when PELS is applying one, otherwise the held current setpoint
(`commandedTargetC = plannedTarget ?? currentTarget`). When PELS sheds a
thermostat it lowers the commanded target below the intended target; that gap is
the starvation signal.

Changing the intended normal target must not by itself create starvation.

Target-change behavior:

- if not yet starved: reset the pending entry timer
- if already starved: keep the episode latched and do not count anything retroactively

## Below-Target Model

Starvation no longer derives a physical-temperature deficit threshold from an
anchor table. The single comparison is commanded-vs-intended:

```text
epsilon = targetStepC > 0 ? targetStepC / 2 : 0.25
pelsHoldsBelowTarget = commandedTargetC < intendedNormalTargetC - epsilon
```

- the half-step epsilon keeps float/quantization noise from reading an equal
  command as "below"
- `commandedTargetC == intendedNormalTargetC` is never below — a device PELS
  commands in full is never starved
- physical `currentTemperatureC` is carried for display/telemetry only; it does
  not gate entry, accumulation, or clear

## Observation Validity And Continuity

Starvation is evaluated from the commanded vs. intended target: PELS starves a device
only when the target it commands sits below the device's intended (mode) target.
Observed temperature is telemetry/display only — it does not gate entry, accumulation,
or clear. (Earlier versions gated on observed temperature vs. the intended target; that
flagged a device as starved whenever it was physically below target, even when PELS was
commanding the full target and simply not the reason it was cold.)

A sample is valid only when all are true:

- device is still eligible
- `intendedNormalTargetC` is finite
- `commandedTargetC` is finite

(`currentTemperatureC` finiteness is no longer a validity requirement — physical
temperature is display/telemetry only.)

**The age of the device's telemetry is not a validity term (2026-08-30).** There used
to be an `observationFresh` requirement here, which stopped counting once a device had
not reported for 40 minutes. It contradicted the paragraph above — every term that
actually decides starvation (`commandedTargetC`, `intendedNormalTargetC`) is a value
PELS owns, and the device's own readings are display-only — and it inverted the
feature: a Homey driver republishes a capability only on value CHANGE, so a device
held below target is exactly the one that falls silent. Silence means "unchanged",
never "unknown". See `lib/observer/AGENTS.md`.

Continuity rules for v1:

- do not backfill across sample gaps longer than `10 minutes`
- a gap longer than `10 minutes` becomes `pauseReason = sample_gap`
- an invalid sample becomes `pauseReason = invalid_observation`
- invalid samples and long gaps do not advance entry timers
- invalid samples and long gaps do not advance exit timers
- invalid samples and long gaps do not add counted starvation time

The gap that matters is a gap in **PELS's own plan samples** — PELS not deciding about
this device — not a gap in the device's telemetry. A quiet device still gets a plan
sample every cycle, and that sample carries the commanded and intended targets, which is
everything the starvation model reads.

If a device is already starved when samples become invalid:

- keep `isStarved` latched
- pause accumulation
- keep the existing accumulated duration

## Entry Condition

Enter starvation only after all of the following are true continuously for `15 minutes`
across valid contiguous samples:

- eligible managed temperature device
- valid observation
- `suppressionState === 'counting'` with a real counting cause
- `pelsHoldsBelowTarget` (`commandedTargetC < intendedNormalTargetC`)

The entry timer resets on any of:

- PELS no longer holds the device below target (`commandedTargetC >= intendedNormalTargetC`)
- the suppression is not a real counting cause (`keep` / `inactive` / an owner-set hold / any pause)
- invalid observation
- sample gap longer than `10 minutes`
- intended normal target change
- hard reset

## Suppression Attribution

These attribute starvation time after entry — the ceiling causes:

- `capacity`
- `daily_budget`
- `hourly_budget`
- `shortfall`
- `swap_pending`
- `swapped_out`
- `insufficient_headroom`

…and, since 2026-08-08, the holds PELS imposes on itself (see
"Hold / Retry Attribution" for why):

- `cooldown`
- `restore`
- `restore_throttled`
- `activation_backoff`
- `reserved_for_start`

Current planner-text examples that should normalize to these causes:

- `shed due to capacity` -> `capacity`
- `shed due to daily budget` -> `daily_budget`
- `shed due to hourly budget` -> `hourly_budget`
- `shortfall (...)` -> `shortfall`
- `swap pending` -> `swap_pending`
- `swap pending (NAME)` -> `swap_pending`
- `swapped out for NAME` -> `swapped_out`
- `insufficient headroom (...)` -> `insufficient_headroom`
- `cooldown (shedding, Ns remaining)` / `cooldown (restore, Ns remaining)` /
  `meter settling (Ns remaining)` -> `cooldown`
- `restore pending (Ns remaining)` / `waiting for other devices to recover` -> `restore`
- `restore throttled` -> `restore_throttled`
- `activation backoff (Ns remaining)` -> `activation_backoff`
- a hold on another device's startup reservation -> `reserved_for_start`

## Hold / Retry Attribution

> **Rule change, 2026-08-08 (owner ruling): the clock runs whenever PELS has
> turned the device off.** Cooldowns, restore throttling, activation backoff,
> pending/queued restores and startup reservations used to sit in this section as
> pause reasons that "cannot start starvation and do not add counted time". They
> now COUNT. The old split asked *how transient is this hold?*; the rule asks
> *who turned the device off?* — and a device cycling between a capacity hold and
> its own 60 s restore cooldown was never being served, so pausing there
> under-reported real held-back time and withheld the rescue from exactly the
> devices that needed it.

The one question is **who is the reason the device is down**:

- **PELS is the reason → the clock counts.** Capacity, the daily and hourly
  budgets, shortfall, swaps, insufficient available power, *and* every hold PELS
  imposes on itself: shed/restore cooldowns, meter settling, restore throttling,
  activation backoff, pending restores, waiting for other devices to recover, and
  another device's startup reservation. Each keeps its own counting cause, so
  device detail can still tell a cooldown from a reservation.
- **The owner or the device is the reason → the clock pauses.**

Three PELS-commanded holds are a deliberate carve-out from a literal reading of
the rule. PELS did turn these devices off, but at the owner's explicit request,
so flagging `Held back` and offering `Let it run now` would be telling the owner
their own setting is a problem:

- `deferred_objective_avoid` — the device's own smart task is deferring it to a
  cheaper or reserved hour.
- `awaiting_solar_surplus` — the opted-in dump-load posture, whose baseline IS
  off, waiting for export.
- `external_off_hold` — the owner turned the device off outside PELS. Handled one
  level up: it is excluded from starvation ELIGIBILITY
  (`resolveEligibleForStarvation`), which resets accrual rather than latching a
  paused episode, so the classifier resolves it to `none`.

The remaining pause reasons are the states where PELS has not turned the device
off at all, plus the observation-quality ones:

- `keep` / `keep (recently restored)` — PELS is commanding the device in full.
- `inactive (...)` — unplugged or physically unavailable.
- `restore_need` — a keep-state device that is ON and wants a step up.
- invalid observation, sample gap, unknown or unmapped suppression reason.

Behavior in a pause state:

- if not yet starved: reset the pending entry timer (PELS is not holding the device back)
- if already starved AND still held below target: pause accumulation, stay latched
- invalid observations and sample gaps also pause accumulation

The counting causes are strictly a superset of what they were, so the change is
one-directional: **more devices reach `Held back`, and more are offered
`Let it run now`.** What did NOT move is the gate on that offer — entry still
requires 15 continuous minutes of below-target counting suppression, so a device
inside an ordinary 60 s cooldown is nowhere near being offered a rescue. The
day-level censoring totals that feed the weather advisor
(`targetDeficitMs` / `blockedByHeadroomMs`) are derived from `blockCause`, not
from the suppression state, so that bounded loop is untouched by this change.

## Clear (recovery)

There is no physical-temperature exit threshold. Recovery is purely
commanded-vs-intended:

- once PELS commands the full mode target again (`commandedTargetC >= intendedNormalTargetC`
  on a valid sample), stop adding counted time and start a `10 minute` clear timer
- if PELS drops the commanded target back below the intended target before the
  clear timer completes, cancel the clear timer and resume the episode
- clear only after the device has been commanded at/above its full target
  continuously for `10 minutes` across valid contiguous samples

Partial recovery (a still-below commanded target) must not clear starvation.

## State Machine

### Enter

`not starved -> starved`

Enter only after `15 minutes` of continuous qualifying suppression.

### Stay starved

Once entered, starvation remains latched until one of:

- clear criteria are met
- a hard reset occurs

### Accumulate

Add starvation time only while all are true:

- device is already starved
- sample is valid
- `suppressionState === 'counting'` with a real counting cause
- `pelsHoldsBelowTarget` (`commandedTargetC < intendedNormalTargetC`)

### Pause accumulation

Pause starvation accumulation while the sample is invalid, OR PELS is not
holding the device below target via a real counting cause (a `keep`/`inactive`/
`restore_need` pause, an owner-set hold, or a still-below device under a
non-counting suppression). The original counting cause is retained across the pause.

### Clear

`starved -> not starved`

Clear only after PELS has commanded the full mode target
(`commandedTargetC >= intendedNormalTargetC`) for `10 minutes`.

### Hard reset

Clear and reset starvation on:

- `capacity control off`
- device no longer managed
- device no longer capacity-controlled
- app restart
- explicit planner reset / mode reset

V1 restart limitation:

- live starvation episode state is not persisted across app restart
- once-per-episode duration-trigger dedupe state is also reset on app restart
- historical diagnostics windows may remain persisted separately

## Duration Model

Track accumulated starvation time explicitly.

Do not rely on only a single start timestamp, because invalid samples and long plan-sample
gaps must not count.

Entry-qualification time before the starved state begins does not count toward
`starvedAccumulatedMs`.

Externally expose only:

- `starved_duration_minutes`

Do not expose seconds.

Define:

```text
starved_duration_minutes = floor(starvedAccumulatedMs / 60000)
```

Duration-threshold triggers and conditions must compare against the exact millisecond threshold,
not against a rounded display label.

## Flow Cards

Triggers:

- `Device became starved`
- `Device is no longer starved`
- `Device has been starved for at least [minutes]`
- `When [device] became starved`
- `When [device] is no longer starved`
- `When [device] has been starved for at least [minutes]`

Conditions:

- `[device] is starved`
- `[device] has been starved for at least [minutes]`

Duration-threshold triggers must:

- fire once per starvation episode per threshold crossing
- use accumulated counted starvation time, not wall-clock time since episode start
- not fire every planning cycle
- reset when starvation clears
- reset on app restart because live episode state is not persisted in v1

Tags:

- `device`
- `starved_duration_minutes`
- optionally `cause`

## Overview UI

Do not add a top-level overview count.

For each starved device:

- show a `Starved` badge/chip
- do not append `starvedAccumulatedMs` to the primary badge or status text
- show the current starvation duration in detail diagnostics
- show broader unmet-demand window counters as time not served, not as the live starvation duration

Example:

```text
Starved · waiting for available power
```

## Insights, Diagnostics, And Logs

Insights should expose:

- current starved device count
- longest current starvation duration in minutes

These are live values and therefore reset on app restart in v1.

Diagnostics should include, per relevant device:

- `isStarved`
- `starvedAccumulatedMs`
- `starvationEpisodeStartedAt`
- `starvationLastResumedAt`
- intended normal target used for evaluation
- commanded target PELS is applying
- current temperature (display/telemetry)
- active counting suppression cause (retained across pauses)
- active pause reason, if any

Logs should include:

- starvation started
- starvation paused
- starvation resumed
- starvation cleared
- starvation hard-reset
- duration-threshold trigger crossings

## Acceptance Criteria

- starvation applies only to eligible managed temperature devices in the formal PELS device model
- a device PELS commands in full (`keep`) never becomes starved, however cold it physically is
- starvation requires PELS to command the device below its intended/mode target
  (`commandedTargetC < intendedNormalTargetC`) under a real counting cause
- price-optimization deltas do not change the intended-target baseline
- physical temperature does not gate entry, accumulation, or clear (display/telemetry only)
- starvation enters only after `15 minutes` of continuous below-target counting suppression
- invalid observations and sample gaps do not backfill or count as continuous qualification
- every hold PELS imposes counts, including its own cooldowns, retry backoff, pending restores
  and startup reservations (the 2026-08-08 rule)
- holds PELS did not impose (`keep`/`inactive`/`restore_need`) and the owner-set holds
  (`deferred_objective_avoid`/`awaiting_solar_surplus`) cannot start starvation and pause a
  latched episode, retaining its counting cause
- the overview/badge carries NO cause bucket (removed 2026-08-04); the granular
  counting cause serves device detail and the logs
- `capacity control off` clears and resets starvation
- starvation clears only after PELS commands the full mode target for `10 minutes`
- enabling starvation detection does not change planner decisions
- duration-threshold triggers fire once per episode per threshold
- app restart clears live starvation state in v1
