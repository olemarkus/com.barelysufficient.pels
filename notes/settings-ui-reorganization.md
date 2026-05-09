# Settings UI Reorganization

This note captures the target product direction for reorganizing the PELS Settings UI.
It is a planning note, not a description of the current implementation.

The work should land as one cohesive redesign program split across multiple reviewable PRs.
This note is the source of truth for ownership boundaries while those PRs are built.

## Goal

Create a narrow-viewport Homey UI that feels like a product, not an engineering control panel.

The UI should make it obvious:

- what is happening right now
- whether today is within the plan
- what PELS will do next
- how to change the plan safely
- what happened historically
- where device behavior and rare settings are configured

Information appears where the user needs to understand it. Configuration lives where the user
would naturally expect to change it. The same editable setting should not appear in multiple
places.

Summary information may be repeated across pages. Editable controls should have one canonical
home.

## Top-Level Navigation Target

Target top-level destinations:

- `Overview`
- `Budget`
- `Usage`
- `Settings`

This is a navigation simplification, not a change in ownership semantics.

The top level should answer:

| Question | Destination |
|---|---|
| What is happening now? | `Overview` |
| What is the plan? | `Budget` |
| What happened historically? | `Usage` |
| How is PELS configured? | `Settings` |

Do not rename `Overview` to `Today`. The page is about current operating state, not primarily a
calendar day.

Do not rename `Advanced` to `Settings`. `Advanced` should remain a specific area for rare,
risky, diagnostic, or experimental controls. `Settings` is only the navigation container that
contains configuration areas.

## Settings Structure

`Settings` should be presented as a card/list navigation page, not nested horizontal tabs.
This fits the Homey narrow viewport better than a second tab row.

Recommended order:

- `Limits & safety`
- `Devices`
- `Modes`
- `Electricity prices`
- `Price-aware devices`
- `Simulation mode`
- `Advanced`

Each row/card opens a detail page.

Example:

```text
Settings

[ Limits & safety ]
Hard cap, safety margin, power source

[ Devices ]
Managed devices and per-device behavior

[ Modes ]
Mode behavior and priorities

[ Electricity prices ]
Source, tariffs, cheap and expensive hours

[ Price-aware devices ]
Devices that respond to cheap and expensive hours

[ Simulation mode ]
Test behavior without controlling devices

[ Advanced ]
Diagnostics, cleanup, logs, experiments
```

## Ownership Boundaries

The strict boundary to protect:

```text
Overview = understand now.
Budget = plan and preview daily energy.
Usage = learn from history.
Settings = reach configuration areas.
```

Inside `Settings`:

```text
Limits & safety = global safety/source controls.
Devices = configure what each device may do.
Modes = configure mode behavior.
Electricity prices = configure price source, tariffs, and cheap/expensive thresholds.
Price-aware devices = enable/disable price response, edit per-device cheap-hour boost
  and expensive-hour reduction in bulk.
Simulation mode = test behavior without controlling devices.
Advanced = diagnostics, cleanup, logs, experiments, rare recovery tools.
```

`Settings` is not a dumping ground and does not own all settings directly. It routes users to
the correct owner.

## Overview

`Overview` is the at-a-glance current-state page.

It answers:

- is PELS okay right now?
- is the current hour under control?
- is PELS taking action?
- which devices are involved?
- is the day still broadly on plan?

Overview may show compact summaries from Budget, Devices, Modes, and Price when those summaries
explain current operation. It should not own their editable controls.

Overview should not contain:

- full budget configuration
- price setup
- historical chart deep dives
- debug logging
- device cleanup
- raw logs

## Budget

`Budget` is the daily planning surface.

It answers:

- what is the current daily plan?
- is the selected day within the plan?
- how do I adjust the daily plan?
- what changes before I apply those adjustments?
- how do prices affect the plan, when price data is available?

Recommended local Budget views:

- `Plan`
- `Adjust`
- temporary `Review changes`

Price is not a Budget sub-page in the target navigation because price can be used without daily
budget. Budget may still show price context when price affects the plan.

Deadline objectives are per-device readiness plans, not daily-budget settings. Their detailed plan
view should live with the device that owns the objective. Budget may later summarize aggregate
impact, such as EV deadline charging reserving cheap hours tonight, but should not become the
primary editor or explanation surface for a specific charger's target.

### Budget > Plan

Default Budget view.

Show:

- day selector: `Yesterday`, `Today`, `Tomorrow`
- current budget status for the selected day
- selected-day metrics
- chart card with local views: `Progress` and `Hourly plan`
- plain next-action sentence
- action to adjust the daily budget

`Progress` answers whether the selected day is on track. Use cumulative actual use, cumulative
plan/budget, and a projected end marker or ghost line for today only when that projection is
reliable.

`Hourly plan` answers how the selected day's budget or forecast is distributed across the day.
Use per-hour planned budget / expected usage, optional actuals for elapsed hours, and subtle price
background context when reliable price data exists.

Do not make actual usage vs price the primary Budget chart. Actual usage includes background load
and manual behavior that PELS cannot control, so that analysis belongs in `Usage` if it is ever
shown.

Avoid dual-axis charts. Do not use one axis for kWh and another for price on the narrow Homey
viewport.

The next-action sentence should be framed as plan impact, not a duplicate of the full live
Overview story.

Examples:

```text
PELS expects to stay within today's budget.
```

```text
Today's budget is tight. Review the daily budget or reduce flexible usage.
```

```text
Cheaper-hour planning needs price data.
```

#### Day-Specific Metric Rules

Do not reuse the same labels for `Yesterday`, `Today`, and `Tomorrow`.

For `Yesterday`, use result-oriented labels:

- `Result`
- `Used`
- `Budget`
- `Difference`
- `Cost` only when complete enough to trust

For `Today`, use live planning labels:

- `Remaining`
- `Projected use`
- `Budget`
- `Cost estimate` only when reliable

For `Tomorrow`, use planning labels:

- `Planned budget`
- `Expected flexible use`
- `Price effect` when price data exists
- `Cost estimate` only when reliable

Do not show `Remaining` for `Tomorrow`.

### Budget > Adjust

Owns normal daily-planning controls:

- enable daily budget
- daily budget
- use cheaper hours, when this specifically means price-aware budget planning
- background usage reserve
- managed device flexibility
- future daily-budget auto-adjust controls, when implemented

Planning behavior should be collapsed by default with a useful summary, for example:

```text
Planning behavior
Conservative reserve - Low flexibility
```

Expanded fields:

- `Background usage reserve`
- `Managed device flexibility`

The full `Preview changes` / `Apply changes` / `Discard` workflow belongs to `Budget > Review
Changes`. Do not show those actions in an unfinished new-UI Adjust surface.

`Budget > Adjust` may show the current hard cap and safety margin when explaining the plan, but
editing the global safety/source controls belongs in `Settings > Limits & safety`.

### Budget > Review Changes

Temporary view shown after `Preview changes`.

Use:

- `DailyBudgetModelPreviewResponse.active`
- `DailyBudgetModelPreviewResponse.candidate`

Use the Homey webview layout at 320-480px:

- stacked layout
- compact comparison table
- one overlay chart
- visible `Apply changes` and `Discard preview` actions

Do not design the review flow around side-by-side cards. A wider browser can add breathing room,
but it should keep the same single-column information order unless a later navigation/layout pass
proves a wider treatment is useful outside Homey.

## Usage

`Usage` is historical only.

It answers:

- how much energy has been used?
- what patterns exist?
- when do peaks usually happen?
- how does today compare to recent history?

Usage should not contain:

- budget configuration
- price configuration
- device behavior settings
- live control decisions
- debug logging

Recommended order:

1. `Today so far`
2. `Last 14 days`
3. `Typical day`
4. `Detailed hourly view`

`Detailed hourly view` should be lower priority or collapsed by default.

Data-management actions do not belong to Usage. Usage may link to
`Settings > Advanced > Data management`, but destructive or maintenance actions such as
`Reset usage statistics` should live there.

## Limits & Safety

`Settings > Limits & safety` owns global safety/source controls:

- hard cap
- safety margin
- power source

Budget may show these values and explain their effect, but editing them here keeps Budget from
becoming a generic settings dump.

Use the product mental model consistently:

- `Safe pace` = dynamic planning pace to stay on track
- `Hard cap` = configured upper boundary PELS tries not to exceed
- `Safety margin` = buffer below the configured capacity/tariff limit

Do not use `power limit` casually for threshold labels because it blurs the distinction between
`Safe pace` and `Hard cap`.

## Devices

`Settings > Devices` owns per-device settings and behavior.

Device list and detail views should answer:

- is this device managed?
- what is its current state?
- how much power is it using?
- is PELS controlling or limiting it?
- what device-specific behavior is allowed?

Device detail owns:

- managed by PELS
- priority
- allowed control behavior
- power behavior
- per-device price behavior (also editable in bulk on `Settings > Price-aware devices`)
- device-specific diagnostics

Budget may summarize device behavior, but most editing routes to device detail. Per-device price
behavior is the explicit exception: it lives in two equivalent places, the bulk
`Settings > Price-aware devices` page and the per-device detail panel, both writing to the same
setting.

## Modes

`Settings > Modes` owns mode configuration.

Overview may show the active mode and provide a fast mode switch. Mode configuration belongs
under `Settings > Modes`.

The Overview fast switch changes only the active mode. It must use API/bootstrap state for the
current active mode, not direct settings reads, so the displayed mode stays live when another
client or Flow changes it.

## Electricity prices

`Settings > Electricity prices` owns global electricity price setup and price-feature status.

Price can be useful without daily budget enabled, so it must not be collapsed into Budget.

`Electricity prices` owns:

- price source
- price area
- tariffs and surcharge
- cheap/expensive thresholds
- current price status
- selected-day price view
- price data reliability and caveats

Budget may show:

- estimated cost
- price shading on budget charts
- how price changes the daily plan
- missing-price warnings only when Budget needs price data

## Price-aware devices

`Settings > Price-aware devices` is the bulk surface for editing per-device cheap-hour boost
and expensive-hour reduction. Splitting this out from `Electricity prices` keeps the source/rule
configuration page calm, and lets users tune many devices on one page without drilling into each
device's detail panel.

`Price-aware devices` owns:

- the global `Respond to prices` switch
- per-device `Cheap-hour boost` (°C, magnitude, applied during cheap hours)
- per-device `Expensive-hour reduction` (°C, magnitude, applied during expensive hours)

The settings UI persists the deltas as signed numbers (`cheapDelta`, `-expensiveDelta`) for
backwards compatibility with existing data. The view layer adapts those signed values to the
positive-magnitude UX boundary.

Device detail still exposes the same controls for one device at a time as a secondary editor.
Both surfaces write to the same `price_optimization_settings` setting key, so changes from one
surface are reflected on the other.

`Electricity prices` may summarize affected devices, but the editing interaction lives on
`Price-aware devices` (or, secondarily, on the device detail panel).

## Simulation Mode

`Settings > Simulation mode` owns the app-wide setting that tests behavior without controlling
devices.

Use `Simulation mode` in normal UI. Avoid `dry run` outside diagnostics or raw logs.

Overview may show a compact `Simulation mode` chip when this setting affects current behavior.

## Advanced

`Settings > Advanced` should contain only things most users should not touch:

- experimental features
- diagnostics
- debug logging
- device cleanup
- device log, using the shared device overview formatter so wording matches backend overview logs
- data management, including usage-stat reset and other destructive maintenance actions
- rare recovery tools

Move normal planning controls out of Advanced:

- background usage reserve
- managed device flexibility
- daily budget tuning

Advanced should be collapsed and calm by default. Debug checklist-style controls should not be
first-screen content.

## Material Design And Narrow Viewport Rules

Primary target: 320-480px Homey webview. Treat wider browser widths as preview convenience only,
not as a design target.

Use Material Design as the interaction and layout language, not as a requirement to adopt MUI.
The Settings UI should stay Preact plus PELS CSS tokens, with ECharts isolated behind focused
chart wrappers for the Budget progress and hourly-plan charts.

Use `@material/web` whenever it provides a component that matches the interaction semantics and
works cleanly in the Homey webview. Register Material Web components centrally and expose shared
wrappers/helpers where Preact needs them. If Material Web does not provide the right semantic fit,
create or reuse one shared PELS primitive built from the existing design tokens. Do not add
page-local custom chips, cards, buttons, or segmented controls that invent a new visual language.

Use:

- stacked cards
- single-column layout
- segmented buttons for local choices such as `Plan | Adjust`, day selection, and chart view
- compact comparison tables
- short chip labels
- reduced chart axis labels
- expandable deep-dive sections
- sticky action area for review/apply flows where appropriate

Avoid:

- side-by-side cards as a required interaction
- dense tables
- multi-column forms
- tiny legends
- long warning banners on every page
- nested horizontal tabs inside Settings

Use chips for short status only. Long explanations belong in body text.

Good chips:

- `Within budget`
- `Tight`
- `Over budget`
- `Needs prices`
- `Simulation mode`
- `Configured`

Normal-state chips are optional. On answer-first surfaces such as `Budget > Plan`, the
hero answer and consequence sentence may carry the normal state while chips are reserved
for exceptions like `Tight`, `Over budget`, or `No plan`.

## Terminology

Use:

- `Overview`
- `Budget`
- `Usage`
- `Settings`
- `Advanced`
- `Safe pace`
- `Hard cap`
- `Safety margin`
- `Daily budget`
- `Background usage reserve`
- `Managed device flexibility`
- `Cheap-hour boost`
- `Expensive-hour reduction`
- `Cheaper-hour planning`
- `Simulation mode`
- `Within budget`
- `Tight`
- `Over budget`

Avoid in normal UI:

- `Soft margin`
- `Soft limit`
- `Unmanaged usage`
- `Delta`
- `Cheap delta`
- `Expensive delta`
- `Headroom`
- `Shed`
- `Restore`
- `Dry run`

Technical terms may still appear in diagnostics or raw logs.

## Implementation Program

This direction should be delivered as a stacked series of focused PRs, not one large UI diff.

Suggested sequence:

1. Product note and terminology updates.
2. Navigation shell: top-level `Overview`, `Budget`, `Usage`, `Settings`; Settings card/list.
3. Settings sections: `Limits & safety`, `Devices`, `Modes`, `Electricity prices`,
   `Price-aware devices`, `Simulation mode`, `Advanced`.
4. Budget `Plan` and `Adjust` views.
5. Budget `Review changes` comparison flow.
6. Usage history reorganization and data-management cleanup.
7. Device detail ownership cleanup for per-device price behavior.
8. Final responsive polish and Playwright visual checks.

Each implementation PR should keep editable controls in their canonical owner and avoid
temporarily duplicating settings across pages unless the duplicate is read-only summary context.

## Required Verification For Implementation PRs

For UI implementation PRs, run the relevant subset of:

```bash
npm --workspace @pels/settings-ui run build
npm --workspace @pels/settings-ui run lint
npm --workspace @pels/settings-ui run test
npm --workspace @pels/settings-ui run test:e2e
npm run build:settings
homey app validate
```

Use Playwright visual checks at the Homey-relevant widths:

- 320px
- 480px

At 320px, explicitly check that there is no horizontal overflow and that sticky review/apply
actions remain reachable.

An optional wider-browser sanity check is fine, but it must not introduce requirements that depend
on more than the Homey webview width. The 320-480px experience is the product baseline.
