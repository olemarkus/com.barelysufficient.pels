# UI Terminology Guide

This document defines the canonical user-facing vocabulary for PELS. Follow it in all UI labels, help text, status strings, and docs. Internal code identifiers (planners, tests, logs) can keep their existing names.

## Core principle

> User-facing UI should say **what happens**. Advanced docs may explain why the planner does it.

Prefer: `Limited to stay under hourly power limit`
Avoid: `Shed due to capacity`

## Canonical vocabulary

| Internal / old term | User-facing term | Notes |
|---|---|---|
| Capacity limit | Hourly power limit | "Capacity" is correct but abstract |
| Soft margin | Safety margin | "Soft" is system language |
| Soft limit (derived threshold) | Safety threshold OR Daily energy pace | Depends on source — see below |
| Hard cap | Hourly power limit | The user-configured ceiling |
| Headroom | Available power | Keep "headroom" in advanced/debug docs only |
| Daily budget | Daily energy target | "Budget" is overloaded |
| Controlled load | Managed device usage | Aligns with "Managed by PELS" |
| Uncontrolled load | Background usage | "Household background usage" when space allows |
| Shed | Limited / paused / turned down / lowered | "Shed" is not normal user language |
| Restore | Resume | "Restore" is planner language |
| Shortfall | Manual action needed — limit may be exceeded | |
| Cooldown | Waiting period | Context-dependent |
| Backoff | Delaying restart | Advanced/diagnostics only |
| Invariant | Safety rule | Advanced/debug only |
| Budget tab | Limits | |
| Capacity-based control | Power-limit control | |
| Price-based control | Price control | |
| Dry run | Simulation mode | |

## The two dynamic limits on the power bar

The power bar tick that shows where PELS starts reacting is **not always the same constraint**. Label it based on its source — `meta.softLimitSource` carries this.

### Source: hourly power limit − safety margin

Label: **Safety threshold**
Tooltip: `PELS starts reacting here — hourly power limit minus safety margin`

This means a device may be limited because the instantaneous draw is approaching the user's configured ceiling.

### Source: daily energy target pacing

Label: **Daily energy pace**
Tooltip: `PELS is slowing down to stay on today's energy target`

This means a device may be limited not because power is high right now, but because the home is running ahead of today's energy target.

### The user-configured ceiling tick

Label: **Hourly power limit**
Tooltip: `Your configured maximum — staying under this avoids tariff steps or breaker trips`

### Summary of bar ticks

| Constraint | Tick label |
|---|---|
| `softLimitSource = capacity` | Safety threshold |
| `softLimitSource = daily_budget` | Daily energy pace |
| User-configured ceiling (`hardLimitKw`) | Hourly power limit |

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

| Internal / current text | Preferred user-facing text |
|---|---|
| Waiting for headroom | Waiting for available power |
| restore (need X kW, headroom Y kW) | Waiting to resume — needs X kW, Y kW available |
| insufficient headroom to restore | Not enough available power to resume |
| insufficient headroom to swap for NAME | Not enough available power to make room for NAME |
| shed due to capacity | Limited — staying under hourly power limit |
| shed due to daily budget | Limited — staying on today's energy target |
| shed due to hourly budget | Limited — this hour is near the power limit |
| shortfall | Manual action needed — hourly limit may be exceeded |
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

## Tab / section naming

| Current | Preferred |
|---|---|
| Budget tab | Limits |
| Capacity & daily budget | Power limit and daily energy target |
| Capacity limit (kW) | Hourly power limit (kW) |
| Soft margin (kW) | Safety margin (kW) |
| Daily budget | Daily energy target |
| Enable daily energy budget | Enable daily energy target |
| Daily budget (kWh) | Daily target (kWh) |
| Planned device states | What PELS is doing now |
| Quick stats | Current status |
| Refresh plan | Recalculate now |
| Device control | Devices PELS can manage |
| Capacity-based control | Power-limit control |
| Price-based control | Price control |
| Disable device control (dry run) | Simulation mode |
| Unmanaged usage reserve | Household reserve |
| Managed device flexibility | Managed-device flexibility |
| Cheap delta | Cheap-hour boost (°C) |
| Expensive delta | Expensive-hour reduction (°C) |
| Price-shape today plan | Shift today's target toward cheap hours |

## Style rules

1. **Prefer concrete action words.** Use `limited`, not `shed`. Use `resume`, not `restore`. Use `available power`, not `headroom`.
2. **Put units in labels.** `Hourly power limit (kW)`, `Daily target (kWh)`, `Cheap-hour boost (°C)`.
3. **Avoid abbreviations in visible labels.** No `Cap`, no `delta`.
4. **One name per concept.** Do not alternate between `daily budget`, `daily target`, `daily soft limit`, and `daily plan`. Use `Daily energy target` for the user feature.
5. **Chips are short; reason lines are long.** A chip says `Limited`. The reason line says `staying under hourly power limit`. Don't put 7-word sentences in chips.
6. **Don't expose internal safety/planner terms in normal live status.** `backoff`, `invariant`, `shortfall`, `swap`, `headroom cooldown` belong in advanced diagnostics, not primary UI.

## What to keep internal

These terms are fine in planner code, tests, and debug logs — do not rename internals:

`shed`, `restore`, `headroom`, `shortfall`, `controlled`, `uncontrolled`, `backoff`, `invariant`, `soft limit`, `capacity`
