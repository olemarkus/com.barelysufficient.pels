# UI Terminology Guide

This document defines the canonical user-facing vocabulary for PELS. Follow it in all UI labels, help text, status strings, and docs. Internal code identifiers (planners, tests, logs) can keep their existing names.

## Core principle

> User-facing UI should say **what happens**. Advanced docs may explain why the planner does it.

Prefer: `Limited — staying under the hard cap`
Avoid: `Shed due to capacity`

## What to change and what to leave alone

Not all internal terms are problems. Change only things that genuinely confuse users.

**Change these** — they are jargon with no intuitive meaning:

| Internal term | Use instead | Why |
|---|---|---|
| Shed | Limited / paused / lowered / turned off | Load dispatch jargon |
| Restore | Resume | Planner language |
| Headroom | Available power | Means nothing to a normal person |
| Controlled load | Managed device usage | Aligns with "Managed by PELS" |
| Uncontrolled load | Background usage | "Household background usage" in full |
| Soft margin | Safety margin | "Soft" is system language |
| Backoff | Delaying restart | Advanced/diagnostics only |
| Invariant | Safety rule | Advanced/debug only |

**Leave these alone** — they are established and intuitive:

| Term | Reason to keep |
|---|---|
| Budget | Users know it. "Daily budget" communicates a spend limit clearly. Renaming to "target" weakens the meaning. |
| Managed / Unmanaged | Already understood in context. |
| Capacity | Fine in settings labels where the context is clear. |
| Priority | Self-explanatory. |
| Mode | Self-explanatory. |

## Hero bar vocabulary

The overview hero uses a specific vocabulary to make the power/energy distinction clear.

| Concept | Label | Avoid |
|---|---|---|
| Current instantaneous draw | **Power now** | Power consumed currently, Power consumed now, Current load |
| Dynamic kW threshold (see below) | **Safe pace now** | PELS limit, Soft limit, Reaction limit |
| Fixed user-configured ceiling | **Hard cap** | Power limit, Grid cap |
| kWh used so far this hour | **Energy used this hour** | Usage now, Consumed |
| kWh allowed for this hour | **Budget this hour** | Hourly energy budget, Hourly target |
| Projected end-of-hour kWh | **Projected this hour** | Estimate, Forecast, Planner result |

Projection formula: `projectedKWh = usedKWh + (currentKw × minutesRemaining / 60)`

### "Safe pace now" — one label, two possible sources

The dynamic tick on the power bar shows where PELS starts reacting. It can come from two different constraints, but the user doesn't need to see that distinction in the primary label. The tooltip explains the source.

| Source (`meta.softLimitSource`) | Tick label | Tooltip |
|---|---|---|
| `capacity` | **Safe pace now** | Hourly power limit minus safety margin — PELS starts reacting here |
| `daily` | **Safe pace now** | Slowed to stay within today's budget — daily pacing is the tighter constraint right now |
| `both` | **Safe pace now** | Both capacity and daily pacing are constraining PELS right now |

The **hard cap** tick (user-configured ceiling, `hardLimitKw`) always shows as **Hard cap** with tooltip: `Your configured maximum — staying under this avoids tariff steps or breaker trips`.

### Safe pace, hard cap, and safety margin

Keep these three concepts distinct in normal UI:

| Term | Meaning |
|---|---|
| **Safe pace** | Dynamic planning pace to stay on track. |
| **Hard cap** | Configured upper boundary PELS tries not to exceed. |
| **Safety margin** | Buffer below the configured capacity/tariff limit. |

Do not use `power limit` as a casual threshold label where it could blur the distinction between
`Safe pace` and `Hard cap`.

### Hero legend

```
Managed 3.2 kW  ·  Background 2.9 kW  ·  Safe pace now 6.0 kW  ·  Hard cap 8.0 kW
```

The value line should not repeat the time meaning already carried by the label:
use `1.2 kW`, not `1.2 kW now`.

Use read-only meter tracks for overview power and energy. Marker grammar:

| Marker | Meaning |
|---|---|
| Solid dot | Actual/current value |
| Hollow dot | Projected/forecast value |
| Thin tick | Threshold/target |
| End stop | Hard limit/cap |

Overview status chips are hidden when everything is normal. Show short exception chips only:

| Condition | Chip |
|---|---|
| Current power is above the dynamic threshold | `Above safe pace` |
| Projected hourly energy is above budget | `Above budget` |
| Current power is above the configured ceiling | `Above hard cap` |

The hero has one dedicated status line. It should combine aggregate device action and budget projection, for example:

```
Projected on target · 1.09 / 2.8 kWh · 34 min left
Limiting 2 devices · projected on target · 2.23 / 2.8 kWh · 29 min left
Above safe pace · limiting 2 devices · projected slightly over budget
Above hard cap of 5.0 kW · limiting 2 devices now
```

## Device states (Overview)

| Internal state | UI label |
|---|---|
| Active | Running |
| Active (charging) | Charging |
| Active (temperature-managed) | Temperature controlled |
| Shed | Limited |
| Shed (powered off) | Turned off by PELS |
| Shed (lowered temperature) | Lowered by PELS |
| Shed (charging paused) | Charging paused |
| Restoring | Resuming |
| Restore requested | Resume requested |
| Inactive | Inactive |
| Capacity control off | Power-limit control off |
| State unknown | State unknown |
| Unavailable | Unavailable |

## Status / reason strings

Chips are one or two words. Reason lines are short sentences. Never put a full sentence in a chip.

| Internal / current text | Preferred user-facing text |
|---|---|
| Waiting for headroom | Waiting for available power |
| restore (need X kW, headroom Y kW) | Waiting to resume — needs X kW, Y kW available |
| insufficient headroom to restore | Not enough available power to resume |
| insufficient headroom to swap for NAME | Not enough available power to make room for NAME |
| shed due to capacity | Limited — staying under the hard cap |
| shed due to daily budget | Limited — staying within today's budget |
| shed due to hourly budget | Limited — this hour is near the hard cap |
| shortfall | Manual action needed — hard cap may be exceeded |
| cooldown (shedding, Ss remaining) | Waiting after limiting device (Ss remaining) |
| cooldown (restore, Ss remaining) | Waiting before resuming (Ss remaining) |
| meter settling | Waiting for power meter to stabilise |
| headroom cooldown | Waiting for power reading to stabilise |
| activation backoff | Delaying restart after recent failed attempt |
| restore pending | Resume pending |
| restore throttled | Delaying restart to avoid rapid cycling |
| swap pending | Making room for higher-priority device |
| swapped out for NAME | Limited so NAME can run |
| shedding active | Currently limiting devices |
| capacity control off | Power-limit control off |
| startup stabilization | Waiting after startup |
| shed invariant | Blocked by safety rule |

## Deadline plan vocabulary

The deadline-plan surface (the per-device plan view that schedules charging or heating to a deadline) speaks the device's domain language. Source of truth: `packages/shared-domain/src/deadlineLabels.ts`.

| Concept | Temperature device | EV-SoC device |
|---|---|---|
| Kind chip | `Temperature` | `EV` |
| Active state chip | `Heating` | `Charging` |
| Waiting-state chip | `Heat queued` | `Charge queued` |
| Device load series (legend) | `Heating` | `Charging` |
| Measured device series (legend) | `Measured Heating` | `Measured Charging` |
| Background load series | `Background usage` | `Background usage` |
| Plan-active tooltip word | `Heat` | `Charge` |
| Target unit | `°C` | `%` |

Rule: a temperature device must never render the words *charge*, *charging*, or *EV* in user-facing text. Pull every label from `deadlineLabels(kind)` rather than hardcoding strings.

### "Plan" vs "deadline" on smart-task surfaces

The general rule (see [feedback_terminology_plan_vs_deadline](../../.claude/projects/-home-olemarkus-dev-pels/memory/feedback_terminology_plan_vs_deadline.md)) reserves *plan* for the planning layer and asks smart-task surfaces to prefer *deadline* / *objective* / *smart task*. There is one carve-out: when a smart-task surface displays inputs that the planner consumes to produce the smart-task allocation — e.g. the per-unit energy rate and the max power per hour on the Plan inputs card — using "plan inputs" is fine because the content *is* planner output that drives the smart task. The rule applies to lifecycle and identity language ("set a deadline", "smart task ended"), not to direct references to planner computation feeding a smart task.

## Settings labels worth updating

Only update these when the screen is already being touched — don't rename for its own sake.

| Current | Preferred |
|---|---|
| Soft margin (kW) | Safety margin (kW) |
| Soft limit = limit − margin | PELS reacts at: hard cap minus safety margin |
| Capacity-based control | Power-limit control |
| Cheap delta | Cheap-hour boost (°C) |
| Expensive delta | Expensive-hour reduction (°C) |
| Disable device control (dry run) | Simulation mode |

Leave these as-is: `Daily budget`, `Budget tab`, `Capacity limit`, `Enable daily budget`, `Daily budget (kWh)`.

## Style rules

1. **Prefer concrete action words.** `limited`, not `shed`. `resume`, not `restore`. `available power`, not `headroom`.
2. **Put units in labels.** `Hard cap (kW)`, `Daily budget (kWh)`, `Cheap-hour boost (°C)`.
3. **Avoid abbreviations in visible labels.** No bare `Cap`, no `delta`.
4. **Chips are short; reason lines are longer.** Chip: `Limited`. Reason: `staying within today's budget`.
5. **Don't expose internal planner terms in normal live status.** `backoff`, `invariant`, `shortfall`, `swap`, `headroom cooldown` belong in advanced diagnostics only.
6. **Don't rename established user-facing terms unless the change is clearly better.** Confusion from renaming has a cost too.

## What stays internal

These are correct and useful in planner code, tests, and logs. Do not surface them in normal UI:

`shed`, `restore`, `headroom`, `shortfall`, `controlled`, `uncontrolled`, `backoff`, `invariant`, `soft limit`
