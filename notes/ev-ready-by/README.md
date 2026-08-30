# EV Ready By

EV Ready By is the user-facing name for an EV-charging deadline feature: a user sets when the car
must be ready and how much charge it needs, PELS estimates required charging time, plans the best
available charging window respecting prices and capacity, controls the charger, and reports
whether the plan is trustworthy.

This note collects the product framing, the gap between the current shipped state and a
releasable feature, and the prioritized task list for closing the gap. Cross-references:

- `notes/deferred-load-objectives/README.md` — technical model for deadline-aware loads. EV Ready
  By is the user-facing surface for the `ev_soc` slice of that model.
- `notes/persisted-settings-state.md` — cut shared-persistence-helper rationale; new EV-related
  settings stores should stay feature-specific.
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

PELS already has the SoC observation, learned charging profile, horizon planner, active-plan
recorder, and pause/resume actuation needed to make this conversion visible and correct. The
remaining product gap addressed by the current direction is direct creation on the Smart tasks
page and a generic immediate intent, alongside the feature extensions listed below.

## Product Principles

- **One creation contract, several routes.** The Smart tasks page should join the dashboard
  widget as a direct creation surface; Flow remains the automation route. Every route must use
  the same planner and device-scoped write contract.
- **No hidden speed assumption.** Required energy, planning speed (kW), and estimated duration
  are visible side by side. The speed source (learned, bootstrap, manual, conservative) is
  labeled.
- **No surface that does not act.** A flow card or settings surface that appears to schedule
  charging must actually issue commands when the plan says so.
- **PELS exposes text via tokens, not push.** Notification delivery is the user's flow; PELS
  supplies trigger tokens with enough content to compose a useful message without scripting.

## Current Baseline

The deferred-objective subsystem already delivers temperature and SoC-based EV deadline tasks
end-to-end, including charger pause/resume actuation:

- EV SoC observation with session validity (`lib/device/transport/stateOfCharge.ts`): fresh / stale
  status, session start on plug-in, invalidation on plug-out.
- Per-device learned profile (`lib/objectives/profiles.ts`) storing `kwhPerUnit` (kWh per 1%)
  and `unitPerHour` (%/hour) with EMA confidence.
- Bootstrap kWh-per-percent fallback in
  `packages/shared-domain/src/objectiveProfileBootstrap.ts`: cold-start EV plans produce a useful
  allocation immediately and refine when learning matures; the active-plan recorder emits a
  `rate_refined` revision when the source flips bootstrap → learned.
- Versioned objective settings (`packages/contracts/src/deferredObjectiveSettings.ts`) with
  `kind: 'ev_soc' | 'temperature'`, `enforcement: 'soft' | 'hard'` (deadlines are soft-only — no
  flow card sets `'hard'`; a persisted `'hard'` still widens the planner variance buffer, so it is
  preserved rather than treated as dead), keyed per device, absolute
  `deadlineAtMs`.
- Public flow cards in `flowCards/deadlineObjectiveCards.ts`: `set_ev_charge_deadline`,
  `set_temperature_deadline`, `clear_deadline`; conditions `deadline_status_is`,
  `has_active_deadline`; triggers `deadline_status_changed`, `deadline_ended`,
  `deadline_plan_changed`.
- Horizon planner (`lib/objectives/deferredObjectives/horizonPlanner.ts`) selecting budget-friendly
  hours before the deadline, price-gated.
- Diagnostics bridge (`lib/objectives/deferredObjectives/diagnosticsBridge.ts`) emitting
  `DeferredObjectiveDiagnostic` per cycle.
- Active-plan recorder (`lib/objectives/deferredObjectives/activePlanRecorder.ts`) persisting current
  allocation with revision triggers (`flow_card`, `prices_arrived`, `objective_changed`,
  `prices_revised`, `rate_refined`).
- Plan history (`lib/objectives/deferredObjectives/planHistory.ts`) capturing per-deadline outcomes
  (`met` / `missed` / `abandoned` / `replaced`).
- Per-device-per-step power calibration (`lib/device/devicePowerCalibration.ts`,
  `lib/objectives/deferredObjectives/objectiveStepPower.ts`) with EMA learning, conservative-high and
  conservative-low query primitives, already wired into stepped-load deferred objectives.
- Smart tasks UI surfaces: list and per-device deadline-plan and history pages
  (`packages/settings-ui/src/ui/deadlinePlan.ts`, `deadlinesList.ts`).
- Temperature admission wired in `lib/objectives/deferredObjectives/admission.ts`, with intents
  attached in `lib/plan/planBuilderDecoration.ts`: cap-off devices made visible during planned
  hours, kept idle outside, setpoint lifted to deadline target.
- EV admission and planned resume / idle-bucket pause actuation wired across admission, planner,
  and executor: `admission.ts` emits `binary_restore`/`binary_release` intents per cycle;
  `lib/plan/planBuilder.ts` collects them via `attachDeferredReleaseIntents`;
  `lib/executor/binaryExecutor.ts` (`applyDeferredBinaryCommand`) actuates idle-bucket pause when the charger
  is drawing and resume for every state the plug-state does not block — `plugged_in` and
  `plugged_in_paused`; a charger already reporting `plugged_in_charging` is converged;
  `lib/executor/planExecutor.ts` runs stability checks
  (`hasStableBinaryReleaseActuation`). Integration tests under
  `test/integration/evDevices.integration.test.ts` cover the resume and pause transitions
  (e.g. `deferredReleaseIntent: 'binary_restore'` for a paused plugged-in charger). Satisfied and
  deadline fallback is separate: the lifecycle clock calls app wiring, which gates scope/disarm and
  delegates convergence to the lifecycle-fallback executor. It never emits a plan-path release intent.

### Plug-state is not a commandability oracle

PELS blocks exactly two plug-states: `plugged_out` and `plugged_in_discharging`.
Every other state is commandable. `isEvPlugStateCommandable`
(`packages/shared-domain/src/evPlugState.ts`) is the only place that decision is
made; commandability, the boost gate, and the boost-panel copy all derive from
it, and nothing carries a derived copy of the answer — the plug-state itself is
what the OBSERVER carries (`ObservedDeviceState.evChargingState`, required on the
narrowed `EvObservedFields`). It does not ride the plan device: there is no EV
cluster on the plan types (owner ruling 2026-08-15, `lib/plan/AGENTS.md`), and the
settings UI reads the state through `getObservedEvChargingState`.

The value is vendor-defined and inconsistent, so nothing finer can be read from
it. Easee maps op mode 6 "Ready to Charge" AND 7 "Awaiting Authentication" to
`plugged_in`, and its Homey `evcharger_charging` write calls the Easee
`start_charging` command — the authorization the charger is waiting for. Wallbox
maps its own `Paused` state to `plugged_in` and never emits `plugged_in_paused`
at all, so treating `plugged_in` as a block meant PELS could not resume a charger
it had paused itself. go-e and Zaptec can use it for a finished session. PELS
therefore commands the state and lets the ordinary command-confirmation path
judge the outcome: a rejected write fails immediately; an accepted write must
settle within the confirmation window `resolveControlCommandConfirmationMs` picks
for the device's communication model — 90 s local
(`LOCAL_CONTROL_COMMAND_CONFIRMATION_MS`), 3 min cloud
(`CLOUD_CONTROL_COMMAND_CONFIRMATION_MS`). **Settlement is strictly the `evcharger_charging`
readback** — a `BinaryControlObservation` from one of `snapshot_refresh`,
`realtime_capability`, or `device_update` — not measured power and not the
associated car. `resolveEvChargingStateBinaryEvidence` still reads the
plug-state, but only as a *freshness* gate now
(`lib/device/transport/managerParseFreshness.ts`): it decides whether the
plug-state capability counts toward "this device has fresh data", never whether
a command landed. A write that does not settle backs off for 15, then 30, then
60 minutes while other loads remain eligible — see "One back-off, and it is not
EV-specific" below. Verified on production 2026-07-26: PELS wrote
`evcharger_charging=true` on a charger waiting for approval and the session
started.

**There is no "unknown plug-state" to classify.** Every EV charger has a
plug-state axis, and PELS requires it of every `evcharger`
(`managerNativeEv.resolveCandidateCapabilities`, ahead of both control-axis
bypasses) — `target_power` / stepped-load is the amp/step axis and does not
substitute for it. `evcharger_charging_state` is a closed Homey enum, so a device
that claims the capability and reports outside it does not implement the
contract, and the producer DROPS it
(`managerParse.shouldDropForEvPlugStateContract`). Consumers therefore never see
an EV device with an unreadable plug-state, `evChargingState` is REQUIRED on the
narrowed shape (`isEvObserved` tests EV-ness alone), and no layer needs a policy
for absence.

**"No policy for absence" is not "the field is everywhere."** It is required on
the OBSERVED shape and absent by design past `toPlanDevice`, which resolves it
into `commandableNow` / `commandabilityReason` and strips the raw value. Because
`isEvObserved` infers presence from EV-ness alone, narrowing a plan device with
it type-checks and then reads `undefined` — which is how the objectives layer's
unplugged-charger precondition sat dead through 2026-08, reporting a car that was
never on the cable as a stale state-of-charge reading for entire task windows
(fixed by reading the producer-resolved `objectiveSessionInactive`, declared
REQUIRED so the next strip is a compile error; see `lib/objectives/types.ts`). A
layer that needs the plug-state and is downstream of the producer must read the
resolved bit, not re-narrow for the raw one — and must read the bit that answers
its own question: `commandableNow` folds in availability and PELS's own command
back-off, so it is not a synonym for "no creditable session".

### One back-off, and it is not EV-specific

**There is no `plugged_in` / `plugged_in_paused` probe split.** It was deleted
2026-08-13 (`7edb9517b`, "unify binary command settlement") along with
`resolveEvStartProbePosture`, and replaced by `createBinaryCommandReachability`
(`lib/plan/admission/binaryCommandReachability.ts`). What runs today is ONE
unconditional, self-releasing back-off over every binary device, keyed on
`deviceId` alone (a `desired === true` gate decides what arms and confirms it, but
does not enter the key), with no knowledge of device class or plug-state:

- **Arming.** `onDispatchFailed` and `onTimedOut` both record a failure and
  schedule a rebuild at `now + RETRY_DELAYS_MS[failures - 1]`, where
  `RETRY_DELAYS_MS = [15, 30, 60]` minutes — the same ladder the probe used. The
  failure count saturates at three, so the wait never exceeds 60 minutes.
- **Effect.** While the timer is pending, `project` answers
  `{ commandableNow: false, reason: 'binary_command_retry' }` — for a device that
  was otherwise commandable; one already blocked keeps its own `reason: 'none'`.
  `toPlanDevice` folds that into `commandableNow`, so the device drops out of admission and
  other loads stay eligible. Once `Date.now() >= retryAtMs` it is commandable
  again with nothing having to clear the entry: the back-off releases itself.
- **Early release.** Three things clear it before the timer: `onConfirmed` (the
  write settled), `observedOn` (the `evcharger_charging` readback came back on,
  by any route), and `available && sawUnavailable` (the device had gone offline
  and has returned). `prune` drops entries for devices that leave the roster and
  `dispose` clears them on teardown.

Wired per home in `setup/homeRuntime/homeScope.ts` and
`setup/homeRuntime/createHomeCapacityBundle.ts`, which pass `project` / `prune`
into `toPlanDevice` and the lifecycle listener into the pending-binary-command
store.

**What the split's removal traded away — accepted, with its bound.** The old
design had a fourth release trigger this one does not: LEAVING the probed
plug-state. A Zaptec that moved a finished session back to `Connected_Requesting`
was commandable on the very next rebuild, on the plug-state alone.

The readback trigger covers part of that. `observedOn` is the `evcharger_charging`
value folded through `resolveCurrentOn` (`toPlanDevice`), so any charger that
actually starts reporting itself on releases the back-off. On the Zaptec overlay
population `resolveZaptecChargingValue` can supply that value from the plug-state
itself when `charging_button` carries no boolean — and then `Connected_Requesting`
still releases the back-off — on the next re-parse, at the latest the :25 / :55
snapshot refresh, but not on the realtime `charge_mode` push, which rewrites only
the state capability.

What is genuinely lost is the charger that becomes resumable while its
`evcharger_charging` readback stays false — an Easee that clears authorization
and reports `plugged_in`, say. That one waits out the remaining 15/30/60-minute
timer. **That is latency, not deadlock**: the timer always expires and the wait is
capped at 60 minutes.

It is also unpaid so far. The back-off arms only through `recordFailure`, which
is the sole emitter of the plan-rebuild reason `binary_command_reachability_changed`
— that reason is the one always-logged signal it produces, since
`binary_command_retry` is a `commandabilityReason` value that never reaches a log
line. In the 2026-08-11→23 production log it appears **four times, all on
2026-08-13, under commit `748a2337e`** — the pre-unify EV probe, which had its own
failure-only rebuild request. The unified code first ran on 2026-08-15 (`f09dc988a`,
the first deploy containing `7edb9517b`), and there has been **no occurrence since**.
Do not read those four hits as counterexamples; check the deploy they fall under.

This was chosen, not overlooked, and no TODO entry is filed for it. The obvious
"fix" — release on a plug-state transition — would put raw EV plug-state
vocabulary back into `lib/plan`, which `scripts/check-ev-vocab.mjs` forbids
outright, and that guard exists precisely because consumers reading `plugged_*`
strings is how PELS kept re-deriving semantics the producer had already resolved.
Bounded latency in a path that has never fired does not justify reopening that
door, and the alternative shape is an undecided design call — which the TODO
Entry Bar excludes.

### The `plugged_in` / `plugged_in_paused` mapping still matters, for other reasons

Every predicate in `evPlugState.ts` classifies the two identically — both
commandable, both a creditable session, both connected — so the choice between
them no longer decides whether PELS may drive the charger. What it decides is the
words the owner reads and a fallback readback:
`packages/shared-domain/src/planSteppedCardText.ts` renders them `Paused` and
`Not charging` (and splits them again in its charger-vs-car exception branches —
`Waiting for car` against `Paused by the car`), and `resolveZaptecChargingValue`
— when `charging_button` carries no boolean of its own — turns
`plugged_in_paused` into a synthesized
`evcharger_charging = true` and `plugged_in` into no synthesized value at all. A
finished session is neither charging nor paused-and-resumable, so claiming
otherwise is wrong on both counts. Three producers feed the state in
`nativeEvWiring.ts`, and all three resolve a FINISHED session to `plugged_in`:

- the `charge_mode` mapping, under both spellings Zaptec uses — the operation-mode name
  `Connected_Finishing` and the display label `Charging finished`. They disagreed until 2026-08-09;
- the realtime `alarm_generic.car_connected` normalizer, which rewrote ANY non-charging state to
  `plugged_in_paused`. It carries one bit — a car is attached — so it may now only promote a
  DISCONNECTED charger and otherwise preserves what is there. `charge_mode` is change-only push and
  a car parked at its limit never re-sends it, so the overwrite used to stand until the :25/:55
  snapshot;
- the snapshot fallback for an absent or unmapped `charge_mode`, which now resolves to
  `plugged_in` rather than claiming a resumable pause.

The rule they share: when all PELS knows is that a car is attached, the honest state is the
ambiguous one — `plugged_in`, which asserts nothing about a session, rather than
`plugged_in_paused`, which asserts one that can resume.

This applies only to Zaptec models that do NOT publish both official EV capabilities; when the app
publishes `evcharger_charging_state` itself, `applyNativeEvWiringOverlay` defers to it and the
vendor owns the classification.

Two absences are distinguished at that gate, and the distinction is load-bearing:
a payload that REPORTS the capability with a non-enum value is a violation (drop,
even if an older valid value is retained — keeping it would strand a stale
plug-state), while a payload that OMITS the capability is an ordinary partial
`device.update` (retain the last observation; drop only if there has never been
one). Getting this wrong evicts healthy chargers on every partial update.

Blocking such a charger instead of dropping it was the earlier design, and it was
a one-way door: shed selection does not consult commandability
(`lib/plan/shedding/candidateBuilders.ts` gates on writability and observed draw)
while both restore paths do, so PELS could turn the charger off and never turn it
back on — parked `inactive`, which also pauses its starvation clock, leaving the
owner no card, no "Let it run now", and no diagnostics entry. A dropped device is
never shed in the first place, so the door never opens.

The control axis is what varies, not the state axis: an `evcharger` may be driven
through `target_power` or a stepped-load profile and never expose
`evcharger_charging`, which is why those two bypasses exist. They waive the
CONTROL capability only. Verified against production: the `Elbillader`
(`8996261a-…`, Zaptec via `charging_button`, `ev_charger_1_phase` preset) is
exactly that population and its logs carry 282 `evcharger_charging_state`
observations — the earlier claim in
`test/integration/evChargerShedReassertCooldownFreeze.test.ts` that it had no
state capability was wrong, and its fixture has been corrected.

Separately: `plugged_in` does NOT block objective progress. It once did, via a
`isEvChargerNotResumable` → `objective_charger_not_resumable` lane; that lane was
deleted 2026-08-22 after prod logs showed nothing had ever produced the code, and
`resolveObjectiveProgress` documents why blocking there did real damage (it
returned `remainingUnits: 0`, so the task planned no hours on a charger PELS was
in the middle of authorizing). May-we-command and is-there-a-session remain
different questions: the second is `isEvSessionInactive`, resolved at
`toPlanDevice` and carried to the smart-task lane as `objectiveSessionInactive`.

## Where the trust gap is today

EV admission to charger actuation has landed, and the two trust-surface
follow-ups that this note originally flagged have **shipped** (see below): the
Smart tasks device card now explains charger plan state, and the deadline-plan
hero surfaces planning speed and estimated duration. The broader product
follow-ups are direct creation on the Smart tasks page and the generic immediate
intent. The remaining EV-specific extensions — kWh target mode and expanded
observability — are described further down.

Those EV-specific extensions are stand-alone work that broadens coverage and
adds user agency.

## Topic map

Sequencing and priority for the topics below live in `TODO.md`; this note
describes *what* each topic is, not *when* it should ship.

### EV admission landed (shipped v1)

EV-aware executor intent (`binary_restore` / `binary_release`) is emitted by admission,
propagated through the planner, and applied by the binary executor. A
planned EV bucket resumes a paused plugged-in charger; an idle bucket
pauses a charging one. Cooldowns and the stale-power failsafe are honored.
Integration coverage lives in `test/integration/evDevices.integration.test.ts`.

Files (for reference): `lib/objectives/deferredObjectives/admission.ts`,
`lib/plan/planBuilderDecoration.ts`, `lib/executor/binaryExecutor.ts`,
`lib/executor/planExecutor.ts`, `test/integration/evDevices.integration.test.ts`.

### Trust-surface follow-ups (shipped)

Both clarity gaps that this note flagged once EV deadlines actually control
charging have shipped.

#### Device-card visible state — shipped

`PlanDeviceCards.tsx` now renders an EV plan-state line via
`resolveEvCardStateLine` (`packages/shared-domain/src/deadlineLabels.ts`): a
next-planned-start line, an active-charging finish line, and a plug-out paused
line. Start/finish come from the active-plan recorder's `latest.hours`; the
paused state comes from `isPlugOutPaused` (the `objective_invalid_session`
reason emitted by `resolveEvObjectiveProgress` in
`lib/objectives/deferredObjectives/diagnosticsBridge.ts`, which fires when the
observation layer reports `stateOfCharge.status === 'invalid'`).

#### Planning speed and estimated duration — shipped

The deadline-plan hero surfaces "Planning speed: X.X kW" and an estimated
duration via `planningSpeedKw` / `estimatedDurationText` in
`packages/settings-ui/src/ui/deadlinePlan.ts` (commit `8720af37`),
alongside the existing Plan inputs card (`deadlinePlanInputs.ts`) that shows the
per-unit rate and max power per hour. The planning kW falls back to the
calibration view built from `lib/device/devicePowerCalibration.ts` via
`buildStepPowerCalibrationView` (`lib/app/appInit/calibrationViews.ts`), reusing
`resolveStepDeliveryUsefulKw`.

### Feature extensions

#### kWh target mode

The kWh target is the only EV deadline path that does not depend on SoC
observation at all — no native capability, no session validity, no
freshness window. Stand-alone feature.

`DeferredObjectiveEvSocSettingsEntry`
(`packages/contracts/src/deferredObjectiveSettings.ts`) accepts only
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
`lib/objectives/deferredObjectives/diagnosticsBridge.ts`,
`.homeycompose/flow/actions/set_ev_charge_deadline.json`, contract and
bridge tests.

Tracked in `TODO.md` (EV deadline kWh target).

#### Observability: expanded trigger tokens

The expanded tokens are the mechanism PELS uses to feed
notification-friendly text into a user's own flow, since PELS does not
deliver notifications directly.

- **Measured-deviation detection** is shipped: `activePlanRecorder.ts`
  emits a `measured_deviation` revision when the learned per-unit energy
  rate drifts far enough from the committed plan baseline.
- **Expanded trigger tokens** remain deferred. `flowCards/smartTaskTokens.ts`
  currently emits only the stable minimum token bags. Add `planned_start_local`,
  `planned_finish_local`, `required_kwh`, `planning_speed_kw`,
  `estimated_duration_text`, and `risk_reason`. Token sources already
  live on the active-plan recorder's `latest` revision (`energyNeededKWh`,
  `planStatus`, `kwhPerUnitSource`, bucket allocation). A composed
  `notification_text` token is explicitly *not* part of this proposal —
  see `notes/smart-task-flow-cards/README.md` Rule 4.

Files: `flowCards/smartTaskTokens.ts`, `flowCards/deadlineObjectiveCards.ts`,
`.homeycompose/flow/triggers/deadline_status_changed.json`, related tests.

Tracked in `TODO.md` (smart task expanded trigger tokens).

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
`setup/evChargerDefaultsWiring.ts` (new wiring goes in `setup/`; `lib/app/` has
dissolved to `appContext.ts`), `lib/device/transport/stateOfCharge.ts`.

#### Immediate intent, pause action, and deadline-imminent urgency

- Immediate charging is the EV presentation of the generic immediate
  Smart-task intent in `notes/smart-task-ui/README.md`, not an EV-only
  command lane. It asks for a target percent, includes the current hour
  whenever the charger is commandable and the hard cap permits it, works
  without a price source, applies the task-scoped budget/lower-priority
  permissions, suppresses the price/cold-start release gates, and retains
  stale-power safety. Its finite expiry and outcomes come from the generic
  intent contract. The Smart tasks page and the New smart task widget should
  reach the same implementation.
- `pause_until_next_planned_slot` flow action: soft-pause until the next
  planned bucket boundary. Open shape questions: behavior when no next
  bucket exists; whether the pause surfaces in trigger tokens.
- Deadline-imminent emergency rule: when
  `(deadline − now) < requiredHours + 1h buffer`, force the EV into the
  planned set regardless of price or budget signals (still hard-cap-
  bound). Open shape questions: the threshold value and the
  user-visible explanation.

Files: shared Smart-task contracts and candidate/write paths, Smart tasks and
dashboard creation surfaces, the pause Flow action/registration, and
deferred-objective admission/status logic for urgency.

## Out of Scope (v1)

- Direct creation on the Smart tasks page was excluded from v1. The later product direction
  is tracked in `notes/smart-task-ui/README.md` and `TODO.md`; it reuses the shipped
  preview/write paths rather than changing the v1 objective model.
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
tracked there.

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
