# UI Terminology Guide

Canonical user-facing vocabulary for PELS. Follow it in UI labels, help text, status strings, and docs. Internal code identifiers (planners, tests, logs) keep their existing names.

## Core principle

> User-facing UI should say **what happens**. Advanced docs may explain why the planner does it.

Prefer: `Limited — staying under the hard cap`
Avoid: `Shed due to capacity`

Concrete words over jargon: `limited`, not `shed`; `resume`, not `restore`; `available power`, not `headroom`; `safety margin`, not `soft margin`. The migration to this vocabulary is complete in the settings UI — the older terms only survive in internal code identifiers, legacy Homey flow card names (see [`docs/flow-cards.md`](../docs/flow-cards.md)), and raw planner reason strings documented in [`docs/plan-states.md`](../docs/plan-states.md).

## Hero bar vocabulary

The overview hero uses a specific vocabulary to keep the power/energy distinction clear.

| Concept | Label | Avoid |
|---|---|---|
| Current instantaneous draw | **Power now** | Power consumed currently, Current load |
| Dynamic kW threshold (see below) | **Safe pace now** | PELS limit, Soft limit, Reaction limit |
| Fixed user-configured ceiling | **Hard cap** | Power limit, Grid cap |
| kWh used so far this hour | **Energy used this hour** | Usage now, Consumed |
| kWh allowed for this hour | **Budget this hour** | Hourly energy budget, Hourly target |
| Projected end-of-hour kWh | **Projected this hour** | Estimate, Forecast, Planner result |

Projection formula: `projectedKWh = usedKWh + (currentKw × minutesRemaining / 60)`

### "Safe pace now" — one label, two possible sources

The dynamic tick on the power bar shows where PELS starts reacting. It can come from two constraints, but the user doesn't see the distinction in the primary label. The tooltip explains the source.

| Source (`meta.softLimitSource`) | Tooltip |
|---|---|
| `capacity` | Hourly power limit minus safety margin — PELS starts reacting here |
| `daily` | Slowed to stay within today's budget — daily pacing is the tighter constraint right now |
| `both` | Both capacity and daily pacing are constraining PELS right now |

The **hard cap** tick (user-configured ceiling, `hardLimitKw`) always reads **Hard cap** with tooltip: `Your configured maximum — staying under this avoids tariff steps or breaker trips`.

### Safe pace, hard cap, and safety margin

Keep these three concepts distinct:

| Term | Meaning |
|---|---|
| **Safe pace** | Dynamic planning pace to stay on track. |
| **Hard cap** | Configured upper boundary PELS tries not to exceed. |
| **Safety margin** | Buffer below the configured capacity/tariff limit. |

Do not use `power limit` as a casual threshold label where it could blur Safe pace vs Hard cap.

### Hero legend

```
Managed 3.2 kW  ·  Background 2.9 kW  ·  Safe pace now 6.0 kW  ·  Hard cap 8.0 kW
```

The value line should not repeat the time meaning already carried by the label:
use `1.2 kW`, not `1.2 kW now`.

Marker grammar for read-only meter tracks:

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

The hero has one dedicated status line combining aggregate device action and budget projection, for example:

```
Projected on target · 1.09 / 2.8 kWh · 34 min left
Limiting 2 devices · projected on target · 2.23 / 2.8 kWh · 29 min left
Above safe pace · limiting 2 devices · projected slightly over budget
Above hard cap of 5.0 kW · limiting 2 devices now
```

## Device state chips (Overview)

| Chip | Used when |
|---|---|
| **Running** | The device is on, charging, heating, or otherwise active. |
| **Idle** | The device is off or unavailable to run, and PELS is not holding it back. |
| **Limited** | PELS is lowering, pausing, or turning off the device. |
| **Resuming** | PELS is bringing the device back as power becomes available. |
| **Manual** | The device is managed but PELS does not have power-limit control for it right now. |
| **Unavailable** | PELS does not currently trust the device state enough to plan with it. |
| **Unknown** | PELS does not have enough current state to choose a more specific chip. |

Secondary text under a Limited chip names the action: **Turned off by PELS**, **Lowered by PELS**, or **Charging paused**. Stepped-load cards may add a step readout (`Off now`, `Level: Max`, `Level unknown`).

## Smart task vocabulary

Source of truth: `packages/shared-domain/src/deadlineLabels.ts`. Pull every label from `deadlineLabels(kind)` rather than hardcoding strings.

| Concept | Temperature device | EV-SoC device |
|---|---|---|
| Kind chip | `Temperature` | `EV` |
| Hero section label (eyebrow) | `Heating smart task` | `EV smart task` |
| Live state chip — active (pending hero only) | `Heating` | `Charging` |
| Live state chip — building plan (pending hero / list) | `Building plan…` | `Building plan…` |
| Live state chip — plan ready, first hour later (list only) | `Scheduled` | `Scheduled` |
| Live state chip — session ended (pending hero / list) | (n/a) | `Paused — unplugged` |
| Live state chip — on track, no active hour | `On track` | `On track` |
| Cannot-finish chip | `Cannot finish` | `Cannot finish` |
| Device load series (legend) | `Heating` | `Charging` |
| Measured device series (legend) | `Measured Heating` | `Measured Charging` |
| Background load series | `Background usage` | `Background usage` |
| Progress series (legend) | `Temperature` | `Charge level` |
| Active-hour tooltip word | `Heating` | `Charging` |
| Target unit | `°C` | `%` |
| Plan inputs card title | `Smart task inputs` | `Smart task inputs` |

The live deadline-plan hero shows only the kind chip plus the cannot-finish chip
(and confidence as `Estimating` / `Refining` when learning is in progress,
except on true cannot-finish heroes where the cannot-finish chip and reason own
that row). The headline carries the live state directly (`Heating from HH:MM`,
`Charging now`, `On track — no action needed yet`, `Cannot finish`), so a
separate state chip duplicated information. The pending hero and the smart-task
list still emit a state chip because there the state is the only available
signal.

Rule: a temperature device must never render the words *charge*, *charging*, or *EV* in user-facing text.

### Smart task list status chips

The smart-task list uses one chip per task. Source: `SMART_TASK_LIST_STATUS_LABELS` in `deadlineLabels.ts`.

| Chip | Meaning |
|---|---|
| `Building plan…` | Pending; no plan allocation yet (often waiting for prices through the deadline). |
| `Scheduled` | Plan ready, first scheduled hour is in the future. |
| `Paused — unplugged` | EV: charging task is paused because the car is unplugged or the session ended. |
| `On track` | PELS currently expects the task to reach the target. |
| `At risk` | Plan exists but there is limited time or room left. |
| `Cannot finish` | Not enough usable time or energy delivery before the deadline. |
| `Satisfied` | The observed target is met. PELS resumes tracking if a later reading drops below it. |

Internal note: the `DeadlineLiveState` enum value is still spelled `queued`
(used in chip-tone resolvers and the list status id) so log schemas and JSON
contracts remain stable — only the user-visible chip label changed.

### Recourse labels

Smart-task heroes (live "cannot finish" and history-detail "missed") render at most one recourse button. The label is action-oriented and names what the user should do *now*, not where the click lands. Source: `resolveMissedHistoryRecourse` and `cannotMeet*Recourse` helpers in `deadlineLabels.ts`.

| Label | When | Lands on |
|---|---|---|
| `Lower daily budget` | Missed run because the day's energy budget was exhausted before the deadline. | Budget tab. |
| `Review device` | Missed run because the device couldn't deliver enough (shortfall, capacity pressure, plan invalidation). | Overview tab + opens the device-settings overlay for the entry's device. |

The prior "Move deadline later" copy promised an action neither destination offered (deadlines are configured via Flow cards, not the device-settings overlay) and was replaced 2026-05-17. The overlay is honest about scope: shed behaviour, target power, boost, modes, priority, and deltas — i.e. settings the user can audit when a run misses.

### "Plan" vs "deadline" on smart-task surfaces

Reserve *plan* for the planning layer. Smart-task surfaces use *deadline*, *objective*, or *smart task* for lifecycle and identity language ("set a deadline", "smart task ended"). Surface labels prefer non-plan terminology — e.g., the inputs card is titled `Smart task inputs`, not `Plan inputs`.

## Mode label

The Settings page renders the current operating mode as a single selector
labelled `Current mode`. The selected option is the untranslated mode name
(Home, Away, Night, or any user-authored name such as `Hjemme`).

Do not render `${name} mode`; that form was retired in PR9 (owner walk
2026-05-17) because it produced awkward mid-phrase code-switches at
non-English locales (e.g. `Hjemme mode`). If a non-selector summary is needed
again, use an English structural prefix before the user-authored name, e.g.
`Mode: Hjemme`, rather than appending `mode`.

The Overview hero does not chip the mode — see
`notes/overview-hero-spec.md` § "Chip row".

## Style rules

1. **Concrete action words.** `limited`, not `shed`. `resume`, not `restore`. `available power`, not `headroom`.
2. **Units in labels.** `Hard cap (kW)`, `Daily budget (kWh)`, `Cheap-hour boost (°C)`.
3. **No abbreviations in visible labels.** No bare `Cap`, no `delta`.
4. **Chips are short; reason lines are longer.** Chip: `Limited`. Reason: `staying within today's budget`.
5. **No internal planner terms in normal live status.** `backoff`, `invariant`, `shortfall`, `swap`, `headroom cooldown` belong in advanced diagnostics only.
6. **Don't rename established user-facing terms unless the change is clearly better.** Confusion from renaming has a cost too. `Budget`, `Managed`/`Unmanaged`, `Capacity`, `Priority`, `Mode` stay.

## Hard cap is physical

The hard cap is a property of the user's grid tariff or breaker, not a tuning knob. UI copy must not suggest users raise the hard cap to relieve pressure. The recommended remedy when the daily budget runs out before a deadline is to **lower the daily budget** so future days reserve available power earlier — see `cannotMeetDailyBudgetExhausted` copy in `deadlineLabels.ts`.
