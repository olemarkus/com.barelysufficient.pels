# UI Terminology Guide

Canonical user-facing vocabulary for PELS. Follow it in UI labels, help text, status strings, and docs. Internal code identifiers (planners, tests, logs) keep their existing names.

## Core principle

> User-facing UI should say **what happens**. Advanced docs may explain why the planner does it.

Prefer: `Waiting to resume — 0.8 kW more needed`
Avoid: `restore blocked: insufficient headroom`

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

### Time anchors — every projected/budget figure names its window

The same words (`Projected`, `Budget`) describe an **hour** figure on the
Overview hero and a **day** figure on the Budget tab and the Budget-and-Price
widget. A bare `Projected 16.8 kWh` on one surface next to `Projected this
hour 4.4 kWh` on another reads as a contradiction, so every projected/budget
figure carries its time window in the label:

| Window | Anchor | Where |
|---|---|---|
| Current hour | `… this hour` | Overview hero (`Energy used this hour`, `Budget this hour`, `Projected this hour`) |
| Current day | `Projected today` | Budget tab hero headline; Budget-and-Price widget headline (`Projected today 16.8 kWh · 19.60 kr`) |
| Next day | `Planned for tomorrow` | Budget tab hero headline; Budget-and-Price widget headline — "Planned", not "Projected", because there is nothing measured to project from yet |

The widget headline lead is byte-aligned with the Budget tab's
`DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW` (`dailyBudgetHeroStrings.ts`) — the
widget copy imports those constants (`planPriceWidgetCopy.ts`) so the two
surfaces cannot drift.

### "Safe pace now" — one label, two possible sources

The dynamic tick on the power bar shows where PELS starts reacting. It can come
from two constraints, and **the hero names which one, visibly** — on the
Power-now subline, not only in the marker tooltip:

| Source (`meta.softLimitSource`) | Subline clause (`SAFE_PACE_SOURCE_BY_SOURCE`, appended after ` · `) |
|---|---|
| `capacity` | set by this hour's pace |
| `daily` | set by today's budget |
| `both` | this hour's pace and today's budget meet here |

So the on-track subline reads `Safe pace now 1.9 kW · set by today's budget`,
and the over-pace subline folds the same clause into its existing parenthetical:
`1.5 kW above safe pace (12.0 kW · set by today's budget)`.

This became load-bearing on 2026-08-02, when device cards stopped naming the
binding ceiling (see § "Device cards say what a device needs"). WHICH ceiling
binds is one house-level fact, so the hero states it once and the cards spend
their single line on what each device needs. The hero is therefore the only
place the owner can read it — and a hover tooltip is not a place: the settings
UI runs in a touch WebView where nothing hovers. Unknown source renders no
clause; guessing one would risk naming the hard cap when it is not binding
(see § "Hard cap is an hourly ceiling").

The marker tooltip below keeps the longer explanation for pointer devices.

| Source (`meta.softLimitSource`) | Tooltip (appended after the `Safe pace now N kW —` stem plus a space, so the body separates with a semicolon, not a second em-dash) |
|---|---|
| `capacity` | the hourly pace sets this marker; PELS starts reacting here |
| `daily` | today's budget sets this marker, which may include power allowed beyond today's budget; PELS starts reacting here |
| `both` | the hourly and daily paces meet at this marker; PELS starts reacting here |

When `daily` or `both` is active and the plan supplies a non-zero allowance for
devices outside today's budget, expose the composition below the power bar:
`Safe pace reserves 7.0 kW for devices allowed beyond today's budget; usage
counted toward today's budget is paced at 5.0 kW.` The marker tooltip uses the
corresponding detailed form:
`Safe pace now 12.0 kW — today's budget paces counted usage at 5.0 kW, plus
7.0 kW reserved for devices allowed beyond it; PELS starts reacting here.`
When both constraints meet at the marker, the detailed tooltip must also name
the hourly pace. Do not call those devices "exempt" in user-facing copy.

The **hard cap** tick (user-configured ceiling, `hardLimitKw`) always renders — including when the dynamic safe pace sits at or above it — and reads **Hard cap** with tooltip body: `your grid tariff step; PELS keeps each hour's average power under this`. Never "breaker trips": an hourly-average ceiling cannot prevent them (see § "Hard cap is an hourly ceiling"). When the hour's projection pushes the energy bar's scale up to the cap, the energy bar also renders a cap tick labelled `Hard cap this hour N kWh` — the threshold that turns the projection critical, printed in kWh where the judgement is made.

### Safe pace, hard cap, and safety margin

Keep these three concepts distinct:

| Term | Meaning |
|---|---|
| **Safe pace** | Dynamic planning pace to stay on track. Legitimately rises above the hard cap late in an under-used hour. |
| **Hard cap** | Configured hourly-average ceiling (grid tariff step) no hour's energy should exceed. |
| **Safety margin** | Buffer below the configured capacity/tariff limit. |

Do not use `power limit` as a casual threshold label where it could blur Safe pace vs Hard cap.

### Hero legend

Two rows under the power bar — the tick legend (swatch + label with value, the
only touch-reachable home for these numbers since tooltips need hover), then
the segment split:

```text
▮ Safe pace now 6.0 kW   ▮ Hard cap 8.0 kW
Managed 3.2 kW  ·  Background 2.9 kW
```

The value line should not repeat the time meaning already carried by the label:
use `1.2 kW`, not `1.2 kW now`.

**Split-pair order is Managed → Background everywhere** — the hero legend
above, the Budget hero split bar, the Usage chart legend, and the Budget
hourly-plan chart legend. Legends follow this reading-priority order (the
pair the user scans for first is the part PELS controls), **not** the chart's
bottom-to-top stack order — a legend that mirrors stack order on one surface
and reading order on another flips the pair between adjacent tabs (decided
2026-07, from PR #1806 review).

Marker grammar for read-only meter tracks:

| Marker | Meaning |
|---|---|
| Solid dot | Actual/current value |
| Hollow dot | Projected/forecast value |
| Thin tick (neutral) | Threshold/target |
| Thin tick (warning-toned) | Hard cap reference — renders wherever the cap falls on the scale |

Overview status chips are hidden when everything is normal. Show short exception chips only:

| Condition | Chip |
|---|---|
| Current power is above the dynamic threshold | `Above safe pace` |
| Projected hourly energy is above budget | `Above budget` |
| Projected hourly energy is above the hard cap | `Above hard cap` |

`Above hard cap` is a **trajectory** chip: it fires when the hour is on pace to
land past the cap's hourly kWh, never on instantaneous kW above the cap (see
§ "Hard cap is an hourly ceiling").

The hero's decision sentence (the named-subject conclusion at the bottom of the
card — ladder in [`notes/overview-hero-spec.md`](overview-hero-spec.md)
§ "Decision sentence") differentiates the above-hard-cap case so it never
overpromises mitigation. The default reads `On pace to exceed the hard cap this
hour. Easing devices off.` — but the action clause renders only while a
controllable managed device is still drawing (the trajectory alone does not
imply PELS has load left to act on: the hour may have banked the energy with
everything already settled off, where the sentence is just `On pace to exceed
the hard cap this hour.`). Under Simulation mode the action clause is likewise
dropped, because PELS is not acting and must never claim it is. When the
managed shed cascade is exhausted (no
controllable managed device left running to ease off) and the remaining breach
comes from a device with **Power-limit control** turned off, the copy switches
to the honest variant: `Managed devices are already eased off. The remaining
draw is from a device that has Power-limit control turned off. Turn its
Power-limit control back on so PELS can ease it off.` It names the actual
control (never an invented feature name) and the user's real recourse — turning
that device's Power-limit control back on, **not** raising the hard cap (see
§ "Hard cap is an hourly ceiling"). **`eased off`** / **`ease off`** is the sanctioned verb for
the hard-cap shed cascade in this decision sentence (it pairs with the default
`Easing devices off.`); reuse it here rather than reaching for a synonym, and
keep the chip/secondary-text language (`Limited`, and the per-device reason
ladder) for the per-device surfaces below.

## Device state words (Overview cards)

Every Overview device card leads with one bold canonical state word in its
state row (source: `PLAN_STATE_LABEL` in `planStateLabels.ts`; grammar in
`planCardGrammar.ts` and `notes/overview-hero-spec.md` § Device cards):

| State word | Used when |
|---|---|
| **Running** | The device is on, charging, heating, or otherwise active. A target-only device (no on/off axis) reads **Running** by inference — except when demonstrably satisfied (temperature at/above the highest known target, drawing ~0 kW), which resolves **Idle**. Heating semantics; a device actually drawing power always reads Running, and the satisfied check never fires against a PELS-lowered setpoint or while a target write is in flight. |
| **Idle** | The device is available and on (or has no binary on/off axis), but currently has nothing to do — including a satisfied target-only thermostat at/above its target drawing nothing. |
| **Off** | Homey explicitly reports the device off—through its binary control or a stepped-load off step—and no higher-priority PELS state below applies. Never infer this from `0.0 kW`, temperature, or target alone. |
| **Limited** | PELS is lowering, pausing, turning off, or making the device wait for power — including a device the planner left inactive because there is no room ("waiting to resume"). Never pair `Idle` with a waiting/hold reason. |

**Leave off until turned on again** renders `Off` + `Turned off elsewhere —
turn it on to resume`. A waiting-for-power hold still renders `Limited`; `Off`
is the factual binary state only when PELS is not currently limiting or
resuming the device. This is why the `externalOffHold` reason code remains
absent from `HOLD_REASON_CODES` in `planCardGrammar.ts`.
| **Resuming** | PELS is bringing the device back as power becomes available. |
| **Manual** | The device is managed but PELS does not have power-limit control for it right now. |
| **Unavailable** | PELS does not currently trust the device state enough to plan with it. |
| **Unknown** | PELS does not have enough current state to choose a more specific word. |

**Card grammar (2026-07 legibility pass):** one anatomy for every card —
title + at most ONE status chip (ladder: `Let it run now` → `Held back` →
`Boost` → `Budget exempt`; the `Smart task` badge is an
identity/route badge and may coexist), the state row (state word + power
fact), one modality fact line (`20.3 °C · target 22 °C`, `Charging · 64 % ·
level 6 A`; the arrow `→` is reserved for a target *change*), and at most ONE
exception reason line. An EV charger's fact line carries the car's battery
level in the slot a temperature device uses for its measured value — that is
the number the owner is asking the card for, not only the amps PELS set. It
appears only for a `fresh` reading; a stale or invalid one is dropped rather
than qualified, because the card is a glance and 320 px is the floor (device
detail spells out `stale` / `Invalid report`). Quiet states render no chip and no reason. `Off` is now
one of the shared state words; the older modality-specific bare `On`/`Off`
output slot and the stepped card's `Off now` / `Level: Max` bold slots remain
retired.

### EV charger exception labels (stepped card reason slot)

An EV charger's exceptional charging states render in the reason slot when no
status line claims it (source: `resolveSteppedEvExceptionLabel` in
`planSteppedCardText.ts`): `Paused`, `Discharging`, `Unplugged`, and the
plugged-in-idle pair below. Routine charging folds into the fact line
(`Charging · level 16 A`) instead.

The plugged-in-idle state (`plugged_in`) discriminates on the charger's own
on/off capability (`evcharger_charging`), because the plug state only states a
fact (connected, not charging), never a cause:

| Label | Used when |
|---|---|
| `Waiting for car` | The charger has been told to charge and still no current flows — the car (scheduled departure charging, full battery) is the holdout. |
| `Not charging` | The charger is switched off. Nothing is on offer, so nothing is waiting on the car; blaming it here is false. |

The claim turns on the charger's command, not on what PELS wants — PELS's
commanded step is not a command at all when the device's Power-limit control is
off, and reading it as one is what once labelled a switched-off charger
`Waiting for car`. Because the gate is an observation, it holds in simulation
too. Matrix of record: `notes/ev-charger-state-copy.md`.

### Device cards say what a device needs; the hero says what limits the house

The reason line under a Limited card states **what this device needs**. It does
NOT name the binding ceiling: which ceiling binds — the hard cap, this hour's
pace, today's budget — is one house-level fact, identical for every device, and
the hero states it once on the Power-now subline (§ "Safe pace now"). Repeating
it per card printed the same sentence N times while the reader's actual question
went unanswered.

Ladder (source of truth: `resolveHeldCardReasonLine` in `planCardReasonLine.ts`,
shared by all three card variants):

| Situation | Line |
|---|---|
| Held on power, shortfall known | `Waiting to resume — 0.8 kW more needed` (stepped step-up: `Waiting to increase — …`) |
| …and held long enough to count as held back | `Held 2 h — 0.8 kW more needed` |
| Held because this hour's energy budget is spent | `Waiting to resume — this hour's budget is spent` (held back: `Held 2 h — this hour's budget is spent`) |
| Held on power, no shortfall resolved (rare) | `Waiting to resume` |
| Long held back, no shortfall | `Waiting for available power` |
| Hold that is NOT about power | its own cause (below) |

**Held-back cards state the elapsed hold, and still name no ceiling** (2026-08-04).
Once a hold has run long enough to register as held back, the stem becomes
`Held 2 h` instead of `Waiting to resume`. The duration is the device's own
fact — and the only one that answers why THIS card carries the `Let it run now`
action while its neighbours, held in the same cycle, do not. It replaced
`Limited to stay within today's budget`, which opened by restating the `Limited`
state word and closed by naming a house-level ceiling the hero already states
once. The line reads the same whichever ceiling is binding: the budget and the
hourly pace are the same whole-home limit from a device's point of view, and
which one binds moves on its own.

The shortfall is the kW that would actually admit the device — reserves folded
in (`resolveRestoreShortfallKw`), not `need − available`, which understates the
real gate by ~0.5 kW.

Since 2026-08-02 the shortfall exists for **every** power-liftable hold, with no
distinction by which ceiling binds (user ruling): `finalizeCeilingReason`
(`lib/plan/planReasons.ts`) recomputes the device's own admission gap **every
cycle** from the current per-axis availability — including for swap holds,
where the number is THIS device's need against the current pace, never the
swapped-in device's figures. Fresh wins over producer-minted numbers: a
rejection snapshot carried across cooldown/overshoot cycles pinned "2.3 kW more
needed" on prod cards (2026-08-02 evening) while the recovered pace put the
true gap at 1.3 kW. The bare `Waiting to resume` line survives only where the
arithmetic honestly declines (a reserve block — the card names the holder
instead — admission passing this cycle, the exhausted hour on a swap hold, or
inputs missing in tests).

The hourly-exhausted line is the one ceiling hold that must NOT show a kW: the
hour's kWh is spent and cannot be un-spent, so no freed power admits the device
before the hour rolls over. While accrued pace headroom could still fit the
device this hour, the normal kW line applies — the time-based copy is only for
the truly spent hour (`hourlyBudgetExhausted`).

Holds where power is not the blocker keep naming their cause, because freeing
power would not start them and a kW figure would be a lie: `Waiting for cheaper
hours` (smart task), `Waiting for solar surplus`, `Turned off elsewhere — turn
it on to resume`, `Waiting so {device} can start` (startup reservation),
`Holding at 6 A — cannot increase while 2 devices are limited` (stepped fairness),
and the countdown lines (`Waiting before resuming (50s)`).

**Retired 2026-08-02 — do not reintroduce on a card:** `Turned off by PELS`,
`Lowered by PELS`, `Limited by the hard cap`, `Limited by today's daily budget`,
`Limited — this hour is near the hard cap`, `Making room for higher-priority
device`, `Blocked by safety rule`. The first two restated the bold `Limited`
state word and named no cause at all; the rest are house-level.

**The spent-hour hold is a documented exception to "cards name no ceiling."**
Every other held card has a device-scoped need to state — the kW that would admit
it. This one has none: the hour's energy is spent, so freeing power changes
nothing, and the reason line's only honest content is the condition itself. It is
the same carve-out that lets a smart-task or solar-surplus hold keep its own
cause. Do not "fix" it by substituting device-scoped wording; there is no
device-scoped fact to substitute.

**Never promise the next hour will be roomier.** The spent-hour line states the
condition (`this hour's budget is spent`) and names no recourse. The retired
`— more budget next hour` promised an event PELS cannot underwrite: the hour can
un-exhaust itself mid-flight, because the hour's usage bucket is NET and floored
at zero, so a solar export burst pulls it back under the budget with no rollover
involved. Pointing the owner at the next hour tells them to wait for the wrong
thing. Applies to any future copy, not just this line.

**Retired 2026-08-04 — do not reintroduce anywhere:** `Limited to stay within
today's budget` (the held-back card line; failed both tests at once — it opened
by restating the state word and closed by naming a house-level ceiling), plus
the `budget`/`capacity` badge pair `Budget limited` / `Low power` and the widget
chip word `Waiting`. All four keyed off a starvation cause bucket that no longer
exists: it was a snapshot of whichever constraint bound on the last accumulation
tick, so it flipped mid-hold and took the copy — and the rescue button — with it.
One badge (`Held back`, warn) and one chip word (`Held back`) now serve every
held-back device.

Where they survive, precisely: the ceiling/swap strings stay in
`formatDeviceReasonUserFacing`, which feeds the runtime logs and the device
**activity log** (`lib/plan/deviceOverviewLog.ts` → the `ui_device_log` list
inside device detail) — except `Limited — this hour is near the hard cap`,
which is retired EVERYWHERE: it misdescribed the trigger (the hour's kWh being
spent, not cap proximity), and the `hourlyBudget` reason now renders
`Waiting to resume — this hour's budget is spent` on the card and in the log alike.

They do NOT appear on the device-detail live-status row, which renders no plan
reason except the external-off guidance. `Turned off by
PELS` / `Lowered by PELS` are not in that formatter at all — they lived in
`resolveHeldStateActionLabel`, which now has no production caller.

**Charging paused** survives as an EV *state* word (state row), not as a reason
line.

The kW figure on blocked-resume lines (and the sibling status
`Not enough available power to resume — N kW more needed`) is the
**admission-accurate shortfall** — the amount that, if it became available,
would actually admit the device, with the restore buffer and admission
reserves folded in, ceiled to the 0.1 kW display resolution
(`resolveRestoreShortfallKw` in shared-domain). Never render raw
`need − available` there: it understates the real gate by the reserve stack
(prod 2026-08-01: a card said 0.5 kW when admission needed ~1.0 kW more). The
`restoreNeed` keep-side line keeps its `needs X kW, Y kW available` pair: it
describes a planned raise, carries no admission margins, and is not a promise
that freeing the difference resumes anything.

In **simulation mode** the state word stays FACTUAL — `held`/`resuming` are
PELS-acted claims and PELS acts on nothing in simulation, so the bold word
shows what the device is actually doing (Running/Idle/Off) and only the reason
line is hypothetical: **Would be turned off (simulation)**, **Would be
lowered (simulation)**, **Charging would pause (simulation)**, `Would be
limited …`. The `(simulation)` tag keeps a card scrolled away from the banner
honest on its own. The `Let it run now` action chip never renders under
simulation (there is nothing to release). Source: `DEVICE_OVERVIEW_WOULD_*`
in `packages/shared-domain/src/deviceOverviewStrings.ts` +
`toSimulationReasonLine` in `simulationReasonMood.ts`.

### "Held back" — the Held-back-devices widget

The standalone **Held-back devices** dashboard widget (formerly "Get power now") uses **Held back** for a device PELS is restraining, with a per-device **Let it run now** action (a one-device rescue that lifts the budget for it and clears room from lower-priority load — never a hard-cap change). Every row reads `Held back · N min`, rolling over into hours past 60 minutes (`Held back · 2 h 15 min`). The former cause-specific `Waiting · N min` variant went with the `budget`/`capacity` bucket on 2026-08-04: the bucket was a snapshot of whichever constraint bound on the last tick, so a steady device flipped chip word — and rescue button — between cycles. (There is no "manual"/"external" cause either: a device PELS merely keeps below its target is not held back, so it never appears here.) The only row without a rescue button is one whose device already has its own smart task, which says so in a note. This is a deliberate, widget-scoped synonym of the overview **Limited** state word: the widget's job is specifically the budget-restraint case the owner can release, so the conversational "held back" reads better there than "Limited". The **device-detail diagnostics** surface now also uses **Held back** (formerly "Starved") for the same condition, so the advanced surface no longer forks the user-facing vocabulary. Keep these two deliberate: **Limited** (overview state word) and **Held back** (the widget and device-detail diagnostics).

### Headroom-widget chips — "Available power" widget

The **Available power** (headroom) dashboard widget shares vocabulary with the rest of the surfaces. Source of truth: `packages/shared-domain/src/headroomWidgetCopy.ts` (count + chip) and `packages/shared-domain/src/priceLevelChips.ts` (price pair).

- **Held-back count** reads **"N held back"** (e.g. `2 held back`), not "N paused" or "N limited", so the count word matches the dedicated **Held-back devices** widget above. Helper: `headroomHeldBackLabel`.
- **Price chip** uses the canonical **"Price low"** / **"Price high"** pair from `priceLevelChips.ts` — never the bare "Cheap" / "Expensive". The widget only ever renders the chip for `cheap` / `expensive` (`SHOW_PRICE_CHIP_FOR` in the renderer); for both `normal` and `unknown` the chip is hidden. The placeholder dash is only the `headroomPriceChipLabel` return value for `unknown` (so logging has a stable token) — the widget never paints it. The screen-reader phrase is the grammatical **"Price: low"** / **"Price: high"** (`headroomPriceAriaLabel`), never the broken "Price Cheap" / "Price Normal" form.

## Solar surplus vocabulary

Two per-device surplus controls share the `surplusWilling` opt-in; the label names what happens for that device's modality:

| Concept | Label |
|---|---|
| Temperature device setpoint lift (toggle) | `Use solar surplus` |
| Binary dump-load posture (toggle) | `Run on solar surplus` |
| Temperature card reason while lifted | `Raised to use your solar power` |
| Dump-load card reason while running on surplus | `On to use your solar power` |
| Dump-load card reason while held off | `Waiting for solar surplus` |

Sources: `packages/shared-domain/src/planTemperatureCardText.ts` (both card reasons) and `PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS` in `planStateLabels.ts`.

### Leave off until turned on again

| Concept | Label |
|---|---|
| Setting name (device Setup) | `Leave off until turned on again` |
| Overview state word while held | `Off` |
| Overview reason line while held | `Turned off elsewhere — turn it on to resume` |

Internal name for the state is **external-off hold** — "external" means outside
PELS, and it does not claim a human necessarily performed the action. Keep that
name out of user-facing text. Source: `PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS` in
`planStateLabels.ts`.

The dump-load toggle's helper copy states the reconcile contract explicitly — the user must learn from the toggle itself that a manual ON gets corrected: `PELS keeps this device off and turns it on when your home is exporting enough solar power to cover it. If you switch it on yourself while there is no surplus, PELS will switch it off again.` ("enough … to cover it" is load-bearing — the allocator reserves the device's own restore draw before engaging, so a trickle of export is not enough.)

The toggle is disabled (with a hint stating why) in two substates. Power-limit-control-off takes precedence when both apply: `Turn on Power-limit control above first — PELS needs it to switch this device on and off.` Otherwise, an active smart task: `Unavailable while this device has an active smart task — the task's schedule decides when it runs.` (Both mirror the runtime gate: the posture only takes effect when PELS actually controls the device's on/off — managed AND power-limit-controllable — and a device an active smart task governs is excluded from the surplus hold.)

Scope guidance (v1) names the intended devices and warns against the cold-tank trap: `Good for pool pumps, towel dryers, and garage or cabin heaters. Not for your only water heater — on a run of cloudy days it would stay cold.` Do not soften the water-heater warning; a multi-day cloudy stretch means the tank never heats (comfort and legionella risk).

Internal terms that stay internal: `dump load`, `surplusOnly`, `surplus hold`, `eligibility`, `posture`. Say what happens ("PELS keeps this device off…"), never "hold"/"shed"/"eligible" in user copy.

## Smart task vocabulary

Source of truth: `packages/shared-domain/src/deadlineLabels.ts`. Pull every label from `deadlineLabels(kind)` rather than hardcoding strings.

| Concept | Temperature device | EV-SoC device |
|---|---|---|
| Kind chip | `Temperature` | `EV` |
| Hero section label (eyebrow — pending hero only) | `Heating smart task` | `EV smart task` |
| Live state chip — active (pending hero only) | `Heating` | `Charging` |
| Live state chip — building plan (pending hero / list) | `Building plan…` | `Building plan…` |
| Live state chip — plan ready, first hour later (list only) | `On track` | `On track` |
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

The **live** hero also drops the section-label eyebrow (`Heating smart task` /
`EV smart task`). The panel's `.pels-appbar` title row already says `Smart task`
and the kind chip already says `Temperature` / `EV`, so the eyebrow stacked the
kind a third time. This mirrors the history-detail hero, which dropped its
same-word `Smart task` kicker in the navigation-chrome unification. The
**pending** hero keeps the eyebrow — it carries no kind chip, so the eyebrow is
that hero's only kind signal.

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
| `Paused — unplugged` | EV: charging task is paused because the car is unplugged or the session ended. |
| `On track` | PELS currently expects the task to reach the target — including when the plan is allocated and healthy but its first hour is still in the future. |
| `At risk` | Plan exists but there is limited time or room left. |
| `Cannot finish` | Not enough usable time or energy delivery before the deadline. |
| `Satisfied` | The observed target is met. PELS resumes tracking if a later reading drops below it. |

**`Scheduled` is retired as a status chip** (2026-07 coherence sweep, TODO
402): a task whose plan is allocated and healthy answered "am I on track?"
with `Scheduled` on the list card and `On track` on the detail hero — two
words for one state read as a discrepancy. The list chip now says `On track`
(same `ok` tone as the `on_track` id); the card's `Starts` row still carries
the start time. `Scheduled` remains valid as a plain **schedule/when-window
label** — the create-widget preview row, the Held-back-devices rescue
preview's when-row, the smart-tasks widget trajectory's run-band key, and
"N scheduled hours" prose — just never as a status chip.

Internal note: the `DeadlineLiveState` enum value is still spelled `queued`
(used in chip-tone resolvers and the list status id) so log schemas and JSON
contracts remain stable — only the user-visible chip label changed. `queued`
and `on_track` now share one label and tone; the distinction stays internal.

The dashboard widget's compressed row variants are registered:
`Unplugged` (for `Paused — unplugged`) and `Not charging yet` (for
`Paused — not charging yet`) — the widget row at 320–480 px has roughly half the
list card's width and the full em-dash forms truncate. Source:
`SMART_TASK_WIDGET_STATUS_LABELS` in `deadlineLabels.ts`. The same compressed
forms are the sanctioned inline status words on the list card's Ready-by line
(where the full form's own em-dash would double the separator).

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

### Smart-task extra permissions

Four surfaces set these: the create-smart-task widget's opt-in disclosure (budget
+ limit only), the smart-task detail page's editor (all three, on **and** off),
the `allow_smart_task_rescue` Flow action, and the Held-back devices "Let it run
now" lane, which grants them implicitly. Their strings come from
`SMART_TASK_EXTRA_PERMISSIONS_TITLE` / `SMART_TASK_EXTRA_PERMISSION_LABELS` in
`deadlineLabels.ts` — never inline a new copy. The one sanctioned duplicate is
`planStarvation.ts`'s `extraPermissionsTitle`, which stays a literal because
that module is deliberately kept off `deadlineLabels.ts` so the rescue widget
bundle doesn't pull the full smart-task copy module in; it must stay
character-identical.

Copy says PELS can let a task go over today's budget, limit lower-priority devices, or reserve power so the task can
start sooner. Stay forward: action verbs over hedge phrasing, no "does not
guarantee" disclaimer (raising the hard cap is never a remedy — see § "Hard cap
is an hourly ceiling"; every smart-task surface doesn't need to repeat the
disclaimer).

**Never say the pause permission turns anything off.** It reserves power; it does not switch devices off, and a device that is already off just waits a little longer before resuming. Copy that promises devices are "held off up front" or "paused, including idle ones" describes the retired implementation and is now untrue — see `notes/deferred-load-objectives/preemptive-power-reservation.md`.

The smart-task detail and list surfaces render the granted permissions on a
single read-only row whose canonical label is **`Extra permissions`**
(source: `SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL` in
`packages/shared-domain/src/deadlineLabels.ts`). Do **not** re-add a
`(set via Flow)` qualifier: the detail page's editor sets these itself, so
naming the Flow card would send a user out to build an automation for something
the row sits right beside. The editor's own disclosure reuses
`SMART_TASK_EXTRA_PERMISSIONS_TITLE` (`Extra permissions`) with the edit-lane hint
`Only used to hit this ready-by time.` — the widget's "Off unless you turn them
on" is false for a task that already holds a grant. On a surface where the user
GRANTS a permission rather than reads one back, each toggle also carries its
`SMART_TASK_EXTRA_PERMISSION_HINTS` line: `May pause lower-priority devices` on
its own is read as "PELS switches my devices off", so its hint names the reserve
and denies the switch-off in the same breath.

The two "Extra permissions" blocks on the detail page must never be on screen at
once: the read-only row is suppressed while the editor is open
(`PlanInputsCard`'s `editorOpen`), because a saved value and an unsaved draft
under one label disagree the moment a toggle moves. The open editor shows its
own granted line instead. Value clauses are
`May go over daily budget`, `May limit lower-priority devices`, and
`May pause lower-priority devices`, optionally suffixed with ` if at risk` when
the mode is `at_risk`. `at_risk` is Flow-arg-only and no shipped dropdown offers
it, so no toggle surface needs to express it; the editor's boolean toggles
preserve an existing `at_risk` grant rather than promoting it. `pause` is the
**milder**, boost-free sibling of `limit`: it reserves
power so the task can start sooner, where `limit` boosts the device past the
fairness rules. Never conflate it with boost.

The canonical verb for this is **reserve**, matching shipped copy elsewhere
(`Safe pace reserves 7.0 kW…`, `Background usage reserve`). Do **not** invent
`keep power free`, `hold power`, or `set power aside`.

A lower-priority device waiting on a reservation renders the reason line
`Waiting so <Device> can start` (`reserved_for_start`, source
`packages/shared-domain/src/planReasonFormatting.ts`). The card's state word is still
**Limited** — `reserved_for_start` is in `HOLD_REASON_CODES`, and § "Device state words"
covers a device made to wait for power. Only the reason line differs: it avoids the
`Limited so … can run` form used by `swappedOut`, because nothing was switched off to
build the reservation. Do not reuse `Held back`, which belongs to the budget widget.

Note the deliberate split, same as `awaiting_solar_surplus`: `reserved_for_start` is a
starvation *pause* reason (`packages/contracts/src/deviceDiagnosticsTypes.ts`), so
device-detail diagnostics reads `Not held back — …` while the Overview card reads
`Limited`. That is not a regression; do not re-flag it.

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

**Picked hours / run band**: the schedule chart encodes picked hours directly in its bars — filled mint = picked, the same hue dimmed/outlined = eligible but not picked — decoded by the one-line caption key `SMART_TASK_SCHEDULE_CHART_KEY` (`Filled bars are the picked hours · dimmed bars were not picked`); it carries no band. The trajectory chart keeps its labelled run band with the kind verb — `Heating` / `Charging` (`deviceSeriesName`); never a different word (the old trajectory `runs` label is retired). Only the first contiguous band carries the label.

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

- Today so far / Yesterday (hourly): `13:00–14:00` / `Measured 1.31 kWh`, plus `Managed 0.80 kWh · Background 0.51 kWh` when the split exists — and when the split leaves a real remainder (the chart's neutral third stack segment), the line appends it as **`Other 0.12 kWh`**. `Other` is the canonical word for measured energy the split can't attribute (decided 2026-07; "unattributed" was rejected as jargon). It is named only in the tapped readout — the segment stays off-legend by design. Also `Unreliable — some readings missing this hour` (warn tone) when the hour is flagged — the readout names the consequence; the chart legend and stat strip keep their established one-word `Warning`/`Warnings` labels. When solar makes the gross managed/background split exceed measured net usage, prefix the split line with `Before solar:`. The range closes the day at `23:00–00:00`. The in-progress current hour reads `Measured 0.45 kWh so far`.
- Daily usage history: `Thu 4 Jun` / `12.6 kWh` (the rendered date format — locale-dependent, no comma in en-GB-style locales), plus budget context only when a daily budget is configured: `1.2 kWh over budget` (warn tone) or `Within budget of 14.0 kWh`. The budget number is the ACTIVE daily budget — the same one the Budget tab's hero shows — never the budget-adjust draft. The window-clipped oldest day of the 14-day history reads `9.1 kWh (partial day)`.
- Typical day: `13:00–14:00` / `Average 1.24 kWh`.
- Detailed hourly view (week heatmap): `Thu, Jun 4 · 13:00–14:00` / `1.24 kWh` — a cell that aggregates more than one physical hour (DST fall-back) keeps the established `2.40 kWh total` suffix, and flagged cells add the same `Unreliable — some readings missing this hour` consequence line. The default selection is the most recent cell with data; a tap on an empty cell or outside the grid restores it.

Vocabulary stays canonical: `Measured` / `Managed` / `Background` / `Other` / `budget` — never `controlled` / `uncontrolled` / `shed` / `unattributed`.

### Usage hero dead-band chips — `On pace` vs `On track`

The Usage hero's "nothing to report" chip has two deliberate forms (source:
`usageHeroStrings.ts`), because the two windows make genuinely different
claims:

| Chip | Baseline | When |
|---|---|---|
| `On pace` | Elapsed-pace comparison (`… kWh vs pace`) | Early-morning window where the end-of-day projection is suppressed — the claim is only "so far, today matches a typical day's pace". |
| `On track` | End-of-day projection (`… kWh vs typical`) | Rest of the day — the claim is "today is projected to end near typical". |

Keep both: collapsing them to one word would either overclaim in the morning
(`On track` before a projection exists) or underclaim later. Each chip pairs
with the delta label of its own baseline, so the pair can't mix.

## Price info — one role per surface

Current/near-term price context renders on exactly three surfaces, each with
its own role. Do **not** add a fourth price surface (or move one of these
roles) without updating this table — three renderings of "the price now" is
the ceiling, and each exists because its page mission needs it:

| Surface | Role | Rendering |
|---|---|---|
| Overview hero | The one *actionable* price fact for the set-and-forget owner | `Cheapest hour ahead: 02:00, 0.18 kr/kWh.` subline (`formatCheapestUpcomingHour`) — nothing else |
| Budget tab | Price as *planning context* for the Optimiser | Exception-only `Price low` / `Price high` header chip + the shaping tagline (`Using cheaper hours`) + prosumer `Export price now:` subline |
| Settings → Electricity prices | Price as *configuration + verification* | The `Right now` card (current price, export row, planning-price reason line) + source settings |

The widgets reuse the same exception-only `Price low` / `Price high` pair
(`priceLevelChips.ts`) — a glance surface, not a fourth role.

### Budget tab chart readout (pinned, one interaction grammar)

The Budget chart (Progress + Hourly plan modes) reuses the same pinned-readout primitive. Vocabulary: `Budget` / `Actual` / `Projection` / `Price`. The dashed slate reference stroke is the **budget pace** (the daily budget spread across the day, cumulative) — it is labelled `Budget`, never `Plan` (the weather-blind "Plan" line was retired; "typical usage" lives on the Usage and Weather surfaces, not here). Stroke grammar: solid mint `Actual` up to a visible now dot, dotted ice-blue `Projection` after it, dashed slate `Budget` reference with a `Budget N kWh` pill at its end. Resolvers live in `packages/settings-ui/src/ui/budgetRedesignChartData.ts` + `chartTooltipFormat.ts`.

- Progress (cumulative): primary line uses the cumulative `By HH:MM` form — the value reached at that bucket's END boundary, e.g. `By 14:00` / `Budget 8.4 kWh · Actual 7.9 kWh`, plus `Projection 8.6 kWh` when the projection covers the hour. One-decimal kWh (the Budget hero's precision). The end-of-day column reads `By midnight`, never `By 00:00` — a cumulative "by" anchored at 00:00 misreads as the day's start.
- Hourly plan: primary line uses the hourly range form `13:00–14:00` (closing the day at `23:00–00:00`), e.g. `Budget 0.92 kWh (Managed 0.51 · Background 0.41)` plus `Price 0.84 kr/kWh` and `Actual 0.71 kWh`. Two-decimal per-hour buckets; the split halves inside the parenthetical drop their unit (the leading Budget figure names kWh for the line). The Budget overview managed/background split may use the same `Before solar:` prefix as the Usage readout when solar makes gross split attribution exceed measured net usage.
- Default selection: Today follows the current hour in both modes; yesterday/tomorrow anchor on the end-of-day column in Progress mode (the cumulative chart's answer is how the day ends) and on the day's peak hour in Hourly plan mode.

Deliberate distinction: the Budget readout says `Actual` — it pairs with `Budget` (budget vs. actual) — while the Usage readouts say `Measured` (a bare measurement with no budget to compare against). Both terms stay; do not unify them.

The **Budget-and-Price widget** legend says `Used` for the same measured
consumption — the third registered form (source:
`PLAN_PRICE_WIDGET_LEGEND` in `planPriceWidgetCopy.ts`). A dashboard tile
speaks the plainest register (`Used` beside `Budget` and `Price`), the Budget
tab speaks budget-vs-actual, the Usage tab speaks bare measurement. All three
are deliberate; a reviewer flagging the triple should land here, not rename
one of them.

### Chart colour: neutral semantic palette vs the status-toned hero gauge

Two different colour systems coexist, and mixing them up is a review trap.

- **Neutral semantic palette** — every *data* chart (Usage hourly + daily, Budget progress + hourly, smart-task schedule + trajectory). One hue carries one fixed meaning regardless of value: mint = actual/measured/managed/picked, ice-blue = projection/plan/forecast, slate = background/neutral (with bright-slate dashed = budget reference), amber = warning only, red = error only. The tokens are `pels.chart.*` (see `tokens/component.json`). A projection is ice-blue whether it lands above or below budget; a background segment is slate whether usage is high or low.
- **Status-toned hero gauge** — the Overview `Power now` meter is NOT a semantic-palette chart; it is a *status gauge*. Its fill (and the `Projected this hour` marker) render as **shades of the current live status tone** — success under safe pace, warning above, error over the hard cap (driven by `data-over-safe-pace` / `data-over-hard-cap`). So its managed/background segments are a bright/dim pair of the *good* tone (dim-mint background), not the slate the data charts use, precisely because the whole gauge must flip to amber/warning and red/critical as power crosses the thresholds. This is intentional and governed by `notes/overview-hero-spec.md`; do **not** recolour the hero background segment to slate to "match" the data charts — that would break the flip-to-warning behaviour. Colour still never carries meaning alone here: the status chip and the `Managed X kW · Background Y kW` line carry the split and state in text.

## Solar and export price vocabulary

Solar (prosumer) homes introduce two more price concepts next to the one price
every user already knows. Keep the three names distinct — every priced figure
names exactly one of them:

| Concept | Label | Per-hour field | Notes |
|---|---|---|---|
| The import price you're billed — the only price non-solar users ever see | **Import price** | `total` | Money and receipts stay on this; a receipt must reconcile to the bill. "Import price" is the disambiguator used ONLY on surfaces that also show the Export or Planning price; surfaces that show one price concept (all of today's non-solar UI) keep their established bare labels (`Price`; the Electricity prices card's current-hour price sits under its `Right now` heading — the separate `Current price` row label was dropped as a redundant restatement). |
| What you're paid — or charged — for exported power | **Export price** | `exportPrice` | Signed: negative means you pay to export. The Budget tab's prosumer-gated subline is the canonical rendering: `Export price now: 0.34 kr/kWh` (`composeExportPriceNow` in `packages/shared-domain/src/dailyBudgetHeroStrings.ts`), rendered only when an export price exists for the current hour. |
| The derived price PELS plans against | **Planning price** | `budgetPrice` | Reason line: `using your solar`. Always labelled an estimate, never "the bill". |

Where each price surfaces (byte-identical for a non-prosumer — a hidden export
config or a no-surplus hour means `budgetPrice` is absent/equal to `total`, so
nothing below renders differently from today):

- **Planning price** drives every planning-facing DISPLAY, matching the
  schedulers (which consume `budgetPrice ?? total` since #1808): the smart-task
  schedule chart + its readout + trust caption ("When will it run, and at what
  price?"), the Budget tab's hourly-plan price curve + readout `Price` segment,
  and the `plan_budget` widget's price curve + projected-cost estimate. Each is
  sourced from the persisted `budgetPrice` and falls back to `total` per hour.
  When a hour's planning price actually diverges from import, the surface adds
  the `using your solar` reason line (Budget hourly chart caption; Electricity
  prices "Right now" card, beneath the current-hour price row).
- **Export price** shows on the Budget hero subline (`Export price now:`) and as
  the **Export price** row on the Electricity prices "Right now" card — both
  only when an export price covers the current hour.
- **Import price** (`total`) stays under every money/receipt figure: smart-task
  delivered/planned cost, the Budget chart's Actual / cost cumulative / money
  view, the headline-row estimated-cost figure, and the price-info strings. The
  `plan_budget` widget's projected cost is the sole planning-price money figure,
  and its `Projected …` framing is the estimate label (never "the bill").

"Grid price" was considered and rejected for the import concept: it collides
with the established **Grid tariff** (nettleie) vocabulary on the same
Electricity prices view — for Norwegian users "grid" reads as the nettleie
component, not the all-in billed price.

Shipped solar control labels stay canonical (device-detail surface):

| Control | Label |
|---|---|
| Per-device opt-in to absorb exported solar | **Use solar surplus** |
| The setpoint lift applied while the home exports | **Solar-surplus boost (°C)** |

`feed-in`, `plusskunde`, `self-consume`, `curtail`, and `surplus-absorb` are
internal/market terms — user-facing copy says what happens (e.g. "use your own
power instead of exporting it", "what you're paid for power you send to the
grid").

## Solar vocabulary

Canonical labels for the solar surfaces (Usage-tab Solar card, Overview hero
"Solar now" subline, per-device surplus controls, docs). The price triple
(`Import price` / `Export price` / `Planning price`) is registered in the
"Solar and export price vocabulary" section above; keep the two aligned.

| Concept | Label |
|---|---|
| Live PV production headline | `Solar now` |
| Today's generated energy | `Produced` |
| Today's self-consumed energy (kWh + %) | `Used at home` |
| Today's energy sent to the grid | `Exported` |
| Money the self-consumed kWh would have cost to import | `Grid cost avoided` |
| Money the exported kWh earned (signed) | `Earned from export` |

Fixed line and heading forms:

- Overview hero subline (inventoried in `notes/overview-hero-spec.md`), one
  line, terse noun phrases so it never wraps mid-clause:
  `Solar now 3.2 kW — 1.1 kW at home, 2.1 kW exported`, or
  `Solar now 3.2 kW — all used at home` when export is under 50 W.
- Usage hero reconciliation line, shown only when the Solar card shows
  measured production: `+ 1.5 kWh of your own solar` — it names the energy
  the NET-import headline never saw, so the hero and the card's `Used at
  home` don't read as contradicting numbers on one screen.
- Solar card today block heading: `Today so far` (deliberate reuse of the
  sibling Usage day card's heading). The history block is `Previous days` —
  never "Last 7 days" (the block excludes today, so a window claim reads
  false against the visible rows).
- Previous-days column headers (compact forms, labelled once in a header
  row, never repeated per row as prose): `Day` / `Produced` / `At home` /
  `Exported`.

Rules:

- `Grid cost avoided` and `Earned from export` value **disjoint kWh pools**
  (self-consumed vs exported) — they may appear side by side, but neither may
  ever be summed or relabelled as total "savings". Money figures are always
  prefixed `≈`. The card's money block is today-scoped and says so on the
  labels themselves: `Grid cost avoided today` / `Earned from export today`.
- Partial price coverage appends `· some hours unpriced` INLINE to the money
  value it qualifies (`≈ 12.40 kr · some hours unpriced`) — never as a
  standalone line (a line must not open with a bare middot). Import-price
  coverage qualifies the avoided line; export-price coverage qualifies the
  earned line (independent axes).
- "Used at home" carries the self-consumption percentage inline (`2.9 kWh ·
  69%`) — never a separate jargon row like "self-consumption rate".
- In battery homes `Exported` can honestly exceed `Produced` (stored energy
  discharged to the grid); the card explains this in a supporting note rather
  than clamping the numbers.
- The export-only layout is for Homey-Energy homes whose meter reports export
  without a production device; its note reads `Your meter reports export only
  — production is not measured.` (name the meter, not a "power source" — a
  settings term). Flow-source homes get NO solar surfaces at all: the flow
  power card rejects negative watts, so PELS never observes export there —
  copy and docs must not promise Flow homes an export view.
- Internal terms that stay out of the UI: `generation buckets`, `export
  buckets`, `self-consumption rate` (as a label), `PV`, `feed-in`. Docs
  exceptions: "feed-in" may appear when explaining export pricing, and "PV"
  may appear once as a first-use gloss — "rooftop solar (PV)" — before the
  doc continues with plain "solar".

Established solar labels already shipped elsewhere (do not rename;
`Use solar surplus` / `Solar-surplus boost` are tabled in the export-price
section above):

- `Raised to use your solar power` — the device reason line while the
  surplus boost is engaged.
- `Before solar:` — the prefix on managed/background splits when gross
  attribution exceeds measured net usage (see the Usage/Budget readout
  sections above).

## Multiple meters vocabulary

The Settings → Multiple meters surface manages parts of the home with their
own electricity meter. Canonical labels (source:
`packages/shared-domain/src/homesManagementCopy.ts`, plus
`homeAreaConfigRulesCopy.ts` for the save-refusal lines and the home names
themselves in the `homeNames.ts` leaf beside them; the nav-card/panel
chrome lives in the static settings markup):

| Concept | Label |
|---|---|
| One configured part of the home with its own meter (generic noun) | **meter area** |
| The implicit complement — everything not in a meter area | **Main home** |
| The Settings section / panel title | **Multiple meters** |
| The Main home's own meter picker (existing Limits & safety control) | **Whole-home meter** |
| The shell's global home picker, below the global banners | **Showing** |

### The scope bar's `Showing` label

Once a meter area exists, the shell renders one 48 px row naming which part of
the home the page is about: `Showing` followed by the selected home's name
(`Showing Main home`, `Showing Rental unit`). Source: `HOME_SCOPE_BAR_LABEL` in
`packages/shared-domain/src/homeScopeCopy.ts`; the complement's name is the
single `MAIN_HOME_NAME` export in the same module, which every surface naming
the Main home reads.

It sits **below** the global banners, not directly under the tab strip. Those
banners are whole-home alerts — the simulation banner says "Main home" outright
once areas exist — so a scope naming a meter area immediately above one would
group with it and make a global alert read as scoped. Order: global alerts,
then scope, then page.

The bar is not the only anchor, but the second one is narrow on purpose: a card
that reuses a label the app also shows UNSCOPED elsewhere carries the home too
(`Status now · Rental unit`, via `composeHomeScopedTitle`, so its `Power now`
never reads as the Overview's whole-home `Power now`). Everything else on a
scoped page leaves the naming to the sticky bar.

Settings that are **not** home-scoped must not sit under the bar's claim. On
Limits & safety, `Power source` and `Whole-home meter` are app-global, so they
live in their own card that steps aside in area scope, replaced by
`HOME_LIMITS_GLOBAL_SETTINGS_ELSEWHERE` naming where they went. Conversely the
Main home's own hard-cap hint stops saying "**Your** grid tariff step" once areas
exist and names the Main home instead: with the house split, the Main branch has
to be as explicit about its scope as the area branch already is.

`Showing` is deliberately a plain statement of what is on screen rather than a
settings-field label, so the bar reads the same on a page you are only looking
at and on one you are editing. It replaced the Limits panel's local `Set limits
for` switcher, which could only ever name one page's job. A home with no meter
areas never sees the bar.

The control is a Material **menu button** (a tonal button opening a menu), not
a form field, and `Showing` renders in the supporting type role beside it. The
bar is chrome: a filled-field costume made it the brightest, largest object
above the fold and out-ranked the tab strip, and its full-width stretch both
wasted ~140 px at 480 px and truncated a real Norwegian area name at 320 px. A
content-sized button shows `Leilighet i underetasjen` in full at 320 px, and its
trailing icon is the same Material `arrow_drop_down` glyph the selects on the
same screen render — one caret language, not two.

The bar is **sticky**, so the home stays named at every scroll position. That
is why the panel's own title does NOT repeat it: a scoped page states its home
once, in the chip, untruncated. (Appending `· <area>` to the app bar was tried
and dropped — the app bar is not sticky either, so the suffix bought ~51 px of
scroll at 320 px and nothing at all at 480 px, while at rest it put an
untruncated name directly above a truncated copy of itself.)

The bar renders **only on pages whose content is already resolved against the
selected home**. A bar naming a home above whole-home figures would be a claim
the page cannot pay, so a surface earns the bar in the same change that teaches
it the scope, never before.

### Per-home Usage honest states

When the Usage tab's selected part of the home cannot be served (a held or
just-removed area, or a runtime still wiring up), the data sections hide
behind one notice card instead of rendering zeros — a fabricated
`0.0 kWh today` would read as a measurement. Canonical copy (source:
`HOME_SCOPE_USAGE_UNAVAILABLE_*` in `homeScopeCopy.ts`): headline
`Usage couldn’t be read`, body `PELS couldn’t read usage for this part of the
home right now. Check back in a moment, or pick another part of the home
above.` A served meter area with nothing recorded yet is a different, healthy
state: it keeps the normal empty surfaces, but the awaiting-samples line reads
`No usage recorded for this part of the home yet.`
(`formatPowerUsageEmptyForMeterArea` in `powerUsageStrings.ts`) — never the
Main home's `Set up the Report power usage Flow action` remedy, which is not
an area's setup path. The daily-history budget overlay and its
within/over-budget readout context render in Main scope only: the daily budget
is a Main-home constraint (locked decision 3), so painting it on an area's
history would claim the area is held to it.

### Per-home Overview honest states

The Overview follows the shown home the same way Usage does. When the selected
part of the home cannot be served (`homeScope: unavailable`), the hero and
device cards hide behind one notice card instead of rendering fabricated
numbers — a `0.0 kW` hero would answer "am I OK right now?" with a measurement
nobody took. Canonical copy (source: `HOME_SCOPE_OVERVIEW_UNAVAILABLE_*` in
`homeScopeCopy.ts`): headline `Status couldn’t be read`, body `PELS couldn’t
read the current status for this part of the home right now. Check back in a
moment, or pick another part of the home above.`

Under a meter area the Main-only elements are OMITTED as not-applicable, never
zeroed: the smart-task row (smart tasks are a Main-home feature) and every
daily-budget-derived hero element (the daily budget is a Main-home constraint,
locked decision 3 — an area's plan meta simply carries no daily allocation, so
`Budget this hour` there is always the area's own capacity allocation). The
hero's `Simulation mode` chip and hypothetical voice follow the area's OWN
control flag (`capacity_dry_run:<id>`), never Main's.

### Home badges and the Modes filter

Once a meter area is in use, every row in the Devices list carries a quiet
outline chip naming the home it belongs to: the area's own name as the owner
authored it, or **Main home** for the implicit complement. A single-home
install renders no badge.

The Devices badge is a label, never a filter. Chips stay short, so the "why it
matters" sentence lives in the tooltip
(`This device belongs to “Rental unit” and counts against that meter.`), which
doubles as the full-name reveal when a long area name is truncated. Source:
`composeHomeBadgeLabel` / `composeHomeBadgeTooltip` in
`packages/shared-domain/src/homesManagementCopy.ts`.

Modes is filtered instead: the shell's **Showing** picker chooses one home, and
the list contains only managed devices assigned to it. Do not repeat a home
badge on those rows—the picker already supplies that context.

Internal terms that stay internal: `sub-home`, `homeId`, `membership`,
`scope` (as a word in copy), `zone rule`, `pin`, `suspect`/`degraded` (store
classifications). Copy says what happens ("Its devices move back to the Main
home", "your settings couldn't be read"), never the resolver or store
vocabulary.

The same two names reach Flow. Both hard-cap triggers — `Hard cap breach imminent
— manual action needed` and its sustained sibling `Hard cap breach imminent for at
least...` — carry a `Home` tag naming the part of the home that fired it:

| Concept | Label |
|---|---|
| Flow tag naming the part of the home an alert came from | **Home** |
| Its value for the implicit complement | **Main home** |
| Its value for a configured area | the area's own name |
| Its value when a saved area's name is blank | **Meter area** |

The tag is the home's *name*, not its id, so a Flow names a home the way the
owner does. A saved name is untrusted, so the blank case has ONE answer for
every surface: `resolveHomeAreaDisplayName` in `homeNames.ts`, called
by both the Multiple meters list and the runtime that fills the tag. Constants:
`HOMES_MAIN_HOME_NAME` and `HOMES_UNNAMED_AREA_NAME`, same module.

The tag title stays the bare `Home`. It reads as a sentence in a notification
(`Hard cap breach in [Home]`) and matches the settings vocabulary, since its
values are `Main home` and area names. `Part of home` was considered and
rejected: it is wordier everywhere to defuse a collision that does not happen,
because `Home` as a stock operating-mode name appears as a dropdown *value* on
other cards, never as a tag title.
### Simulation posture across homes

Main's simulation flag and each active meter area's control flag are
independent, so the global surfaces render the AGGREGATE posture — all live /
all simulating / mixed (source: `resolveSimulationPosture` and
`resolveSimulationBannerContent` in
`packages/shared-domain/src/simulationPosture.ts`; chip labels in
`settingsHubChips.ts` beside them):

| State | Global simulation banner | Settings hub Simulation chip |
|---|---|---|
| Simulating, no meter areas | `Simulation on — devices stay as-is` | `On` |
| Main simulating, areas exist | `Main home simulation on — Main home devices stay as-is` (never appends the areas — the button acts on Main) | `On` while the areas simulate too, else `Partly on` |
| Main live, one area simulating | `PELS is only simulating “<area>”. Turn on control under Limits & safety.` — no button: each area's control lives on its Limits & safety page | `Partly on` |
| Main live, several areas simulating | `PELS is only simulating N meter areas. Turn on control under Limits & safety.` | `Partly on` |
| Everything live | hidden | hidden |

Held pre-GA areas never enter the posture: their devices still belong to the
Main home, so their flags say nothing about what PELS controls.

### Beta notice

The Multiple meters page leads with `HOMES_BETA_NOTICE`
(`homesManagementCopy.ts`): `Meter areas are new. They work as intended, but
some PELS features don’t cover them yet. Report anything unexpected and it
gets fixed fast.` Confident and factual — never reworded into a hedge about
whether the feature works, and never an em-dashed aside.

### Honest scope lines and not-supported-yet states

Surfaces that do NOT follow the `Showing` picker say so once meter areas are
**in use** (an active roster with `runtimeActive` — a held pre-GA config or a
single-home install renders none of these). Canonical copy lives in
`homeScopeCopy.ts`; every line says what happens and names the Main home with
the one registered constant:

| Surface | Copy |
|---|---|
| Budget tab (scope line under the header) | `Your daily budget covers the Main home. Each meter area runs on its own cap and isn’t counted here.` |
| Smart tasks list (info notice under the hero) | `Smart tasks run on Main home devices. A device in a meter area can’t have a smart task yet.` |
| Device-detail diagnostics, area device | `Not measured for meter areas yet. PELS limits and resumes this device normally, but doesn’t record diagnostics for it yet.` |
| Device-detail activity log, area device | `Not recorded for meter areas yet. PELS limits and resumes this device normally, but doesn’t keep an activity log for it yet.` |
| Simulation-mode settings page (note under the switch) | `This switch covers the Main home. Each meter area has its own “Control devices in this area” switch, under Limits & safety.` |

Rules pinned by these lines:

- The Budget line says **Main home**, never "whole home" — the daily budget
  binds Main's tracker and meter (locked decision 3).
- The device-detail lines lead with the honest gap ("Not measured/recorded …
  yet") and then say control is unaffected — an empty diagnostics payload that
  reads as a healthy device is exactly what they exist to prevent (locked
  decision 5). The fetch is skipped: the Main-home payload cannot answer for
  an area device.
- The Simulation-page note composes the toggle name from
  `HOME_LIMITS_CONTROL_LABEL`, so the pointer cannot drift from the real
  control it names.

### Save refusals (`homeAreaConfigRulesCopy.ts`)

Saving a meter area can be refused, and each refusal names one next step
rather than a generic failure. Three of them pin vocabulary:

- **`Main home` is a RESERVED area name.** An area may not be called it, in any
  case. The name is the home selector's label and the `capacity_shortfall` Flow
  token's value, so an area wearing the complement's name would stop both from
  telling the two apart. The rule reads the label from
  `HOME_LIMITS_MAIN_HOME_OPTION`, so **renaming the Main home renames what is
  reserved** — deliberate, but check the refusal copy still reads correctly.
- **Two caps are user-visible:** at most **8 meter areas** and at most **40
  characters** in an area name. Both refusals state the number and the way out.
- **The whole-home-meter requirement runs both directions** (saving an area,
  and choosing Automatic while areas run) and always names the same control:
  **Whole-home meter**, under **Limits & safety**. Name it as a setting to
  change, never as an option to pick — the picker's options are device names
  plus `Automatic`.
- **The Homey Energy requirement also runs both directions** (saving an area
  on the Flow source, and switching the source to Flow while areas run), and
  each side names the OTHER side's control: the area save points at
  **Power source**, under **Limits & safety**; the source switch says to
  remove the areas under **Multiple meters**. The switch-side remedy is
  removal on purpose — deleting an area works on any source, so the
  instruction can always be followed. Internal terms (`mutual exclusion`,
  `homey_energy_required`) stay internal.
- **An id-less whole-home aggregate gets the honest-state refusal, not the
  remedy.** Some Homey setups read the whole home through an aggregate that
  carries no device id, so the Whole-home meter picker has nothing to offer
  and the requirement above can never be satisfied there. The copy
  (`HOMES_METER_UNNAMEABLE`) names the situation — "Your whole-home meter
  doesn't report a device id" — and says "Not supported for meter areas yet";
  it never points at the picker. Internal terms (`cumulative item`,
  `aggregate`, `arrangement`) stay internal.

## Mode label

With one home, the Settings page renders one selector labelled `Current mode`.
With meter areas, the card is labelled `Current modes` and renders one selector
for **Main home** and each active area. Each selector uses that home's
independent catalog. Selected options remain untranslated user-authored names
(Home, Away, Night, or `Hjemme`).

Every newly configured meter area starts with its own `Home` mode. While that
initial catalog is being committed, show the usable `Home` selector rather
than an unavailable message. Reserve `Modes couldn’t be loaded.` for a
partial, malformed, or failed catalog read.

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

## Hard cap is an hourly ceiling

The hard cap is the user's grid tariff step (effekttrinn): an **hourly-average**
energy ceiling (the Norwegian kapasitetsledd step is the mean of the top-3
whole-clock-hour kWh on three different days). Two rules follow:

1. **Instantaneous kW above the cap is never presented as a breach.** A
   momentary draw above the cap has zero tariff consequence and no control
   path treats it as a breach to correct directly (it only escalates
   plan-rebuild urgency and shortfall-detection timing — see
   `lib/plan/rebuildScheduler`); the dynamic safe pace legitimately exceeds
   the cap late in an under-used hour. Every over-cap alarm (`Above hard cap` chip,
   widget danger state, flow trigger) keys off the hour's **trajectory** —
   projected hourly energy past the cap's kWh. Never pair the cap with
   "breaker trips" in copy: an hourly-average ceiling cannot prevent them (the
   main fuse is a separate, much higher physical limit PELS does not manage).
2. **Not a tuning knob.** UI copy must not suggest users raise the hard cap to
   relieve pressure. The recommended remedy when the daily budget runs out
   before a deadline is to **lower the daily budget** so future days reserve
   available power earlier — see `cannotMeetDailyBudgetExhausted` copy in
   `deadlineLabels.ts`.

## EV charger card states

What an EV charger's card may say about *why* it is idle is governed by
`notes/ev-charger-state-copy.md` — the matrix of the charger's command
capability, the charger's observed state, and the associated car's own state,
with the copy each combination earns. The rule it exists to enforce: **never
name a cause PELS cannot observe.** A plugged-in idle charger says `Waiting for
car` when the charger itself is switched on — with or without an associated car,
and whether or not PELS is the one controlling it. Commanded off it is
`Not charging` and nothing more.
