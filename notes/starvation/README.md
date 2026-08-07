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
>   the overview carries `isStarved`, `accumulatedMs`, and `startedAtMs` only.

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

## The weather-advisor lane: a bounded loop, not an exemption

Be honest about what this is. Censoring evidence — how long devices sat held
below target, and with which counting cause — flows one way out of diagnostics
and *does* end up changing `daily_budget_kwh`, which is a planner input. That
closes a loop: planner counting cause → diagnostics → weather → suggestion →
budget → planner. It runs unattended once a day after a one-time opt-in, which
is a weaker gate than the rescue widget's per-incident user action.

So the rule is not "never, unless it isn't the planner". The rule is the set of
bounds that make the loop safe, and **every one of them is load-bearing — a
change to this lane that breaks one is a regression, not a tuning choice**:

1. **Raise-only.** Neither correction can lower a budget. Auto-apply additionally
   refuses to lower one the home has demonstrably been running past — gated on
   the pressure ACCUMULATOR, not on `budgetMayBeLimiting` (devices being held
   back is the ordinary state of a working budget, so gating there would make
   auto-apply a one-way ratchet) and not on the suggestion's displayed
   `budgetPressureKwh` (that is a post-clamp contribution and reads 0 whenever a
   floor or the cap set the number). `lib/weather/weatherAutoApply.ts`.
2. **Opt-in gated.** Nothing is written unless the owner enabled
   `autoApplyDailyBudget`. With it off the loop is display-only.
3. **Fed only by the day-level censoring totals** the diagnostics layer already
   records (`targetDeficitMs` / `blockedByHeadroomMs`), at the same one-hour bar
   the shipped raise-lean used. An earlier draft added a budget-attributed
   counter so capacity-caused holds could be filtered out; it was dropped.
   Instantaneous attribution is the wrong granularity for a daily decision — a
   device blocked by capacity in one hour can still run in another if the DAY
   had more budget — so the filter under-counted real evidence, and on the home
   this was built from capacity was the binding source in 0–8% of rebuilds.
4. **Bounded per day and in total.** ≤ 10 kWh added per day, ≤ 40 kWh
   accumulated, ≤ 50% of the day's prediction when applied, and the whole
   suggestion is still clamped by `capacityLimitKw × 24` and the [20, 360] setting
   bounds. The hard cap always wins; it is physical and is never a remedy.
5. **Leaky.** The *pressure term* decays 0.75/day on any day that did not
   overshoot its budget, so it cannot ratchet — it must be able to discover that
   the budget it pushed up is now more than the home needs. Note this bound
   covers the integral term only: the raise-lean is a binary flag that stays on
   while any day in the trailing 14 carried material budget suppression, so it
   does not decay and must not be treated as if it did.
6. **Once per day, idempotently.** `throughDateKey` makes repeat rollups and boot
   catch-ups no-ops; an unmeasurable day holds rather than growing or decaying.

The planner itself is still not a party to any of it: it reads
`daily_budget_kwh` exactly as before and knows nothing about starvation.

The path:

```
diagnostics day aggregates  (targetDeficitMs / blockedByHeadroomMs)
  → DeviceDiagnosticsService.getDaySuppressionTotals
  → setup/appInit/createWeatherCollector.ts  getDaySuppression
  → WeatherDailyRecord.suppression            (lib/weather/weatherCollector.ts)
  → packages/shared-domain/src/energySignature/  fit + suggestion
  → lib/weather/weatherAutoApply.ts → DailyBudgetService.applyAutoSuggestedBudget
```

Two consumers of the evidence:

- **The raise-lean** (`suggestDailyBudget.ts`): recent suppression widens the
  residual headroom q80→q90. It used to also require a forecast below the heating
  knee, which made the correction hostage to the weather rather than to the
  evidence. Measured on a real incident: the home starved for 3 days and 36
  episodes, and the budget only rose when the forecast happened to cross below
  the knee — +9 kWh in one step, after which starvation stopped.
- **The budget-pressure loop** (`budgetPressure.ts`): a leaky integral term that
  grows by the measured overshoot on days that were budget-suppressed *and* ran
  past their budget, and leaks on every day that did not. It exists because the
  raise-lean is a single fixed nudge and cannot track a mismatch bigger than
  itself. The overshoot condition is the windup guard: short holds are routine,
  so "a device was blocked for an hour" alone would ratchet the budget upward
  forever.

Both consumers read the same evidence and the same one-hour bar, so they cannot
disagree about whether a day was suppressed. Note what the evidence does NOT
say: it records that PELS held devices below target, not which constraint caused
it. That is deliberate — see bound 3.

There is no exception to that list. There used to be one: the smart-task
`pause lower-priority devices` permission was implemented as a proactive shed lane
(`lib/plan/shedding/pauseHold.ts`) and this note carried a carve-out sanctioning it.
That was the wrong call twice over — it shed idle devices for zero relief, and a
carve-out written into a note is the tell that a design has crossed a boundary rather
than a reason it may. The permission is now an *admission* term
(`lib/plan/admission/headroomReserve.ts`, design of record in
`notes/deferred-load-objectives/preemptive-power-reservation.md`): it reserves
available power against lower-priority devices' resumes and sheds nobody, so the
shed order is untouched and the carve-out is void.

The **solar surplus-absorb** lift ("Use solar surplus") only ever *raises* a
target, so it sits outside this note's below-target model entirely and is
structurally starvation-safe (the fit-test keeps it net-neutral, so it neither
starves the lifted device nor manufactures capacity/budget pressure on others).
The full rationale lives in the sibling note
[`surplus-absorb-safety.md`](surplus-absorb-safety.md).

## Scope

Starvation applies only to devices that are formally eligible in the PELS device model.

A device is eligible only when all are true:

- supported by PELS
- `deviceType === 'temperature'`
- `deviceClass` is one of `thermostat`, `heater`, `heatpump`, `airconditioning`, `airtreatment`
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

Cooldown, retry/backoff, restore holds, and other non-counting PELS hold states
PAUSE a latched episode (they do not start one and they do not add counted time):
while paused the device is not being limited right now. The original counting
cause is retained across the pause for diagnostic attribution.

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
- `observationFresh: boolean`

`countingCause` must be one of:

- `capacity`
- `daily_budget`
- `hourly_budget`
- `shortfall`
- `swap_pending`
- `swapped_out`
- `insufficient_headroom`

`pauseReason` must be one of:

- `cooldown`
- `restore_throttled`
- `activation_backoff`
- `inactive`
- `keep`
- `restore`
- `invalid_observation`
- `sample_gap`
- `unknown_suppression_reason`

Unknown or newly introduced planner reasons should keep explicit `unknown_suppression_reason`
attribution when the device is otherwise held by PELS, rather than disappearing from the starvation
episode.

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

## Observation Freshness And Continuity

Starvation is evaluated from the commanded vs. intended target: PELS starves a device
only when the target it commands sits below the device's intended (mode) target.
Observed temperature is telemetry/display only — it does not gate entry, accumulation,
or clear. (Earlier versions gated on observed temperature vs. the intended target; that
flagged a device as starved whenever it was physically below target, even when PELS was
commanding the full target and simply not the reason it was cold.)

A sample is valid only when all are true:

- device is still eligible
- `observationFresh === true`
- `intendedNormalTargetC` is finite
- `commandedTargetC` is finite

(`currentTemperatureC` finiteness is no longer a validity requirement — physical
temperature is display/telemetry only.)

Continuity rules for v1:

- do not backfill across sample gaps longer than `10 minutes`
- a gap longer than `10 minutes` becomes `pauseReason = sample_gap`
- an invalid sample becomes `pauseReason = invalid_observation`
- invalid samples and long gaps do not advance entry timers
- invalid samples and long gaps do not advance exit timers
- invalid samples and long gaps do not add counted starvation time

If a device is already starved when samples become invalid:

- keep `isStarved` latched
- pause accumulation
- keep the existing accumulated duration

## Entry Condition

Enter starvation only after all of the following are true continuously for `15 minutes`
across valid contiguous samples:

- eligible managed temperature device
- fresh valid observation
- `suppressionState === 'counting'` with a real counting cause
- `pelsHoldsBelowTarget` (`commandedTargetC < intendedNormalTargetC`)

The entry timer resets on any of:

- PELS no longer holds the device below target (`commandedTargetC >= intendedNormalTargetC`)
- the suppression is not a real counting cause (`keep` / `inactive` / cooldown / any pause)
- invalid observation
- sample gap longer than `10 minutes`
- intended normal target change
- hard reset

## Suppression Attribution

These attribute starvation time after entry:

- `capacity`
- `daily_budget`
- `hourly_budget`
- `shortfall`
- `swap_pending`
- `swapped_out`
- `insufficient_headroom`

Current planner-text examples that should normalize to these causes:

- `shed due to capacity` -> `capacity`
- `shed due to daily budget` -> `daily_budget`
- `shed due to hourly budget` -> `hourly_budget`
- `shortfall (...)` -> `shortfall`
- `swap pending` -> `swap_pending`
- `swap pending (NAME)` -> `swap_pending`
- `swapped out for NAME` -> `swapped_out`
- `insufficient headroom (...)` -> `insufficient_headroom`

## Hold / Retry Attribution

These are pause reasons, NOT counting causes. They cannot start starvation and do
not add counted time; on a latched episode they pause accumulation (the device is
not being limited right now) while retaining the original counting cause:

- `cooldown (...)`
- `restore throttled`
- activation backoff
- `inactive (...)`
- `keep`
- `keep (recently restored)`
- `restore (...)`
- `deferred_objective_avoid`
- unknown or unmapped suppression reason

Behavior in these states:

- if not yet starved: reset the pending entry timer (PELS is not limiting the device)
- if already starved AND still held below target: pause accumulation, stay latched
- invalid observations and sample gaps also pause accumulation

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

Pause starvation accumulation while the sample is invalid/stale, OR PELS is not
holding the device below target via a real counting cause (a `keep`/`inactive`/
cooldown/restore pause, or a still-below device under a non-counting suppression).
The original counting cause is retained across the pause.

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

Do not rely on only a single start timestamp, because stale observations and long sample gaps must
not count.

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
- non-counting holds (cooldown/backoff/restore/keep/inactive) cannot start starvation and pause a
  latched episode, retaining its counting cause
- the overview/badge carries NO cause bucket (removed 2026-08-04); the granular
  counting cause serves device detail and the logs
- `capacity control off` clears and resets starvation
- starvation clears only after PELS commands the full mode target for `10 minutes`
- enabling starvation detection does not change planner decisions
- duration-threshold triggers fire once per episode per threshold
- app restart clears live starvation state in v1
