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
reserve the reason line for an exceptional explanation such as **Turned off by
PELS**, **Charging paused**, or **Lowered by PELS**.

When **Simulation mode** is on, those readouts read hypothetically instead — **Would be turned off (simulation)**, **Would be lowered (simulation)**, or **Charging would pause (simulation)** — because PELS is showing what it *would* do without actually changing the device.

## Common Status Lines

Chips stay short. The status line below a chip explains why a device is waiting, limited, or resuming.

| Status wording | Meaning |
| --- | --- |
| **Waiting for available power** | The device needs more available power before PELS can resume or increase it. |
| **Limited by the hard cap** | PELS is lowering or pausing the device to protect the hourly hard cap. |
| **Limited by today's daily budget** | Daily budget pacing is currently the tighter constraint. |
| **Limited — this hour is near the hard cap** | The current hour is close enough to the hard cap that PELS is holding the device back. |
| **Manual action needed — hard cap may be exceeded** | PELS projects an hourly hard-cap breach and cannot limit any more load. Use the **Hard cap breach imminent — manual action needed** trigger for alerts. |
| **Waiting before resuming** | PELS is respecting a cooldown so devices do not rapidly cycle. |
| **Waiting for power reading to stabilise** | PELS recently changed or observed a device and is waiting for meter readings to settle. |
| **Delaying restart after recent failed attempt** | A previous resume caused new pressure, so PELS is waiting longer before trying again. |
| **Making room for higher-priority device** | PELS is limiting a lower-priority device so a higher-priority one can run. |
| **Waiting so … can start** | A scheduled smart task needs a clear block of power to begin, so this device waits its turn to resume. The card names the device being waited for when PELS knows it. Nothing was switched off — it was already off. |

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
| `reason: "shed due to capacity"` | Limited by the hard cap. |
| `reason: "shed due to daily budget"` | Limited by today's daily budget. |
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
