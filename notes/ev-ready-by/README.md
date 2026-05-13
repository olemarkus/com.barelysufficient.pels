# EV Ready By

EV Ready By is the user-facing name for an EV-charging deadline feature: a user sets when the car
must be ready and how much charge it needs, PELS estimates required charging time, plans the best
available charging window respecting prices and capacity, controls the charger, and reports
whether the plan is trustworthy.

This note collects the product framing, the gap between the current shipped state and a
releasable feature, and the prioritized task list for closing the gap. Cross-references:

- `notes/deferred-load-objectives/README.md` — technical model for deadline-aware loads. EV Ready
  By is the user-facing surface for the `ev_soc` slice of that model.
- `notes/persisted-settings-state.md` — shared persistence helper that new EV-related settings
  stores must align with.
- `notes/ui-terminology.md` — user-facing vocabulary rules.

## Product Goal

PELS should:

- Accept "ready by HH:mm" and a target (battery percent or added kWh) per charger.
- Make the kWh → hours conversion visible: required energy, planning speed, estimated duration.
- Plan price-aware charging windows while respecting house capacity.
- Control the charger during planned hours.
- Warn when the plan is not achievable or when observed charging is slower than planned.

The value is **trustworthy readiness**, not "schedule cheap hours". Cheap-hour selection is a
means; deadline confidence is the user outcome.

## Customer Problem

Users want their EV ready before a specific time. They commonly know current battery percent,
target percent, battery size, ready-by time, and approximate charging speed — but they do not
trust hidden conversions from "I need X kWh" to "charge for Y hours". When that conversion is
wrong, the deadline slips and the user wakes up to an under-charged car.

PELS already has the SoC observation, learned charging profile, horizon planner, and active-plan
recorder needed to make this conversion visible and correct. What is missing is the runtime that
actually starts the charger when the plan says so, plus the feature surfaces that make the
estimate trustworthy.

## Product Principles

- **Flow cards are the input surface.** Users create deadlines via flow cards today and will
  continue to. Per-charger automation (P3) is quality-of-life follow-up, not the v1 path.
- **No hidden speed assumption.** Required energy, planning speed (kW), and estimated duration
  are visible side by side. The speed source (learned, bootstrap, manual, conservative) is
  labeled.
- **No surface that does not act.** A flow card or settings surface that appears to schedule
  charging must actually issue commands when the plan says so.
- **PELS exposes text via tokens, not push.** Notification delivery is the user's flow; PELS
  supplies trigger tokens with enough content to compose a useful message without scripting.

## Current Baseline

The deferred-objective subsystem already ships enough infrastructure to deliver the temperature
deadline feature end-to-end and to display EV deadline plans without actuating them:

- EV SoC observation with session validity (`lib/core/deviceStateOfCharge.ts`): fresh / stale
  status, session start on plug-in, invalidation on plug-out.
- Per-device learned profile (`lib/core/objectiveProfiles.ts`) storing `kwhPerUnit` (kWh per 1%)
  and `unitPerHour` (%/hour) with EMA confidence.
- Bootstrap kWh-per-percent fallback in
  `packages/shared-domain/src/objectiveProfileBootstrap.ts`: cold-start EV plans produce a useful
  allocation immediately and refine when learning matures; the active-plan recorder emits a
  `rate_refined` revision when the source flips bootstrap → learned.
- Versioned objective settings (`packages/contracts/src/deferredObjectiveSettings.ts`) with
  `kind: 'ev_soc' | 'temperature'`, `enforcement: 'soft' | 'hard'`, keyed per device, absolute
  `deadlineAtMs`.
- Public flow cards in `flowCards/deadlineObjectiveCards.ts`: `set_ev_charge_deadline`,
  `set_temperature_deadline`, `clear_deadline`; conditions `deadline_status_is`,
  `has_active_deadline`; triggers `deadline_status_changed`, `deadline_missed`.
- Horizon planner (`lib/plan/deferredObjectives/horizonPlanner.ts`) selecting budget-friendly
  hours before the deadline, price-gated.
- Diagnostics bridge (`lib/plan/deferredObjectives/diagnosticsBridge.ts`) emitting
  `DeferredObjectiveDiagnostic` per cycle.
- Active-plan recorder (`lib/plan/deferredObjectives/activePlanRecorder.ts`) persisting current
  allocation with revision triggers (`flow_card`, `prices_arrived`, `objective_changed`,
  `prices_revised`, `rate_refined`).
- Plan history (`lib/plan/deferredObjectives/planHistory.ts`) capturing per-deadline outcomes
  (`met` / `missed` / `abandoned` / `replaced`).
- Per-device-per-step power calibration (`lib/observer/devicePowerCalibration.ts`,
  `lib/plan/deferredObjectives/objectiveStepPower.ts`) with EMA learning, conservative-high and
  conservative-low query primitives, already wired into stepped-load deferred objectives.
- Smart tasks UI surfaces: list and per-device deadline-plan and history pages
  (`packages/settings-ui/src/ui/deadlinePlan.ts`, `deadlinesList.ts`).
- Temperature admission wired in `lib/plan/deferredObjectives/admission.ts`: cap-off devices made
  visible during planned hours, kept idle outside, setpoint lifted to deadline target.

## Where the broken surface is today

One user-facing flow surface is landed but functionally broken — this is the remaining P0 release
blocker:

- The `set_ev_charge_deadline` flow card is registered and exposed to users
  (`.homeycompose/flow/actions/set_ev_charge_deadline.json`: "Charge [[device]] to
  [[target_percent]] % by [[ready_by]]"). Firing it succeeds and writes a plan, but no command
  reaches the charger: `buildDeferredTargetOverrides`
  (`lib/plan/deferredObjectives/admission.ts:80-92`) skips EV, and the binary restore lane only
  fires for `currentOn === false` (`lib/executor/binaryExecutor.ts:56`) while
  `plugged_in_paused` reports `currentOn: true` (`lib/core/deviceManagerControl.ts:51-60`). The
  test at `test/evDevices.integration.test.ts:292` codifies the "no command for paused EV"
  outcome.

Beyond the P0 fixes, the EV release additionally needs the P1 trust-surface follow-ups — visible
state on the device card, visible planning math on the deadline-plan page. Those are the first
support-cost gaps that hit users the moment P0 lands. P2 items (kWh target, hard enforcement,
observability) are stand-alone feature work that broadens coverage and adds user agency but is
not required for the v1 release.

## Gap Plan

### P0 — Release blocker (broken in landed feature)

**P0.1 EV admission and resume / pause actuation**.

Add EV-aware executor intent (`ev_resume` / `ev_pause`) emitted when the admission decision flips
between planned and idle, with a capability dispatch in `lib/core/` that issues the charger's
native resume / pause command. Honor existing cooldowns and the stale-power failsafe. Replace
the `test/evDevices.integration.test.ts:292` "no command for paused EV" assertion with the new
expected behavior.

Minimum acceptable completion: a planned EV bucket resumes / starts a paused plugged-in charger;
an idle bucket pauses / limits it through the normal control path; capacity safety is retained;
integration tests cover both the resume and idle transitions.

Files: `lib/plan/deferredObjectives/admission.ts`, `lib/executor/` (new ev-resume lane),
`lib/core/deviceManagerControl.ts`, `test/evDevices.integration.test.ts`.

### P1 — Trust-surface follow-ups (support-cost gaps right after P0)

These are not P0 blockers, but they are the first support-facing clarity gaps once EV deadlines
actually control charging. They should ship in the same release window as P0 when feasible.

**P1.1 EV deadline device-card visible state.**

`packages/settings-ui/src/ui/views/PlanDeviceCards.tsx:63` shows only the Smart task chip.
Surface a next-planned-start line ("Waiting · charging starts 01:00"), an active-charging finish
line ("Charging · planned finish 05:30"), and a plug-out paused line ("Charging plan paused —
car unplugged"). Pull start / finish from the active-plan recorder's `latest.hours`; pull the
paused state from the existing `objective_invalid_session` reason emitted by
`resolveEvObjectiveProgress` (`lib/plan/deferredObjectives/diagnosticsBridge.ts:380-402`),
which fires when the observation layer reports `stateOfCharge.status === 'invalid'`.

Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
`lib/plan/deferredObjectives/diagnosticsBridge.ts`, `packages/contracts/src/` (diagnostic
reason additions if the reason needs to be public), device-card tests.

**P1.2 Visible speed and estimated duration in the deadline-plan page.**

`packages/settings-ui/src/ui/deadlinePlan.ts:153,164` shows kWh and hours-until-deadline. Add
"Planning speed: X.X kW" and "Estimated time: Yh Zm" near the energy line. Tag with a speed-mode
badge ("Auto" or "Learning…" today; "Manual" / "Conservative" once P3 lands). Compute kW via a
new `resolvePlanningKw` selector that falls back to the calibration view built from
`lib/observer/devicePowerCalibration.ts`. EVs need either a synthetic 1-step profile or an
EV-specific branch in `buildStepPowerCalibrationView` (`lib/app/appInit.ts:468-487`) so the
existing `resolveStepDeliveryUsefulKw` helper serves Automatic mode without code duplication.

Files: `packages/settings-ui/src/ui/deadlinePlan.ts`, `lib/app/appInit.ts`,
`lib/plan/deferredObjectives/diagnosticsBridge.ts`, calibration view tests.

### P2 — Ready-to-go feature specs

**P2.1 EV deadline kWh target mode.**

The kWh target is the only EV deadline path that does not depend on SoC observation at all —
no native capability, no session validity, no freshness window. Stand-alone feature; ships
independently of the v1 release.

`packages/contracts/src/deferredObjectiveSettings.ts:14-16` accepts only `targetPercent` for
the `ev_soc` variant today, and the flow-card JSON exposes only `target_percent`.
Discriminate the contract variant to accept either `targetPercent` or `targetEnergyKwh`. Add a
`target_kwh` arg path to `set_ev_charge_deadline` (either via additional optional args or a
sibling action — pick whichever keeps validation clean). The diagnostics bridge computes
`energyNeededKwh` directly from `targetEnergyKwh` when present, bypassing the
`kWhPerUnit × (target% − current%)` math. Validates with both target shapes round-tripping
through the active-plan recorder.

Files: `packages/contracts/src/deferredObjectiveSettings.ts`,
`flowCards/deadlineObjectiveCards.ts`, `lib/plan/deferredObjectives/diagnosticsBridge.ts`,
`.homeycompose/flow/actions/set_ev_charge_deadline.json`, contract and bridge tests.

**P2.2 Hard-enforcement headroom math.**

`set_ev_charge_deadline.json` does not currently expose an `enforcement` arg, so `hard` is
internal-only today. This slice surfaces `hard` to users and makes it behaviorally distinct
from `soft`. `lib/plan/planBuilder.ts:258` uses `min(capacitySoftLimit, dailySoftLimit)`
uniformly; plumb a "hard objective active" signal from admission into the soft-limit selector
and apply only to EV chargers admitted under `enforcement: 'hard'`. Hard EV bypasses the
daily-tightened soft limit while still respecting the hard cap. Add the `enforcement` dropdown
to the flow-card JSON in the same change so the surface and the behavior land together.

Files: `lib/plan/planBuilder.ts`, `lib/plan/deferredObjectives/admission.ts`,
`flowCards/deadlineObjectiveCards.ts`,
`.homeycompose/flow/actions/set_ev_charge_deadline.json`, headroom and admission tests.

**P2.3 EV deadline observability: measured deviation and expanded trigger tokens.**

The expanded tokens are the mechanism PELS uses to feed notification-friendly text into a user's
own flow, since PELS does not deliver notifications directly.

- **Measured-deviation detection**. `activePlanRecorder.ts:379-380` reserves
  `measured_deviation` and `device_unavailable` reasons but does not emit them. Compare
  observed delivery (read from the calibration EMA via `getDeliveryPowerKw`) against the
  planned bucket allocation, emit a `measured_deviation` revision when divergence sustains
  beyond a threshold. Drives the `risk_reason` trigger token below.
- **Expanded trigger tokens**. `flowCards/deadlineObjectiveCards.ts:161-179` emits 5 tokens for
  `deadline_status_changed`. Add `planned_start_local`, `planned_finish_local`, `required_kwh`,
  `planning_speed_kw`, `estimated_duration_text`, `risk_reason`, and a composed
  `notification_text` token that combines them into a sensible default message line. The
  active-plan recorder's `latest` revision already carries `energyNeededKWh`, `planStatus`,
  and `kwhPerUnitSource` plus the bucket allocation — token sources are all in place.

Files: `lib/plan/deferredObjectives/activePlanRecorder.ts`,
`flowCards/deadlineObjectiveCards.ts`,
`.homeycompose/flow/triggers/deadline_status_changed.json`, related tests.

### P3 — Shape open

**P3.1 EV deadline automation: per-charger defaults and plug-in auto-trigger.**

Per-charger automation profile (enabled, target percent or kWh, ready-by time, enforcement,
speed mode, optional manual kW and derating) plus a hook on the `sessionStartedAtMs` boundary
that materializes the defaults into a `DeferredObjectiveSettingsV1` entry. Open shape
questions: exact field set on the defaults; UI placement of the per-charger form; how the
auto-materialization interacts with an already-existing flow-card-fired objective for the same
device; whether re-plug after a partial session re-fires.

Files: new `packages/contracts/src/evChargerDefaults.ts`, new
`lib/app/evChargerDefaultsWiring.ts`, `lib/core/deviceStateOfCharge.ts`.

**P3.2 Manual override actions and deadline-imminent urgency rule.**

- `charge_now` flow action: override the plan for a one-off trip. Open shape questions:
  duration semantics; capacity-bound vs hard-cap-only; what happens when the plan already says
  "charge now"; how it interacts with a stale-power failsafe.
- `pause_until_next_planned_slot` flow action: soft-pause until the next planned bucket
  boundary. Open shape questions: behavior when no next bucket exists; whether the pause
  surfaces in trigger tokens.
- Deadline-imminent emergency rule: when `(deadline − now) < requiredHours + 1h buffer`, force
  the EV into the planned set regardless of price or budget signals (still hard-cap-bound).
  Open shape questions: the threshold value, interaction with hard-enforcement headroom,
  user-visible explanation.

Files: new flow action JSONs and registrations.

## Out of Scope (v1)

- Settings UI editor for creating one-off plans. The existing flow card covers creation; an
  editor adds surface area without addressing the trust gap.
- Native push notifications. PELS does not deliver notifications; it exposes trigger tokens
  with enough text content for the user's own flow to compose a message.
- Cold-weather reserve. Risks implying precision the runtime cannot deliver; revisit only if
  winter under-charging shows up in telemetry.
- Multi-charger UI coordination beyond per-charger automation. Per-charger plans already give
  the right runtime behavior.
- EV current or phase control. Pause / resume actuation only for v1.
- Generic flow-backed objective cards. Not user-facing for v1.
- Recurrence and calendar integration.

## Release Planning

Priority is orthogonal to release scope. The v1 release must land both P0 items (otherwise two
flow surfaces ship broken). Beyond that, picking which P1 and P2 items to bundle into v1 is a
release-planning decision driven by how much trust signal the first EV ship should carry:

- **Minimum coherent v1**: P0 only. The flow card works end-to-end and the at-risk transitions
  reach user flows. The device card and deadline-plan page show what they show today.
- **Better v1**: P0 + P1. Adds the device-card visible state and the speed / duration line on
  the deadline-plan page. Closes the support-cost gap that otherwise hits the moment P0 lands.
- **Broader coverage**: P0 + P1 + P2.1. Adds kWh target mode for chargers without SoC.
- **More user agency**: P0 + P1 + P2.2. Surfaces hard enforcement.
- **More observability**: P0 + P1 + P2.3. Closes the deviation + token loop and gives users a
  rich `notification_text` token for their own flows.

P3 items can land after v1 as the shapes settle.

## Acceptance Criteria

The feature is releasable when a typical user can answer all of these without scripting:

- What target is PELS charging toward?
- When must it be ready?
- How much energy does PELS think is needed?
- How many hours does that require?
- Is the plan achievable?

And the failure modes are visible:

- Charging speed unknown → bootstrap planning produces a useful allocation immediately.
- Not enough time before deadline → at-risk or cannot-meet status, visible in Smart tasks list
  and trigger surface.
- Car unplugged mid-plan → "Charging plan paused" state on the device card.
- Charger unavailable → "Charger unavailable" state.
- Price data missing → "Planning with readiness and capacity only".
