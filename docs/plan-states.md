---
title: "Overview Device Status: Limited, Resuming, Idle, Off & Manual"
description: How the Overview page maps planner output to user-facing device state and status text.
---

# Plan States and Status Lines

The **Overview** page shows user-facing device state, not raw planner internals. This page explains the mapping so you can interpret what PELS is doing.

Only managed devices are included in the plan snapshot. Unmanaged devices are treated as background usage and do not appear as managed-device cards.

## Overview State Words

The redesigned Overview uses a compact state word on each device card:

| Overview label | What it means |
| --- | --- |
| **Running** | The device is on, charging, heating, or otherwise active. |
| **Idle** | The device is available and on (or has no binary switch), but currently has nothing to do. |
| **Off** | Homey explicitly reports the device off, and PELS is not currently limiting or resuming it. |
| **Limited** | PELS is currently lowering, pausing, turning off, or making the device wait for power — to stay within the hard cap or daily budget pace, or because a scheduled smart task has power reserved. |
| **Resuming** | PELS is trying to bring the device back when there is available power. |
| **Manual** | The device is managed, but PELS cannot use power-limit control for it right now. |
| **Unavailable** | PELS cannot currently trust the device state enough to plan with it. |
| **Unknown** | PELS does not have enough current state to choose a more specific label. |

The state row pairs that word with the current power fact. Cards add one
modality fact where useful—such as temperature and target or charging level—and
reserve the reason line for a single exceptional explanation.

## Common Status Lines

Chips stay short. The status line below a chip explains why a device is waiting,
limited, or resuming.

A device card tells you **what that device needs**. It does not repeat which
limit the whole house is up against — the hard cap, this hour's pace, or today's
budget — because that is the same for every device, and the Overview hero states
it once under **Power now** (`Safe pace now 1.9 kW · set by today's budget`).

| Status wording | Meaning |
| --- | --- |
| **Waiting to resume — 0.8 kW more needed** | The power that would actually bring this device back. Reserves are already counted, so freeing that much is enough. Stepped devices asking for a higher level read **Waiting to increase — …**. |
| **Waiting to resume — more budget next hour** | This hour's energy budget is spent, so freeing power will not help. The device can resume when the next hour's budget starts. |
| **Waiting to resume** | The device is waiting for power, but PELS cannot put a number on it yet. |
| **Waiting for available power** | Shown when a device has been waiting on power long enough to be flagged, with no number available. |
| **Limited to stay within today's budget** | Today's budget is holding the device back — and this one you can release, with **Let it run now**. |
| **Manual action needed — hard cap may be exceeded** | PELS projects an hourly hard-cap breach and cannot limit any more load. Use the **Hard cap breach imminent — manual action needed** trigger for alerts. |
| **Waiting before resuming** | PELS is respecting a cooldown so devices do not rapidly cycle. |
| **Waiting for power reading to stabilise** | PELS recently changed or observed a device and is waiting for meter readings to settle. |
| **Delaying restart after recent failed attempt** | A previous resume caused new pressure, so PELS is waiting longer before trying again. |
| **Waiting for cheaper hours** | A smart task booked this load into cheaper hours. More power would not start it. |
| **Waiting for solar surplus** | A "run on solar surplus" device, waiting for the home to export enough. |
| **Turned off elsewhere — turn it on to resume** | The device was switched off outside PELS. |
| **Holding at 6 A — cannot increase while 2 devices are limited** | A stepped device may not climb past its lowest useful level while other devices are still held back. Resuming those devices lifts it, not more power. |
| **Waiting so … can start** | A device is about to start and has reserved the power it needs, so this one waits its turn. The power is there — it is spoken for. |

## Raw Planner Fields

The raw plan still uses older internal identifiers. These are implementation terms, not preferred UI copy:

| Raw field/value | User-facing meaning |
| --- | --- |
| `plannedState: "keep"` | Usually shown as **Running** or **Resuming**, depending on current device state. |
| `plannedState: "shed"` | Usually shown as **Limited**. PELS may turn the device off, lower temperature, or reduce a step. |
| `plannedState: "inactive"` | Shown as **Idle** while available/on, or **Off** when Homey explicitly reports the device off. PELS is not limiting it. |
| `shedAction: "turn_off"` | Turn off while limiting. |
| `shedAction: "set_temperature"` | Lower target temperature while limiting. |
| `reason: "staying off until turned on again"` | Off — the device was turned off elsewhere and PELS was asked to leave it off. |
| `reason: "shed due to capacity"` | Limited; the card shows the power the device still needs. |
| `reason: "shed due to daily budget"` | Limited by today's budget pacing; the card shows the power the device still needs, or offers **Let it run now**. |
| `reason: "restore (...)"` | Waiting to resume, with the required and available power shown internally. |
| `reason: "shortfall (...)"` | Manual action needed — hard cap may be exceeded. |
| `reason: "headroom cooldown (...)"` | Waiting for power readings to stabilise after recent change. |
| `reason: "waiting for solar surplus"` | Held off until the home exports enough solar. |

These raw strings may still appear in diagnostics, logs, tests, or older Homey capability values. Normal docs and UI should use the user-facing wording above.

## EV Availability

For EV chargers, PELS keeps capacity suppression separate from charger availability:

| Situation | Overview result |
| --- | --- |
| Charger is unplugged | **Off** or **Idle**, with an unplugged or not-charging explanation where available. |
| Charger is discharging | **Off** or **Idle**, with a discharging explanation where available. |
| Charger state is unknown | **Idle**, **Unknown**, or **Unavailable** until the state becomes usable. |
| Charger power estimate is missing | **Idle** or **Manual** until PELS observes or is configured with a usable estimate. |
| Charger is paused and can resume | PELS may resume it when the plan allows and there is available power. |

## Why Devices Do Not Resume Immediately

PELS resumes carefully:

1. Higher-priority devices resume first.
2. Only one device is resumed or increased per planning cycle.
3. Extra available power is required beyond the device's expected draw.
4. Recent limiting and recent failed restart attempts delay another resume.
5. A lower-priority device may stay limited until a higher-priority device has successfully resumed.

That deliberate cadence is what keeps the home stable: no rapid cycling, no chasing a stale meter reading, every resume grounded in what the meter actually reports.
