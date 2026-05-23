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
  continue to. Per-charger automation is quality-of-life follow-up, not the v1 path.
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

- EV SoC observation with session validity (`lib/device/stateOfCharge.ts`): fresh / stale
  status, session start on plug-in, invalidation on plug-out.
- Per-device learned profile (`lib/objectives/profiles.ts`) storing `kwhPerUnit` (kWh per 1%)
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
  `has_active_deadline`; triggers `deadline_status_changed`, `deadline_ended`,
  `deadline_plan_changed`.
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
- Temperature admission wired in `lib/plan/admission/deferredObjective.ts`: cap-off devices made
  visible during planned hours, kept idle outside, setpoint lifted to deadline target.
- EV admission and pause/resume actuation wired across admission, planner, and executor:
  `admission.ts` emits `ev_resume`/`ev_pause` intents per cycle;
  `lib/plan/planBuilder.ts` collects them via `buildDeferredEvCommandIntents`;
  `lib/executor/binaryExecutor.ts` (`applyDeferredEvCommand`) actuates pause when
  `plugged_in_charging` and resume when `plugged_in_paused`;
  `lib/executor/planExecutor.ts` runs stability checks
  (`hasStableEvDeadlineActuation`). Integration tests under
  `test/evDevices.integration.test.ts` cover the resume and pause transitions
  (e.g. `deferredEvCommandIntent: 'ev_resume'` for a paused plugged-in charger).

## Where the trust gap is today

EV admission to charger actuation has landed. The user-facing trust gap is now in
the surfaces that explain whether the plan is trustworthy: the Smart tasks device
card still shows only a chip and no plan state, and the deadline-plan page doesn't
yet surface planning speed or estimated duration. Those are the trust-surface
follow-ups described below.

Feature extensions (kWh target, observability) are stand-alone work that broadens
coverage and adds user agency. Hard enforcement is deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

## Topic map

Sequencing and priority for the topics below live in `TODO.md`; this note
describes *what* each topic is, not *when* it should ship.

### EV admission landed (shipped v1)

EV-aware executor intent (`ev_resume` / `ev_pause`) is emitted by admission,
propagated through the planner, and applied by the binary executor. A
planned EV bucket resumes a paused plugged-in charger; an idle bucket
pauses a charging one. Cooldowns and the stale-power failsafe are honored.
Integration coverage lives in `test/evDevices.integration.test.ts`.

Files (for reference): `lib/plan/admission/deferredObjective.ts`,
`lib/plan/planBuilder.ts`, `lib/executor/binaryExecutor.ts`,
`lib/executor/planExecutor.ts`, `test/evDevices.integration.test.ts`.

### Trust-surface follow-ups

These are the first support-facing clarity gaps once EV deadlines actually
control charging.

#### Device-card visible state

`packages/settings-ui/src/ui/views/PlanDeviceCards.tsx:63` shows only the
Smart task chip. The device card should explain what PELS thinks the
charger is doing: a next-planned-start line ("Waiting · charging starts
01:00"), an active-charging finish line ("Charging · planned finish
05:30"), and a plug-out paused line ("Charging plan paused — car
unplugged"). Pull start / finish from the active-plan recorder's
`latest.hours`; pull the paused state from the `objective_invalid_session`
reason emitted by `resolveEvObjectiveProgress`
(`lib/plan/deferredObjectives/diagnosticsBridge.ts:380-402`), which fires
when the observation layer reports `stateOfCharge.status === 'invalid'`.

Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
`lib/plan/deferredObjectives/diagnosticsBridge.ts`,
`packages/contracts/src/` (diagnostic reason additions if the reason needs
to be public), device-card tests.

Tracked in `TODO.md` (smart task EV device-card state).

#### Planning speed and estimated duration

`packages/settings-ui/src/ui/deadlinePlan.ts:153,164` shows kWh and
hours-until-deadline on the hero meta line, and a separate Plan inputs card
(`packages/settings-ui/src/ui/deadlinePlanInputs.ts`) shows the per-unit
rate (`kWh/°C` or `kWh/%`) plus max power per hour with an EV bootstrap
note when applicable. The deadline-plan page should *also* surface
"Planning speed: X.X kW" and "Estimated time: Yh Zm" on the hero — the
Plan inputs card answers "what is PELS estimating with?" but the hero
needs to answer "how fast and how long?" at top-line. Tag the new hero
fields with a speed-mode badge ("Auto" / "Learning…" today; "Manual" /
"Conservative" later). Compute kW via a new `resolvePlanningKw` selector
that falls back to the calibration view built from
`lib/observer/devicePowerCalibration.ts`. EVs need either a synthetic
1-step profile or an EV-specific branch in `buildStepPowerCalibrationView`
(`lib/app/appInit.ts:468-487`) so the existing `resolveStepDeliveryUsefulKw`
helper serves Automatic mode without code duplication.

Files: `packages/settings-ui/src/ui/deadlinePlan.ts`, `lib/app/appInit.ts`,
`lib/plan/deferredObjectives/diagnosticsBridge.ts`, calibration view tests.

Tracked in `TODO.md` (smart task planning speed / estimated duration).

### Feature extensions

#### kWh target mode

The kWh target is the only EV deadline path that does not depend on SoC
observation at all — no native capability, no session validity, no
freshness window. Stand-alone feature.

`packages/contracts/src/deferredObjectiveSettings.ts:14-16` accepts only
`targetPercent` for the `ev_soc` variant today, and the flow-card JSON
exposes only `target_percent`. Discriminate the contract variant to
accept either `targetPercent` or `targetEnergyKwh`. Add a `target_kwh`
arg path to `set_ev_charge_deadline` (either via additional optional args
or a sibling action — pick whichever keeps validation clean). The
diagnostics bridge computes `energyNeededKwh` directly from
`targetEnergyKwh` when present, bypassing the
`kWhPerUnit × (target% − current%)` math. Validates with both target
shapes round-tripping through the active-plan recorder.

Files: `packages/contracts/src/deferredObjectiveSettings.ts`,
`flowCards/deadlineObjectiveCards.ts`,
`lib/plan/deferredObjectives/diagnosticsBridge.ts`,
`.homeycompose/flow/actions/set_ev_charge_deadline.json`, contract and
bridge tests.

Tracked in `TODO.md` (EV deadline kWh target).

#### Hard-enforcement headroom math

Deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md) for the
design and the EV-specific headroom math originally drafted here.

#### Observability: measured deviation and expanded trigger tokens

The expanded tokens are the mechanism PELS uses to feed
notification-friendly text into a user's own flow, since PELS does not
deliver notifications directly.

- **Measured-deviation detection**. `activePlanRecorder.ts` reserves
  `measured_deviation` and `device_unavailable` reasons but does not emit
  them. Compare observed delivery (read from the calibration EMA via
  `getDeliveryPowerKw`) against the planned bucket allocation, emit a
  `measured_deviation` revision when divergence sustains beyond a
  threshold. Drives the `risk_reason` trigger token.
- **Expanded trigger tokens**. `flowCards/deadlineObjectiveCards.ts` emits
  2 tokens for `deadline_status_changed`. Add `planned_start_local`,
  `planned_finish_local`, `required_kwh`, `planning_speed_kw`,
  `estimated_duration_text`, and `risk_reason`. Token sources already
  live on the active-plan recorder's `latest` revision (`energyNeededKWh`,
  `planStatus`, `kwhPerUnitSource`, bucket allocation). A composed
  `notification_text` token is explicitly *not* part of this proposal —
  see `notes/smart-task-flow-cards/README.md` Rule 4.

Files: `lib/plan/deferredObjectives/activePlanRecorder.ts`,
`flowCards/deadlineObjectiveCards.ts`,
`.homeycompose/flow/triggers/deadline_status_changed.json`, related tests.

Tracked in `TODO.md` (smart task flow card redesign + measured-deviation
work).

### Open shape — automation and overrides

These have open design questions and likely benefit from a separate design
pass before implementation.

#### Per-charger defaults and plug-in auto-trigger

Per-charger automation profile (enabled, target percent or kWh, ready-by
time, enforcement, speed mode, optional manual kW and derating) plus a
hook on the `sessionStartedAtMs` boundary that materializes the defaults
into a `DeferredObjectiveSettingsV1` entry. Open shape questions: exact
field set on the defaults; UI placement of the per-charger form; how the
auto-materialization interacts with an already-existing flow-card-fired
objective for the same device; whether re-plug after a partial session
re-fires.

Files: new `packages/contracts/src/evChargerDefaults.ts`, new
`lib/app/evChargerDefaultsWiring.ts`, `lib/device/stateOfCharge.ts`.

#### Manual override actions and deadline-imminent urgency rule

- `charge_now` flow action: override the plan for a one-off trip. Open
  shape questions: duration semantics; capacity-bound vs hard-cap-only;
  what happens when the plan already says "charge now"; how it interacts
  with a stale-power failsafe.
- `pause_until_next_planned_slot` flow action: soft-pause until the next
  planned bucket boundary. Open shape questions: behavior when no next
  bucket exists; whether the pause surfaces in trigger tokens.
- Deadline-imminent emergency rule: when
  `(deadline − now) < requiredHours + 1h buffer`, force the EV into the
  planned set regardless of price or budget signals (still hard-cap-
  bound). Open shape questions: the threshold value, interaction with the
  deferred hard-enforcement headroom (see
  [`notes/hard-deadlines/README.md`](../hard-deadlines/README.md)),
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

## Sequencing

This note describes design topics; sequencing and priority live in `TODO.md`.
The shipped EV admission slice is in v1. Trust-surface follow-ups (device-card
state, planning speed / duration), feature extensions (kWh target,
observability tokens), and the open-shape automation/override slices are
tracked there. Hard enforcement is deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

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
- Price data missing → pending hero copy depends on price source (the actual shipped strings
  branch on whether prices come from an external flow card vs. the managed Nordpool fetch and
  whether the last-fetched timestamp is recent; see `packages/shared-domain/src/deadlineLabels.ts`
  `awaitingHorizonCopy` for the live variants).
