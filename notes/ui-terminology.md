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

The hero's decision sentence (the named-subject conclusion at the bottom of the
card — ladder in [`notes/overview-hero-spec.md`](overview-hero-spec.md)
§ "Decision sentence") differentiates the above-hard-cap case so it never
overpromises mitigation. The default reads `Over the hard cap right now. Easing
devices off.`, but when the managed shed cascade is exhausted (no controllable
managed device left running to ease off) and the remaining breach comes from a
device with **Power-limit control** turned off, the copy switches to the honest
variant: `Managed devices are already eased off. The remaining draw is from a
device that has Power-limit control turned off. Turn its Power-limit control
back on so PELS can ease it off.` It names the actual control (never an invented
feature name) and the user's real recourse — turning that device's Power-limit
control back on, **not** raising the hard cap (which is physical; see § "Hard
cap is physical"). **`eased off`** / **`ease off`** is the sanctioned verb for
the hard-cap shed cascade in this decision sentence (it pairs with the default
`Easing devices off.`); reuse it here rather than reaching for a synonym, and
keep the chip/secondary-text language (`Limited`, `Turned off by PELS`) for the
per-device surfaces below.

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

### "Held back" — the Held-back-devices widget

The standalone **Held-back devices** dashboard widget (formerly "Get power now") uses **Held back** for a device PELS is restraining because of the daily budget, with a per-device **Let it run now** action (a one-device budget exemption — never a hard-cap change). The duration chip word is cause-specific so it never overclaims: only **budget** rows (the releasable "Let it run now" state) read `Held back · N min`; **capacity** rows read `Waiting · N min` (physically held — the hard cap is not a tuning knob) and get an informational note instead of a rescue button. (There is no "manual"/"external" cause: a device PELS merely keeps below its target is not starved, so it never appears here.) This is a deliberate, widget-scoped synonym of the overview **Limited** chip: the widget's job is specifically the budget-restraint case the owner can release, so the conversational "held back" reads better there than "Limited". The **device-detail diagnostics** surface now also uses **Held back** (formerly "Starved") for the same condition, so the advanced surface no longer forks the user-facing vocabulary. Keep these two deliberate: **Limited** (overview chip) and **Held back** (the widget and device-detail diagnostics).

### Headroom-widget chips — "Available power" widget

The **Available power** (headroom) dashboard widget shares vocabulary with the rest of the surfaces. Source of truth: `packages/shared-domain/src/headroomWidgetCopy.ts` (count + chip) and `packages/shared-domain/src/priceLevelChips.ts` (price pair).

- **Held-back count** reads **"N held back"** (e.g. `2 held back`), not "N paused" or "N limited", so the count word matches the dedicated **Held-back devices** widget above. Helper: `headroomHeldBackLabel`.
- **Price chip** uses the canonical **"Price low"** / **"Price high"** pair from `priceLevelChips.ts` — never the bare "Cheap" / "Expensive". The widget only ever renders the chip for `cheap` / `expensive` (`SHOW_PRICE_CHIP_FOR` in the renderer); for both `normal` and `unknown` the chip is hidden. The placeholder dash is only the `headroomPriceChipLabel` return value for `unknown` (so logging has a stable token) — the widget never paints it. The screen-reader phrase is the grammatical **"Price: low"** / **"Price: high"** (`headroomPriceAriaLabel`), never the broken "Price Cheap" / "Price Normal" form.

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

#### Empty-state headlines

The smart-task list distinguishes two zero-active-card states by whether the
Past tasks archive below has any finished runs. Headlines come from
`DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE` in
`packages/shared-domain/src/deadlinesListHero.ts`; the first-run body intro is
`SMART_TASK_LIST_EMPTY_COPY.intro` in `deadlineLabels.ts`.

| State | Headline | When |
|---|---|---|
| First run (no history) | `Add your first smart task` | No active cards and the Past tasks archive is empty — the headline pairs with the `No smart tasks yet` body intro, which names both creation routes: the Flow-card actions and the separate "New smart task" widget. |
| Between runs (history exists) | `No smart tasks scheduled` | No active cards but the archive has finished runs — the calmer present-tense headline; the body (`DEADLINES_LIST_BETWEEN_RUNS_BODY`) points down to Past tasks. Never `first` / `yet` here — that framing would erase a returning user's history. |

### Past-task outcome chips

The smart-task history surface (past-tasks archive, history-detail hero) uses a
closed adjective set to label how a finished run ended. Source: `OUTCOME_LABELS` in
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

#### Chip adjectives vs divider verbs

The chip set is adjective-shaped (`Succeeded` / `Missed` / `Abandoned`). The
past-tasks week-divider heading previously used a verb form — `Week 20 · 4
deadlines met · ≈ 41 kr` — which didn't line up with the chip vocabulary the
rows underneath it carry. The chip set is the canonical one, and summary copy
now aligns to the chip adjectives (`3 succeeded`, not `3 met`) so the divider
and the rows speak the same language. Shipped in PR #1243: the divider lead
label is now relative (`This week` / `Last week` / `Week of 12 May`) and the
outcome counts use the chip vocabulary (`N succeeded · N missed · N abandoned`,
non-zero counts only).

#### 7-day hit-rate strip

A summary strip leads the past-tasks list with the rolling-7-day aggregate.
Source: `SMART_TASK_LIST_7DAY_HIT_RATE_LABEL` and
`formatSmartTaskHitRateFragment` in `packages/shared-domain/src/deadlineLabels.ts`.

- **Lead label:** `Last 7 days, all devices`. The `, all devices` qualifier is
  load-bearing — the strip total always spans every device, so it can't be
  read as a contradiction of a device-filtered "This week" count sitting below
  it.
- **Hit-rate fragment:** `N% of M finished` (e.g. `67% of 3 finished`). The
  percent is succeeded ÷ (succeeded + missed); `M` names that denominator so
  the rate reconciles with the counts beside it. `finished` (the
  `SMART_TASK_LIST_HIT_RATE_FINISHED_NOUN`) names succeeded + missed runs —
  abandoned/replaced runs stopped early and sit outside the denominator. Do
  **not** drift back to the bare `N% hit rate` form, which hid the denominator.

Full strip example: `Last 7 days, all devices · 2 succeeded · 1 missed · 67% of 3 finished`.

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

### Smart task live page (two-chart split)

The live smart-task detail page renders two question-titled chart cards. All strings live in `packages/shared-domain/src/deadlineLabels.ts` so the UI and runtime log breadcrumbs share one vocabulary.

**Card titles** (always question-shaped):

- Schedule card: `When will it run, and at what price?` (kind-agnostic — the kind verb lives in the planned band, not the title).
- Trajectory card: `Will it reach {target} in time?` where `{target}` is `formatProgressValueForUnit` output (`65.0 °C` / `80%`).

**Pinned readout** (under the schedule chart) — primary line grammar is `time · price · third segment`:

- Time segment: `Now` for the current hour (canonical `NOW_MARKER_WORD`, also the axis label at the now column), else `HH:MM`.
- Price segment: `0.62 kr/kWh` (two decimals, display-scaled unit).
- Third segment, one of:
  - `{Kind verb} N kWh planned` — planned hour (`Heating 2.0 kWh planned`), optionally suffixed `· Measured N kWh` when the tracker saw real energy that hour.
  - `Idle — heating starts HH:MM` — idle current hour with a later run scheduled. Capitalized `Idle` like its sibling segments; the embedded kind verb stays lowercase mid-sentence. Never claims the kind verb as active while the hero says it starts later.
  - `Idle` — idle current hour, nothing scheduled.
  - `Not scheduled` — idle non-current hour.
- Secondary line: at rest (no explicit selection) it is always the scrub hint `Drag across the chart to read any hour`; once the user actively selects an hour (including re-selecting Now) it shows that hour's revision-reason sentence (e.g. `Updated as new prices arrived`) when one exists, else the hint.

**Trajectory stateline** (under the trajectory chart), two variants:

- On-track: `{X} now · on track — projected ready ≈ {T}, {N} hours before the deadline` (full word `hours`, singular-aware `1 hour`; `just before the deadline` under one hour). The status word is the lowercase mid-sentence form of the chip vocabulary (`on track` / `at risk`); plan status `invalid` renders no status word at all.
- Danger: `Projected {X} at the deadline · {Y} short` (e.g. `Projected 58.0 °C at the deadline · 7 °C short`). The shortfall amount label (`7 °C short` / `12% short`) is shared with the on-chart gap annotation.

**Planned/run bands**: both charts label their band with the same kind verb — `Heating` / `Charging` (`deviceSeriesName`). Never a different word per chart (the old trajectory `runs` label is retired). Only the first contiguous band carries the label.

**Deadline marker**: the marker word is `deadline` on both charts. The schedule chart appends the full form (`deadline Sun 09:00`); the trajectory chart uses the bare word on-track and appends the clock time (`deadline 16:00`) only on the danger variant. The trajectory target line is labelled `Target {value}` (`formatSmartTaskTargetLabel`).

**Trust caption** (under the schedule chart): `Picked {N} of the {M} hours it can use · avg {P} {unit}`. "the M hours it can use" names the chart's eligible pool; it intentionally does not reuse the hero's "hours left" figure, which counts from now and can differ by one. No window-average comparison — the muted unplanned bars carry the baseline visually.

**Queued "why" subline** (hero, below the headline): `Cheaper than now — starts at HH:MM.` may only render when the producer-verified comparison holds (planned-hours average price strictly below the current hour's price). Otherwise the non-comparative form `Scheduled for the cheapest hours it can use — starts at HH:MM.` renders — "it can use" is the trust caption's eligibility vocabulary, and the claim is true by construction (the planner fills cheapest-first among eligible hours) without comparing to now. Never state "cheaper than now" unverified — the schedule chart below would show the disproof.

### Smart task history detail (receipt-first)

The finalized-run detail page (chart-overhaul Phase 1B). All strings live in `packages/shared-domain/src/deferredPlanHistoryDetailInteraction.ts`, `deferredPlanHistoryChartData.ts` (`historyDetailChartLabels`), and `deferredPlanHistoryReceipt.ts` so the UI and runtime log breadcrumbs share one vocabulary.

**Card titles** (question-shaped, like the live page):

- Trajectory card: `Did it heat up as planned?` / `Did it charge as planned?` (kind-aware; replaces the retired `Progress history`). Legacy v3 entries keep `Scheduled vs observed`.
- Hourly strip: `When did each hour run, and what did it cost?` — and the title's promise is paid by the strip's pinned readout (per-hour cost on tap), never left rhetorical.

**Hero (Succeeded, receipt-first)**: outcome chip + headline + the 3-row receipt timeline (`Started` / `Largest planned hour` / `Ready`) + the cost narrative line `≈ 3.10 kr · 0.52 kr/kWh on average · 6.0 kWh delivered` (fragments suppress individually when data is missing; minor-unit currencies render whole integers). `View details` expands the trajectory chart AND the hourly strip together. Missed keeps the diagnosis-first shape (charts expanded, shortfall chip + Why + recourse) and the whole-kr `≈ 12 kr spent` cost chip — `spent` names what the figure is (money already spent on the failed run), and the shortfall chip already carries the delivered figure.

**Trajectory legend** (compact DOM row, not an ECharts legend): `Measured` / `Planned` / `Target {value}` (`formatSmartTaskTargetLabel`). The y-axis labels only the floor and mid ticks — the target value is carried by the legend item, never an axis tick (the 67.0/65.0 collision fix).

**Plan-change marker** (revised runs only): on-chart label `Plan changed HH:MM` at the first post-start revision. The default view shows ONLY the final staircase; the `Compare with initial plan` switch (inside the expanded details) reveals the dashed original. Dash grammar: dashed = the superseded initial plan here, and "Planned, didn’t run" on the strip — planned bands stay solid tint.

**Pinned readouts** (the live page's primitive — no floating tooltips on touch, one interaction grammar):

- Trajectory: `21:00 · Measured 56.1 °C · Planned 56.5 °C`; when the hour contains the plan change, the second line is `Plan changed here — {revision-reason label, lowercased mid-sentence} ({±Nh diff})`, e.g. `Plan changed here — tomorrow’s prices published (+3h −3h)`. Unknown reason codes fall back to the bare `Plan changed here` (no misattributed diff). Default selection: the plan-change hour, else the met hour, else the last measured hour.
- Strip: `23:00 · 1.1 kWh · 0.48 kr/kWh ≈ 0.53 kr` (price scaled by the entry's RECORDED cost display) with a second-line verdict: `Ran as planned`, `Skipped at the HH:MM plan change — {reason}` (only when exactly one recorded replan makes the attribution honest; a bare `schedule_revised` reason keeps the stem only — "plan change — schedule revised" is a tautology), the neutral `Planned, didn’t run`, or `Not scheduled` (gap hours). Default selection: the tallest delivered bar.

**Strip legend chips**: `Price low` / `Price normal` / `Price high` + the dashed sample `Planned, didn’t run` — the SAME string (one phrasing + casing) as the readout's skipped verdict. The colour names the price level; the bar height is energy.

### Usage tab chart readouts (pinned, one interaction grammar)

The four Usage-tab charts (Today-so-far hourly bars, Daily usage history, Typical day pattern, Detailed hourly view heatmap) reuse the smart-task pages' pinned-readout primitive: no floating ECharts tooltip on touch — tap a column (a cell on the heatmap) to select it (visible select border in the on-surface text tone; the current-hour marker keeps its own `--pels-chart-current-border` colour), tap outside the plot to restore the default selection, and the row under the chart carries the values. On desktop (hover-capable fine pointers) the floating tooltip shows the SAME structured content and the pinned row is hidden — one caption per modality, never both. The row is never empty: the default selection is the current hour on the Today view, the most recent complete day on the daily history, the peak point on the typical-day pattern. Resolvers live in `packages/settings-ui/src/ui/chartTooltipFormat.ts`; the over/within-budget stems live with the Budget hero strings in `packages/shared-domain/src/dailyBudgetHeroStrings.ts`.

Two-line grammar — primary line names the time bucket, secondary line carries the measurements joined with ` · ` (measurement segments use non-breaking spaces internally, so a unit never wraps away from its number; wraps happen only at the separators):

- Today so far / Yesterday (hourly): `13:00–14:00` / `Measured 1.31 kWh`, plus `Managed 0.80 kWh · Background 0.51 kWh` when the split exists, plus `Unreliable — some readings missing this hour` (warn tone) when the hour is flagged — the readout names the consequence; the chart legend and stat strip keep their established one-word `Warning`/`Warnings` labels. The range closes the day at `23:00–00:00`. The in-progress current hour reads `Measured 0.45 kWh so far`.
- Daily usage history: `Thu 4 Jun` / `12.6 kWh` (the rendered date format — locale-dependent, no comma in en-GB-style locales), plus budget context only when a daily budget is configured: `1.2 kWh over budget` (warn tone) or `Within budget of 14.0 kWh`. The budget number is the ACTIVE daily budget — the same one the Budget tab's hero shows — never the budget-adjust draft. The window-clipped oldest day of the 14-day history reads `9.1 kWh (partial day)`.
- Typical day: `13:00–14:00` / `Average 1.24 kWh`.
- Detailed hourly view (week heatmap): `Thu, Jun 4 · 13:00–14:00` / `1.24 kWh` — a cell that aggregates more than one physical hour (DST fall-back) keeps the established `2.40 kWh total` suffix, and flagged cells add the same `Unreliable — some readings missing this hour` consequence line. The default selection is the most recent cell with data; a tap on an empty cell or outside the grid restores it.

Vocabulary stays canonical: `Measured` / `Managed` / `Background` / `budget` — never `controlled` / `uncontrolled` / `shed`.

### Budget tab chart readout (pinned, one interaction grammar)

The Budget chart (Progress + Hourly plan modes) reuses the same pinned-readout primitive. Vocabulary: `Budget` / `Actual` / `Projection` / `Price`. The green reference is the **budget pace** (the daily budget spread across the day, cumulative) — it is labelled `Budget`, never `Plan` (the weather-blind "Plan" line was retired; "typical usage" lives on the Usage and Weather surfaces, not here). Resolvers live in `packages/settings-ui/src/ui/budgetRedesignChartData.ts` + `chartTooltipFormat.ts`.

- Progress (cumulative): primary line uses the cumulative `By HH:MM` form — the value reached at that bucket's END boundary, e.g. `By 14:00` / `Budget 8.4 kWh · Actual 7.9 kWh`, plus `Projection 8.6 kWh` when the projection covers the hour. One-decimal kWh (the Budget hero's precision). The end-of-day column reads `By midnight`, never `By 00:00` — a cumulative "by" anchored at 00:00 misreads as the day's start.
- Hourly plan: primary line uses the hourly range form `13:00–14:00` (closing the day at `23:00–00:00`), e.g. `Budget 0.92 kWh (Managed 0.51 · Background 0.41)` plus `Price 0.84 kr/kWh` and `Actual 0.71 kWh`. Two-decimal per-hour buckets; the split halves inside the parenthetical drop their unit (the leading Budget figure names kWh for the line).
- Default selection: Today follows the current hour in both modes; yesterday/tomorrow anchor on the end-of-day column in Progress mode (the cumulative chart's answer is how the day ends) and on the day's peak hour in Hourly plan mode.

Deliberate distinction: the Budget readout says `Actual` — it pairs with `Budget` (budget vs. actual) — while the Usage readouts say `Measured` (a bare measurement with no budget to compare against). Both terms stay; do not unify them.

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
