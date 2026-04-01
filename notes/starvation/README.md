# Temperature Device Starvation Detection v1

This note captures the planned temperature-device starvation model for future work.
It does not describe the current implementation.

The feature is detection only:

- no priority changes
- no restore-order changes
- no shed-order changes
- no fairness logic
- no automatic mitigation
- no budget adjustment

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

1. it is thermally under-served relative to its intended normal target
2. PELS is actively suppressing it for a counting cause

A device must not become starved merely because it is below target while the planner is in
`keep`.

Examples that must not create starvation:

- target change `15 -> 21` while in `keep`
- target change `55 -> 80` while in `keep`
- price-optimization preheat target that is not reached while the device is otherwise in `keep`

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
- `currentTemperatureC: number | null`
- `intendedNormalTargetC: number | null`
- `targetStepC: number | null`
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
- `shedding_active`

`pauseReason` must be one of:

- `cooldown`
- `headroom_cooldown`
- `restore_throttled`
- `activation_backoff`
- `inactive`
- `keep`
- `restore`
- `invalid_observation`
- `sample_gap`
- `unknown_suppression_reason`

Unknown or newly introduced planner reasons must not silently count as starvation time.
They must normalize to a non-counting state until explicitly mapped.

## Target Used For Evaluation

Always evaluate starvation against the device's intended normal target.

For v1 this means:

- use the operating-mode target that represents the user's normal comfort/storage target
- do not evaluate against a temporary shed target such as `shed -> set_temperature(min)`
- do not evaluate against the currently applied target
- do not include optional cheap/expensive price-optimization deltas in the starvation baseline

Changing the intended normal target must not by itself create starvation.

Target-change behavior:

- if not yet starved: reset the pending entry timer
- if already starved: keep the episode latched, recompute thresholds from the new target on the
  next valid sample, and do not count anything retroactively

## Threshold Model

### Entry anchors

Use these `(targetC, entryDeficitC)` anchors:

- `(16, 2)`
- `(21, 2)`
- `(24, 3)`
- `(55, 10)`
- `(80, 20)`

### Interpolation

Linearly interpolate the deficit between anchors.

Clamp outside the table before quantization:

- targets below `16` use the `16 -> 2` anchor
- targets above `80` use the `80 -> 20` anchor

### Step quantization

Temperature thresholds must respect the device's allowed target step.

Use:

- the target capability step when it is available
- fallback `0.5` when `intendedNormalTargetC < 30`
- fallback `1.0` when `intendedNormalTargetC >= 30`

Compute:

```text
rawEntryDeficitC = interpolated deficit from anchor table
entryDeficitC = max(stepC, ceil(rawEntryDeficitC / stepC) * stepC)
entryThresholdC = intendedNormalTargetC - entryDeficitC
```

## Observation Freshness And Continuity

Starvation is evaluated from observed temperature, not from commanded or assumed temperature.

Do not treat local target writes as proof that temperature has changed.

A sample is valid only when all are true:

- device is still eligible
- `observationFresh === true`
- `currentTemperatureC` is finite
- `intendedNormalTargetC` is finite
- `targetStepC` is finite

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
- `currentTemperatureC <= entryThresholdC`
- `suppressionState === 'counting'`

The entry timer resets on any of:

- `currentTemperatureC > entryThresholdC`
- `suppressionState !== 'counting'`
- invalid observation
- sample gap longer than `10 minutes`
- intended normal target change
- hard reset

## Counting Suppression Causes

These add starvation time after entry:

- `capacity`
- `daily_budget`
- `hourly_budget`
- `shortfall`
- `swap_pending`
- `swapped_out`
- `insufficient_headroom`
- `shedding_active`

Current planner-text examples that should normalize to these causes:

- `shed due to capacity` -> `capacity`
- `shed due to daily budget` -> `daily_budget`
- `shed due to hourly budget` -> `hourly_budget`
- `shortfall (...)` -> `shortfall`
- `swap pending` -> `swap_pending`
- `swap pending (NAME)` -> `swap_pending`
- `swapped out for NAME` -> `swapped_out`
- `insufficient headroom (...)` -> `insufficient_headroom`
- `shedding active` -> `shedding_active`

## Non-Counting States

These do not add starvation time:

- `cooldown (...)`
- `headroom cooldown (...)`
- `restore throttled`
- activation backoff
- `inactive (...)`
- `keep`
- `keep (recently restored)`
- `restore (...)`
- invalid observation
- sample gap longer than `10 minutes`
- unknown or unmapped suppression reason

Behavior in non-counting states:

- if not yet starved: do not start starvation
- if already starved: keep the starved state latched, but pause accumulation

## Exit Threshold

Use hysteresis:

```text
exitDeficitC = max(stepC, floor((entryDeficitC * 0.5) / stepC) * stepC)
exitThresholdC = intendedNormalTargetC - exitDeficitC
```

Recovery behavior:

- once `currentTemperatureC >= exitThresholdC`, stop adding counted starvation time
- start a clear timer
- if temperature drops below `exitThresholdC` before the clear timer completes, cancel the clear
  timer and resume the episode state

Clear starvation only when:

- `currentTemperatureC >= exitThresholdC`
- continuously for `10 minutes`
- across valid contiguous samples

Partial recovery must not clear starvation immediately.

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
- `suppressionState === 'counting'`
- `currentTemperatureC < exitThresholdC`

### Pause accumulation

Pause starvation accumulation while in a non-counting or invalid state.

### Clear

`starved -> not starved`

Clear only after temperature has remained above the exit threshold for `10 minutes`.

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

Do not rely on only a single start timestamp, because paused periods must not count.

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
- append starvation duration to the existing status text
- when accumulation is paused, keep the badge visible and keep the displayed duration static

Example:

```text
insufficient headroom (...) · starved 26m
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
- current temperature
- active counting suppression cause
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
- a device in `keep` does not become starved merely because it is heating slowly after a target
  increase
- starvation is evaluated against the intended normal target, not a temporary shed target
- price-optimization deltas do not change the starvation baseline in v1
- entry threshold uses the fixed anchor table plus linear interpolation
- out-of-range targets clamp to the nearest anchor before quantization
- entry and exit thresholds respect the device temperature step
- starvation enters only after `15 minutes` of continuous qualifying suppression
- invalid observations and sample gaps do not backfill or count as continuous qualification
- non-counting states pause accumulation rather than add time
- unknown suppression reasons do not silently count as starvation
- `capacity control off` clears and resets starvation
- starvation clears only after temperature has remained above the exit threshold for `10 minutes`
- enabling starvation detection does not change planner decisions
- duration-threshold triggers fire once per episode per threshold
- app restart clears live starvation state in v1
