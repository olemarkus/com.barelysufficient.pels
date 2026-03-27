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

Applies only to managed temperature-driven devices:

- room thermostats
- water heaters

Does not apply in this version to:

- generic binary on/off loads
- EV chargers
- other non-temperature devices

## Core Rule

A device is starved only when both are true:

1. it is thermally under-served relative to its intended normal target
2. PELS is actively suppressing it

A device must not become starved merely because it is below target while the planner is in
`keep`.

Examples that must not create starvation:

- target change `15 -> 21` while in `keep`
- target change `55 -> 80` while in `keep`

Starvation is orthogonal metadata, not a new planner state:

- keep `plannedState = keep | shed | inactive`
- keep the existing planner `reason`
- add starvation metadata on top

Required metadata:

- `isStarved`
- `starvationEpisodeStartedAt`
- `starvedAccumulatedMs`
- `starvationLastResumedAt`
- `starvationCause`
- `starvationPauseReason`

## Target Used For Evaluation

Always evaluate starvation against the device's intended normal target.

Do not evaluate against a temporary shed target such as `shed -> set_temperature(min)`.

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

### Step quantization

Temperature thresholds must respect the device's allowed target step.

Examples:

- room thermostat: `0.5`
- water heater: `1.0`

Compute:

```text
rawEntryDeficitC = interpolated deficit from anchor table
entryDeficitC = max(stepC, ceil(rawEntryDeficitC / stepC) * stepC)
entryThresholdC = intendedTargetC - entryDeficitC
```

## Entry Condition

Enter starvation only after all of the following are true continuously for 15 minutes:

- managed temperature-driven device
- valid current temperature
- valid intended target temperature
- `currentTemperature <= entryThresholdC`
- current planner reason is a counting suppression reason

## Counting Suppression Reasons

These add starvation time:

- `shed due to capacity`
- `shed due to daily budget`
- `shed due to hourly budget`
- `shortfall (...)`
- `swap pending`
- `swap pending (NAME)`
- `swapped out for NAME`
- `insufficient headroom (...)`
- `shedding active`

Recommended normalized causes:

- `capacity`
- `daily_budget`
- `hourly_budget`
- `shortfall`
- `swap_pending`
- `swapped_out`
- `insufficient_headroom`
- `shedding_active`

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
- `capacity control off`

Pause reasons:

- `cooldown`
- `headroom_cooldown`
- `restore_throttled`
- `activation_backoff`
- `inactive`
- `keep`
- `restore`
- `capacity_control_off`

Behavior in non-counting states:

- if not yet starved: do not start starvation
- if already starved: keep the starved state latched, but pause accumulation
- exception: `capacity control off` must clear and reset starvation

## Exit Threshold

Use hysteresis:

```text
exitDeficitC = max(stepC, floor((entryDeficitC * 0.5) / stepC) * stepC)
exitThresholdC = intendedTargetC - exitDeficitC
```

Clear starvation only when:

- `currentTemperature >= exitThresholdC`
- continuously for 10 minutes

Partial recovery must not clear starvation immediately.

## State Machine

### Enter

`not starved -> starved`

Enter only after 15 minutes of continuous qualifying suppression.

### Stay starved

Remain starved while either is true:

- counting suppression is still active
- recovery criteria are not yet met

### Pause accumulation

Pause starvation accumulation while in a non-counting state.

### Clear

`starved -> not starved`

Clear only after temperature has remained above the exit threshold for 10 minutes.

### Hard reset

Clear and reset starvation on:

- `capacity control off`
- device no longer managed
- app restart
- explicit planner reset / mode reset

## Duration Model

Track accumulated starvation time explicitly.

Do not rely on only a single start timestamp, because paused periods must not count.

Externally expose only:

- `starved_duration_minutes`

Do not expose seconds.

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
- not fire every planning cycle
- reset when starvation clears

Tags:

- `device`
- `starved_duration_minutes`
- optionally `cause`

## Overview UI

Do not add a top-level overview count.

For each starved device:

- show a `Starved` badge/chip
- append starvation duration to the existing status text

Example:

```text
insufficient headroom (...) · starved 26m
```

## Insights, Diagnostics, And Logs

Insights should expose:

- current starved device count
- longest current starvation duration in minutes

Diagnostics should include, per relevant device:

- `isStarved`
- `starvedAccumulatedMs`
- intended target used for evaluation
- current temperature
- active counting suppression cause
- active pause reason, if any

Logs should include:

- starvation started
- starvation paused
- starvation resumed
- starvation cleared
- duration-threshold trigger crossings

## Acceptance Criteria

- starvation applies only to managed temperature-driven devices
- a device in `keep` does not become starved merely because it is heating slowly after a target increase
- starvation is evaluated against the intended target, not a temporary shed target
- entry threshold uses the fixed anchor table plus linear interpolation
- entry and exit thresholds respect the device temperature step
- starvation enters only after 15 minutes of continuous qualifying suppression
- non-counting states pause accumulation rather than add time
- `capacity control off` clears and resets starvation
- starvation clears only after temperature has remained above the exit threshold for 10 minutes
- enabling starvation detection does not change planner decisions
- duration-threshold triggers fire once per episode per threshold
