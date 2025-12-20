# Plan States and Status Lines

This document describes how the Plan tab derives device state and the status text shown per device.

## Core State Fields (per device)

- currentState: "on" | "off" | "unknown"
  - Derived from device currentOn boolean (or unknown if missing).
- plannedState: "keep" | "shed"
  - "keep" means allow device to stay in its current state or restore if off.
  - "shed" means device should be off or set to its shed temperature.
- shedAction: "turn_off" | "set_temperature"
- shedTemperature: number | null
- plannedTarget: number | null (target temperature if applicable)
- reason: string (shown as the Status line in the Plan tab)

## State Transitions (high level)

- Normal keep:
  - plannedState = "keep"
  - reason = "keep (priority N)"
- Shedding due to overshoot:
  - If headroom < 0, lowest-priority devices are added to shedSet.
  - plannedState = "shed", reason = "shed due to capacity"
- Hourly budget exhausted:
  - plannedState = "shed"
  - reason = "shed due to exhausted hourly energy budget"
- Device is off and can be restored:
  - If not in shortfall and enough headroom:
    - plannedState = "keep"
    - reason = "restore (need XkW, headroom YkW)"
  - If in shortfall:
    - plannedState = "shed"
    - reason = "shortfall (need XkW, headroom YkW)"
- Cooldown / stabilization:
  - After shedding or restoring, restoration is throttled.
  - plannedState = "shed"
  - reason = cooldown or stabilization messages (see list below).
- Swap-based restore:
  - If a higher-priority device needs restore but headroom is insufficient:
    - Lower-priority on devices are marked "shed" to free headroom.
    - The higher-priority device becomes a pending swap target until restored.

## Plan Tab "State" Line (UI)

The Plan tab shows a State line derived from plannedState and currentState:

- Shed (powered off): plannedState === "shed" and shedAction === "turn_off"
- Shed (lowered temperature): plannedState === "shed" and shedAction === "set_temperature"
- Restoring: plannedState === "keep" and currentState is "off" or "unknown"
- Keep: plannedState === "keep" and currentState is "on"
- Unknown: fallback if state is not clear

## Plan Tab "Status" Line (reason values)

These are the strings assigned to reason in app.ts. The UI shows reason or "Waiting for headroom".
Parentheses indicate dynamic values.

- keep (priority N)
- not controllable by PELS
- restore (need XkW, headroom YkW)
- shed due to capacity
- shed due to hourly budget
- shortfall (need XkW, headroom YkW)
- cooldown (shedding, Ss remaining)
- cooldown (restore, Ss remaining)
- swap pending
- swap pending (NAME)
- swapped out for NAME
- insufficient headroom (need XkW, headroom YkW)
- shedding active
- cooldown (shedding, Ss remaining)
- cooldown (restore, Ss remaining)
- restore throttled

## State vs Status

The State line carries the on/off vs shed distinction (including "Shed (powered off)" vs "Shed (lowered temperature)").
Status lines are now simplified and avoid repeating the state, focusing on why the device is blocked or changing.

## Notes on min-temperature shedding

Devices configured with shedAction "set_temperature" are still marked as plannedState "shed".
They share the same reason strings as turn-off shedding, including "shortfall (need XkW, headroom YkW)" when in shortfall.
