# UI Terminology Guide

Canonical user-facing vocabulary for PELS. Follow it in UI labels, help text, status strings, and docs. Internal code identifiers (planners, tests, logs) keep their existing names.

## Core principle

> User-facing UI should say **what happens**. Advanced docs may explain why the planner does it.

Prefer: `Limited by the hard cap`
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
| At-risk chip | `At risk` | `At risk` |
| Cannot-finish chip | `Cannot finish` | `Cannot finish` |
| Device load series (legend) | `Heating` | `Charging` |
| Measured device series (legend) | `Measured Heating` | `Measured Charging` |
| Background load series | `Background usage` | `Background usage` |
| Progress series (legend) | `Temperature` | `Charge level` |
| Active-hour tooltip word | `Heating` | `Charging` |
| Target unit | `°C` | `%` |
| Plan inputs card title | `What PELS has learned` | `What PELS has learned` |

The live deadline-plan hero shows only the kind chip plus a risk/failure chip
(`At risk` or `Cannot finish`) and confidence as `Estimating` / `Refining` when
learning is in progress, except on true cannot-finish heroes where the
cannot-finish chip and reason own that row. The headline carries normal live
state directly (`Heating from HH:MM`, `Charging now`, `On track — no action
needed yet`), so a separate state chip duplicated information. The pending hero
and the smart-task list still emit a state chip because there the state is the
only available signal.

Confidence chips use the same short vocabulary on the live hero and active
smart-task list: low confidence is `Estimating`, medium confidence is
`Refining`, and high confidence renders no chip. The chip now appears **only
during genuine cold-start** — when the rate is bootstrap-sourced or has fewer
than `MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP` (4) accepted samples — and is
**silent on `on_track`** as well as `cannot_meet`. A learned rate that sits at
`low` confidence forever (thermal devices, from inherent per-hour variance) is
no longer treated as cold-start, so it renders no chip rather than nagging a
settled task. The energy estimate instead shows as a range
(`expected…planned`, e.g. `8.0–10.0 kWh`) on the detail hero; the range
collapses to a single figure once the buffer fades with learning. The range
itself signals approximation — no narrating sentence sits beneath it.

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

### Past-task outcome chips

The smart-task history surface (past-tasks archive, history-detail hero) uses a
closed noun set to label how a finished run ended. Source: `OUTCOME_LABELS` in
`packages/shared-domain/src/deferredPlanHistory.ts`.

| Outcome (`entry.outcome`) | Chip | Tone |
|---|---|---|
| `met` | `Succeeded` | ok |
| `missed` | `Missed` | warn |
| `abandoned` | `Abandoned` | muted |
| `replaced` | `Abandoned` | muted |
| `unknown` | `Unknown` | muted |

`Abandoned` is the canonical word for a run that stopped before the deadline
without succeeding or missing — e.g. the user cleared the smart task, replaced
it with a fresh one, or the diagnostic stream stopped (EV unplugged) before the
deadline. Both the `abandoned` and `replaced` underlying outcomes render the
same `Abandoned` chip; the distinction lives in the postmortem body, not the
chip. Do **not** drift to `Cancelled`, `Aborted`, `Skipped`, `Ended`, or
`Stopped` in user-facing copy — the chip word is `Abandoned`.

#### Chip nouns vs divider verbs

The chip set is noun-shaped (`Succeeded` / `Missed` / `Abandoned`). The past-tasks
week-divider heading currently uses a verb form — `Week 20 · 4 deadlines met · ≈
41 kr` — which doesn't line up with the chip vocabulary the rows underneath it
carry. The chip set is the canonical one; future summary copy should align to
the chip nouns (`3 succeeded`, not `3 met`) so the divider and the rows speak
the same language. This note records the tension; the divider rewrite is
deferred to a copy PR, not pre-emptively flipped here.

### Recourse labels

Smart-task heroes render at most one recourse button. The label is action-oriented and names what the user should do *now*, not where the click lands. The **live "cannot finish"** hero and the **history-detail "missed"** card use *different* label sets — keep them distinct. Source: `CANNOT_MEET_RECOURSE` (live) and `resolveMissedHistoryRecourse` (history) in `deadlineLabels.ts`.

**Live "cannot finish"** (`CANNOT_MEET_RECOURSE`):

| Label | When | Lands on |
|---|---|---|
| `Open Budget` | Daily energy budget is exhausted before the deadline. | Budget tab. |
| `Adjust device` | Any other cannot-finish cause (shortfall, capacity pressure). | Overview tab + opens the device-settings overlay for the affected device. |

**History-detail "missed"** (`resolveMissedHistoryRecourse`):

| Label | When | Lands on |
|---|---|---|
| `Lower daily budget` | Missed run because the day's energy budget was exhausted before the deadline. | Budget tab. |
| `Review device` | Missed run because the device couldn't deliver enough (shortfall, capacity pressure, plan invalidation). | Overview tab + opens the device-settings overlay for the entry's device. |

The prior "Move deadline later" copy promised an action neither destination offered (deadlines are configured via Flow cards, not the device-settings overlay) and was replaced 2026-05-17. The overlay is honest about scope: shed behaviour, target power, boost, modes, priority, and deltas — i.e. settings the user can audit when a run misses.

### "Plan" vs "deadline" on smart-task surfaces

Reserve *plan* for the planning layer. Smart-task surfaces use *deadline*, *objective*, or *smart task* for lifecycle and identity language ("set a deadline", "smart task ended"). Surface labels prefer non-plan terminology — e.g., the inputs card is titled `What PELS has learned`, not `Plan inputs`.

### Smart-task Flow permissions

The `allow_smart_task_rescue` Flow action grants permission. Copy says PELS can let a task go over today's budget, or can limit lower-priority devices so the smart task gets the power it needs. Stay forward: action verbs over hedge phrasing, no "does not guarantee" disclaimer (the hard cap is physical and is documented elsewhere — every smart-task surface doesn't need to repeat the disclaimer).

The smart-task detail and list surfaces render the granted permissions on a
single row whose canonical label is **`Extra permissions (set via Flow)`**
(source: `SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL` in
`packages/shared-domain/src/deadlineLabels.ts`). The label hoists `(set via
Flow)` onto the row owner — what kind of setting this is — so it doesn't read
as a qualifier on the last joined permission clause. Value clauses are
`May go over daily budget` and `May limit lower-priority devices`, optionally
suffixed with ` if at risk` when the mode is `at_risk`.

In user-facing copy this scope is `Extra permissions`. It is **not**
`Allowances`, `Overrides`, `Rescue`, `Rescue scope`, `Rescue permissions`, or
`Smart-task rescue` — even though the code uses `rescue` internally (Flow
action id `allow_smart_task_rescue`, type `DeferredObjectiveRescuePermissions`,
field `objective.rescue`). The internal name predates the user-facing one and
stays as-is for log schema and JSON contract stability; UI copy uses
`Extra permissions`.

Use `while the smart task is scheduled to run` / `while it's scheduled to run` for the shipped `always` mode. Avoid `planned to run` in user-facing error text. Permission changes take effect on the next plan refresh, not immediately; copy should say so when it states the timing at all.

Visible Flow labels and hints use full words for time units: `hours`, not `h`.

### Revision-log row vocabulary

The smart-task detail page renders a `Recent plan changes` panel (live runs) and a `What changed` card (post-finalization). Both surfaces read the same row helpers and the same `revisionReason` resolver in `packages/shared-domain/src/deadlineLabels.ts`, so the canonical short labels for each recorder reason are pinned here and must not drift between surfaces or between user-facing copy and runtime log breadcrumbs.

| Recorder reason | Label | Notes |
|---|---|---|
| `flow_card` | `Updated by a Flow card` | A user-authored Flow card fired and updated the task. |
| `prices_arrived` | `Prices arrived` | First time the planner saw prices for the task's window. |
| `prices_revised` | `Tomorrow’s prices published` | Nordpool publication — reserved for fresher horizons, not internal replans. Typographic apostrophe (U+2019) per the smart-task UI's typography convention. |
| `schedule_revised` | `Schedule revised` (live-task surface may render one of three disambiguated variants — see below) | Internal replan changed which hours run (budget/risk/expansion). |
| `rate_refined` | `Rate estimate refined` | Learned delivery rate adjusted the plan length. |
| `objective_changed` | `Smart task settings changed` | User edited target / deadline / device. |
| `device_unavailable` | `Device was unreachable` | Names the *event the recorder saw* — a single SDK read miss per `feedback_homey_sdk_unreliable`, not a sustained offline state. |
| `measured_deviation` | `Measured rate differed from plan` | Names the cause-effect; "rate updated" was rejected as ambiguous. |
| `flow_permission_changed` | `Flow changed what this smart task may do` | Rescue permission toggle (e.g. exempt-from-budget). |

Fallback for an unmapped reason code: `Plan refreshed (details unavailable)`. Used only when the recorder ships a code the resolver hasn't learned about — treat its appearance in prod as a copy-update prompt, not a user-facing default state. The producer label stays the bare `Plan refreshed` (consumed by the live panel's summary subline + runtime log breadcrumbs, where the terser variant reads better); the row templates on both the live-task panel and the post-finalization history-detail card swap in the longer `Plan refreshed (details unavailable)` variant so the absent diff chip is self-explained. Fallback rows on both surfaces suppress the hour-diff chip (the chip would otherwise misattribute the diff to a vague "Plan refreshed" line that says nothing about why hours changed); the live-task panel additionally emits a one-shot `console.warn` so the gap doesn't go unnoticed.

`schedule_revised` disambiguation (live-task panel only — history-detail rows always render the bare label because the recorder-summarised history entry shape doesn't carry the signals):

| Variant label | Trigger signal | Notes |
|---|---|---|
| `Schedule revised — daily budget shifted` | `dailyBudgetExhaustedBucketCount > 0` OR `floorShortfallCause === 'budget'` | Strongest signal; the most actionable explanation for the user. Wins ties against the other two. |
| `Schedule revised — risk changed` | Prior revision's `planStatus` differed from this revision's (and no budget signal) | E.g. `on_track` → `at_risk` or the reverse. |
| `Schedule revised — cheaper hour opened` | Hours grew vs the prior revision (`hoursAdded > 0 && hoursRemoved === 0`) with no budget or risk signal | Optimizer found new affordable space. |
| `Schedule revised` (bare) | None of the above conclusive | Under-promise rather than mislabel. Mixed-diff swaps (`hoursAdded > 0 && hoursRemoved > 0`) also fall through. |

Em-dash separator (U+2014) per the existing typography convention.

Hour-diff chip wording: `+Nh` (added), `−Nh` (dropped, U+2212 MINUS SIGN to match the typographic minus used by post-finalization rows and cost-meta lines). Both omitted when a revision only redistributed kWh across the same hours.

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
4. **Chips are short; reason lines are longer.** Chip: `Limited`. Reason: `by today's daily budget`.
5. **No internal planner terms in normal live status.** `backoff`, `invariant`, `shortfall`, `swap`, `headroom cooldown` belong in advanced diagnostics only.
6. **Don't rename established user-facing terms unless the change is clearly better.** Confusion from renaming has a cost too. `Budget`, `Managed`/`Unmanaged`, `Capacity`, `Priority`, `Mode` stay.

## Hard cap is physical

The hard cap is a property of the user's grid tariff or breaker, not a tuning knob. UI copy must not suggest users raise the hard cap to relieve pressure. The recommended remedy when the daily budget runs out before a deadline is to **lower the daily budget** so future days reserve available power earlier — see `cannotMeetDailyBudgetExhausted` copy in `deadlineLabels.ts`.
