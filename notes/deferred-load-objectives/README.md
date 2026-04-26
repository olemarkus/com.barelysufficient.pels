# Deferred Load Objectives

This note defines the intended model for deadline-aware loads. It is design guidance for future
implementation work, not current shipped behavior.

The first concrete target is a Connected 300-style water heater because it is available for
real-world validation. The abstractions must still serve EV charging later without making the
planner EV-percent-centric.

## Goal

PELS should evaluate whether a managed load is likely to reach a desired ready state by a
deadline, then bias restore and admission behavior only as much as needed while preserving hard
capacity safety.

The same internal model must support different user-facing languages:

- Water heaters: target temperature by time, optional reserve temperature, observed temperature,
  stored usable energy when available, and mode constraints.
- EV chargers: battery percent, target percent, connected/session state, conservative charge rate,
  and departure time.
- Generic flow-backed storage: reported percent, stored energy, remaining energy, target, and
  deadline values supplied by flows or PELS config.

Percent, temperature, and manual reports are input languages. Internal planning should prefer
energy, conservative net rate, and time.

## Core Abstraction

Keep device-specific interpretation outside the generic planner. The planner should consume a
generic objective evaluation, not raw EV or water-heater semantics.

The intended pipeline is:

1. **Objective state** stores reported/configured facts with timestamps and provenance.
2. **Adapter/domain mapping** converts user-facing state into usable stored energy and target
   energy where possible.
3. **Rate estimator** determines conservative net gain rate and confidence.
4. **Objective evaluator** computes deadline health and the minimum required device action.
5. **Planner integration** uses that evaluation in restore/admission while preserving safety.

This gives PELS one planner contract for both EVs and heaters:

- How much energy remains?
- How fast can this device conservatively add useful energy?
- How much time remains?
- What is the minimum step/mode/action required to remain on plan?
- Is the answer trustworthy enough to act on?

## State vs Evaluation

Persisted/reported objective state must be separate from derived planner evaluation. This follows
the state-management rule that observed, planned, commanded, and effective planning state must not
be collapsed into one object.

```ts
type DeviceObjectiveState = {
  kind: 'thermal_storage' | 'ev_soc' | 'storage_percent' | 'manual_energy';

  progressPercent?: number;
  progressObservedAtMs?: number;

  currentEnergyKwh?: number;
  currentEnergyObservedAtMs?: number;

  remainingEnergyKwh?: number;
  remainingEnergyObservedAtMs?: number;

  measuredTemperatureC?: number;
  measuredTemperatureObservedAtMs?: number;

  targetPercent?: number;
  targetEnergyKwh?: number;
  targetTemperatureC?: number;
  reserveTemperatureC?: number;

  capacityKwh?: number;
  capacitySource?: 'flow' | 'user' | 'capability' | 'settings' | 'native_profile' | 'learned';

  softDeadlineAtMs?: number;
  hardDeadlineAtMs?: number;

  sessionStartedAtMs?: number;
  invalidatedAtMs?: number;

  modeId?: string;
  modeSource?: 'device' | 'pels_deadline' | 'user';
  previousModeId?: string;
};
```

```ts
type DeviceObjectiveEvaluation = {
  status: 'unknown' | 'likely_to_meet' | 'at_risk' | 'cannot_be_met';
  stableStatus?: 'unknown' | 'likely_to_meet' | 'at_risk' | 'cannot_be_met';

  activeMode: 'none' | 'soft' | 'hard';
  progressStatus: 'unknown' | 'fresh' | 'stale' | 'invalid_session';

  energyNeededKwh?: number;
  requiredAverageKw?: number;
  conservativeNetGainKw?: number;
  projectedCompletionAtMs?: number;

  rateEstimate?: ObjectiveRateEstimate;

  requestedMinimumStepId?: string;
  requestedStepReason?: string;

  requestedModeId?: string;
  requestedModeReason?: 'target_temperature_requires_mode' | 'deadline_requires_rate';

  reasonCode?: ObjectiveReasonCode;
};
```

```ts
type ObjectiveRateEstimate = {
  kw: number;
  deratedKw: number;
  kind:
    | 'direct_remaining_time'
    | 'learned_net_gain'
    | 'learned_session_average'
    | 'configured_planning_power'
    | 'current_measured_power'
    | 'native_profile';
  confidence: 'high' | 'medium' | 'low';
  observedAtMs?: number;
  sourceKey?: string;
};
```

The planner should use `deratedKw` or `conservativeNetGainKw` for deadline feasibility, not raw
electrical power.

## Native vs Flow-Backed Inputs

PELS needs two integration modes.

### Generic Flow-Backed Objectives

Flow-backed devices must provide their own objective data through PELS flow cards or PELS user
configuration. PELS should not inspect arbitrary app-specific settings for generic devices.

Supported generic inputs should include:

- report progress percent
- report current stored energy in kWh
- report remaining objective energy in kWh
- report measured storage temperature
- set target percent
- set target energy in kWh
- set target temperature
- set capacity in kWh
- set soft deadline
- set hard deadline
- clear objective

If a flow reports only percent without capacity, remaining energy, or a direct time estimate, PELS
may display the progress but must not produce optimistic deadline planning.

### Native Adapters

Native adapters may use known capability mappings, settings, and device profiles. Native discovery
must be explicit per adapter or device family. Do not scrape arbitrary setting names into generic
planner truth.

Every inferred value must carry provenance such as `capability`, `settings`, `native_profile`,
`user`, `flow`, or `learned`.

Native adapters own device-specific translation. Examples:

- A water-heater adapter can translate temperature and mode into usable stored energy.
- An EV adapter can translate SoC and capacity into energy needed, and can apply EV session
  invalidation rules.
- A future learned model can estimate net gain rate by step or charge rate by SoC band.

## Connected 300 First

The first implementation should be native or semi-native around the existing stepped-load model,
with Connected 300-style devices as the validation target.

The user-facing objective should be temperature-first:

- reach `X C` by a deadline
- optionally maintain or reserve at least `Y C`
- show likely, at risk, cannot meet, or unknown/stale

Do not expose fill level, battery state, or storage percent as the primary UX for water heaters.
Those may exist internally or diagnostically, but users will expect "hit temperature X at time Y".

### Thermal Energy Semantics

For thermal storage, `currentEnergyKwh` means usable stored energy relative to an adapter-defined
baseline, not vague total heat content.

For example:

```ts
currentEnergyKwh = energyBetween(baselineTemperatureC, measuredTemperatureC);
targetEnergyKwh = energyBetween(baselineTemperatureC, targetTemperatureC);
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);
```

The baseline must be explicit in the adapter/profile. It might be a minimum useful temperature,
reserve temperature, or another device-specific comfort/safety baseline.

When a device reports stored energy directly, prefer that over a temperature-derived estimate.
Temperature can still be used for UX, diagnostics, and fallback mapping.

### Mode-Dependent Capacity

For water heaters, mode can change the maximum allowed temperature, the usable capacity, and
sometimes the charge rate. Capacity is therefore not a fixed device constant unless the mode is
fixed.

Model usable capacity against the active or requested mode:

```ts
usableCapacityKwh = energyBetween(baselineTemperatureC, modeMaxTemperatureC);
```

Target feasibility must account for mode:

- If the current mode can reach `targetTemperatureC`, no mode change is required.
- If the current mode cannot reach the target and deadline control is not allowed to change mode,
  the objective is `cannot_be_met`.
- If mode override is allowed, request the lowest mode that can safely reach the target.
- If a higher mode is needed only for rate/deadline reasons, request it only when the objective is
  hard/urgent enough.

### Mode Override Rules

Mode override should exist only in a native adapter that understands the device. Generic
flow-backed devices should not receive automatic mode changes unless their flow integration
implements them explicitly.

Rules:

- Soft deadlines should not override user/device mode by default.
- Hard deadlines may request a mode change if the current mode cannot meet the target.
- Override must be minimal: choose the lowest mode that can satisfy the target and deadline.
- Never exceed configured safety or user maximum temperature.
- Restore the previous mode after the target is met or the deadline window expires, unless the
  user changed the mode manually.
- Manual user mode changes should win unless the user explicitly enabled deadline mode control.

Mode request is part of objective evaluation:

```ts
requestedModeId?: string;
requestedModeReason?: 'target_temperature_requires_mode' | 'deadline_requires_rate';
```

### Step Selection

Connected 300-style devices are stepped loads. Objective evaluation should compute the lowest step
that keeps the objective on plan:

```ts
requestedMinimumStepId?: string;
```

Evaluate configured steps in order:

1. Off
2. Lowest active step
3. Next active step
4. Highest active step

Choose the lowest step whose conservative projected completion meets the applicable deadline
margin. If no step can meet the deadline, request the highest allowed step and set
`status = 'cannot_be_met'`.

Objective urgency protects only the requested minimum step. Higher steps remain opportunistic.

Examples:

- If `Off` is enough, request no power.
- If `Low` is enough, protect `Low`.
- If `Low` is not enough but `Medium` is, protect `Medium`.
- If only `Max` plausibly works, protect `Max`.
- If the target is already met, request no step.

This changes the old broad stepped-load invariant. The long-term invariant should be:

> PELS should keep as many devices active as possible, unless a storage objective must use a
> higher step to remain on plan.

## EV Semantics

EV support should use the same objective model but different adapter semantics.

User-facing EV inputs are normally:

- battery percent
- target percent
- ready/departure time
- charger power or session charging estimate

Derived energy from percent requires capacity:

```ts
currentEnergyKwh = progressPercent / 100 * capacityKwh;
targetEnergyKwh = targetPercent / 100 * capacityKwh;
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);
```

If capacity is missing, the objective may display progress but deadline planning should be
`unknown` unless a direct remaining-energy or remaining-time estimate is available.

EV progress belongs to the charger session:

- disconnect or unplug invalidates effective progress
- reconnect starts a new session boundary
- planning requires a fresh progress sample newer than the reconnect/session start
- stale or invalid SoC must not drive scheduling
- previous raw SoC may remain visible only for diagnostics

For v1 EV actuation remains pause/resume unless a stepped/current profile exists. Do not add
phase/current control without a separate design and PR.

## Energy Calculation

Use the strongest available energy model.

Direct remaining energy:

```ts
energyNeededKwh = Math.max(0, remainingEnergyKwh);
```

Current and target energy:

```ts
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);
```

Percent and capacity:

```ts
remainingPercent = Math.max(0, targetPercent - progressPercent);
energyNeededKwh = remainingPercent / 100 * capacityKwh;
```

Temperature and thermal profile:

```ts
currentEnergyKwh = energyBetween(baselineTemperatureC, measuredTemperatureC);
targetEnergyKwh = energyBetween(baselineTemperatureC, targetTemperatureC);
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);
```

Available time:

```ts
availableHours = Math.max(0, (deadlineAtMs - nowMs) / 3_600_000);
requiredAverageKw = energyNeededKwh / availableHours;
```

If `energyNeededKwh <= 0`, the objective is met:

```ts
status = 'likely_to_meet';
activeMode = 'none';
requestedMinimumStepId = undefined;
```

Missing, stale, invalid, or impossible inputs must produce `unknown` or `cannot_be_met`, never
optimistic planning.

## Conservative Net Rate

Deadline feasibility must be based on conservative net useful-energy gain, not raw electrical
input.

For water heaters, useful stored energy can fall while the element is on because of heat loss or
hot-water use. The best estimate is learned or reported net stored-energy gain per step. If that is
not available, use configured step planning power with a conservative derating.

For EVs, charging may taper near high SoC. AC home charging is often charger-limited and close to
flat for much of the session, but a flat rate to 100% can still be optimistic.

Rate estimate preference:

1. Fresh direct remaining-time estimate.
2. Learned net gain or session average, derated.
3. Configured planning power or native profile, derated.
4. Fresh current measured charging power, only if it is a reasonable forecast for the current
   device state.
5. Unknown.

Do not treat circuit maximum as sufficient for `likely_to_meet` unless a native adapter/profile can
prove it is a conservative planning estimate.

For stepped loads, evaluate each candidate step independently:

```ts
projectedCompletionAtMs =
  nowMs + (energyNeededKwh / conservativeStepNetGainKw) * 3_600_000;
```

## Confidence and Deadline Margins

Rate confidence should affect deadline margins.

Use conservative rate for `likely_to_meet`. A less conservative expected rate may explain
`at_risk`, but it should not make the planner optimistic.

Initial margin model:

```ts
baseDeadlineMarginMs = 15 * 60 * 1000;
mediumConfidencePenaltyMs = 15 * 60 * 1000;
lowConfidencePenaltyMs = 45 * 60 * 1000;
```

Effective margin:

```ts
deadlineMarginMs = baseDeadlineMarginMs + confidencePenaltyMs + curveOrInstabilityPenaltyMs;
```

Suggested statuses:

- `likely_to_meet`: conservative projected completion is before deadline minus margin.
- `at_risk`: expected behavior may meet the deadline, margin is low, or only hard behavior can
  plausibly meet it.
- `cannot_be_met`: even the highest allowed hard-cap-safe behavior cannot plausibly meet the
  target before the deadline.
- `unknown`: required inputs are missing, stale, invalid, or impossible to evaluate.

Hysteresis should stabilize UI and flow triggers, but must not blind the planner. The planner
should consume the latest conservative evaluation. Flow triggers and user-visible stable state may
use rules such as:

- require two consecutive evaluations before downgrading from `likely_to_meet` to `at_risk`
- allow immediate transition to `cannot_be_met`
- require five minutes stable before upgrading from `at_risk` to `likely_to_meet`

## Soft and Hard Deadlines

Soft deadline is advisory pressure within normal PELS behavior. It must respect:

- effective soft limit
- daily budget soft limit
- device priority
- restore cooldowns
- one-restore-at-a-time behavior
- stepped-load progression
- stale power failsafe
- pending command confirmation and backoff
- existing safety/freshness rules

For the first implementation, soft objective pressure may be diagnostics-only. If it affects
behavior, it should only improve ordering among otherwise eligible restore candidates.

Hard deadline is urgent admission. It may bypass:

- daily soft-limit blocking
- effective soft-limit blocking

It must still respect:

- hard capacity cap and margin
- live power freshness failsafe
- device availability
- actuator capability
- EV connected/resumable state
- stepped-load progression
- pending-command confirmation and backoff
- stale power failsafe

Hard deadline should use hard-cap headroom:

```ts
hardHeadroomKw = capacitySoftLimitKw - totalPowerKw;
```

not the effective `softLimitKw` when daily budget has lowered it.

Long term, hard objective mode may create hard-cap-safe headroom by rebalancing lower-priority or
more flexible devices. That rebalancing must:

- protect only `requestedMinimumStepId`
- preserve hard capacity safety
- prefer keeping devices active where possible
- shed or keep shed lower-priority/flexible devices when needed
- drop back once the objective is safe again
- never skip configured stepped-load progression

## Planner Integration

Add an objective evaluator before restore/shed planning.

Inputs:

- device snapshots
- objective state
- current time
- total power and freshness
- capacity soft limit
- effective soft limit
- hard-cap headroom
- expected/planning power
- stepped profile
- native adapter state, if present
- EV session state, if relevant

Outputs:

```ts
objectiveEvaluation: DeviceObjectiveEvaluation;
```

Planner behavior:

- `none` or `likely_to_meet`: current behavior.
- `soft`: normal restore lane; optional ordering pressure only.
- `hard`: hard-cap admission lane; may bypass effective soft limit and daily soft limit while
  preserving hard-cap safety.

Hard mode may admit or advance the objective device one configured step at a time. It must not use
stale/invalid progress, skip steps, exceed configured planning power, or treat missing data
optimistically.

## Flow Triggers

Future flow triggers should include:

- objective became likely to meet
- objective became at risk
- objective became impossible to meet
- objective target was met
- objective deadline was missed
- objective progress became stale
- objective session became invalid

Flow tags should include values where available:

- device
- objective kind
- progress percent
- current stored energy kWh
- remaining energy kWh
- measured temperature C
- target percent
- target stored energy kWh
- target temperature C
- capacity kWh
- soft deadline
- hard deadline
- deadline status
- active mode
- required average kW
- projected completion
- requested minimum step
- requested mode
- reason code

## Reason Codes

Use structured reason codes rather than prose as planner contract.

Initial codes:

- `objective_unknown`
- `objective_progress_stale`
- `objective_invalid_session`
- `objective_missing_capacity`
- `objective_missing_target`
- `objective_missing_deadline`
- `objective_missing_charge_rate`
- `objective_missing_temperature`
- `objective_missing_thermal_profile`
- `objective_mode_cannot_reach_target`
- `objective_mode_override_disabled`
- `objective_likely_to_meet`
- `objective_at_risk`
- `objective_cannot_be_met`
- `objective_soft_deadline_restore`
- `objective_hard_deadline_restore`
- `objective_hard_deadline_step_request`
- `objective_hard_deadline_mode_request`
- `objective_hard_deadline_rebalance`
- `objective_hard_deadline_blocked_hard_cap`
- `objective_target_met`
- `objective_deadline_missed`

## First PR Shape

Recommended implementation order:

1. Add generic objective state/evaluation types and pure evaluator tests.
2. Add generic flow reporting for percent, stored energy, remaining energy, target, capacity, and
   deadlines.
3. Add Connected 300-oriented thermal objective support using stepped-load profiles, temperature
   input, target temperature, and requested minimum step.
4. Add freshness and invalidation rules.
5. Surface objective diagnostics and reason codes.
6. Integrate soft objective as diagnostics or restore ordering only.
7. Add hard admission for already available hard-cap headroom.
8. Add hard rebalancing as a follow-up if it touches shed planning deeply.

The first Connected 300 implementation should focus on temperature-by-deadline UX, thermal energy
mapping, per-step rate estimates, and requested minimum step selection.

Out of scope unless explicitly included:

- automatic EV/car polling
- full settings UI editor
- calendar/recurrence UI
- EV current or phase control
- automatic battery capacity learning
- thermal temperature-to-energy learning
- charge curves by SoC band
- multi-device global optimization across objectives

## Acceptance Criteria

Core objective:

- A flow can report percent progress for a managed objective device.
- A flow can report current stored energy in kWh.
- A flow can report remaining objective energy in kWh.
- A flow or native adapter can set target temperature for a thermal storage objective.
- Progress, energy, temperature, targets, deadlines, and freshness appear on snapshot/plan
  diagnostics.
- Missing or stale inputs produce `unknown`, not optimistic planning.

Connected 300-style behavior:

- Target is expressed as temperature by deadline.
- Current/target temperature can map to usable stored energy through a thermal profile.
- Mode-dependent max temperature and usable capacity are accounted for.
- Mode override is disabled by default for soft deadlines.
- Hard deadline can request the minimum safe mode when override is explicitly allowed.
- Stepped loads compute `requestedMinimumStepId`.
- Stepped loads still ramp one configured step at a time.
- Objective urgency protects only the requested minimum step.
- If the objective is satisfied, the device does not request power merely because its physical max
  step is high.

EV behavior:

- EV disconnect invalidates effective progress.
- EV reconnect requires a fresh progress report newer than reconnect/session start.
- Stale or invalid EV progress is not used for planning.
- EV planning stays `unknown` when percent is available but capacity, remaining energy, or direct
  remaining-time estimate is missing.

Deadline behavior:

- Status is computed from energy needed, conservative net gain, confidence-adjusted margin, and
  deadline.
- Soft deadline does not bypass effective soft limit, daily budget, priority, cooldowns, or stepped
  rules.
- Hard deadline may bypass effective soft limit and daily budget soft limit.
- Hard deadline never bypasses hard-cap safety.
- Hard objective mode can eventually preserve or create hard-cap-safe headroom for the requested
  minimum step.

Diagnostics and triggers:

- Stable transitions can trigger likely, at-risk, cannot-meet, met, missed, stale, and invalid
  session events.
- Logs/diagnostics include reason codes for unknown, blocked, hard deadline restore, hard deadline
  rebalancing, requested step selection, and requested mode selection.

## Test Plan

Objective evaluator tests:

- percent plus capacity computes `energyNeededKwh`
- missing capacity for percent objective returns `unknown`
- stale progress returns `unknown`
- direct remaining energy computes `energyNeededKwh`
- current/target energy computes `energyNeededKwh`
- target already met returns `likely_to_meet` and `activeMode: none`
- missing charge-rate estimate returns `unknown`
- projected completion before margin returns `likely_to_meet`
- projected completion inside margin returns `at_risk`
- projected completion after deadline at max rate returns `cannot_be_met`
- medium/low confidence increases effective margin

Connected 300-style tests:

- temperature target maps to energy via thermal profile
- mode max below target returns `cannot_be_met` or mode request depending on override setting
- lowest mode that can reach target is requested
- higher mode can be requested only when deadline/rate requires it
- low step is enough returns `requestedMinimumStepId: Low`
- low insufficient and medium enough returns `requestedMinimumStepId: Medium`
- only max enough returns `requestedMinimumStepId: Max`
- no step enough returns `cannot_be_met` and highest allowed step requested
- objective met returns no requested step
- hard mode does not skip configured step progression
- hard mode does not exceed planning power for target step

EV tests:

- EV percent plus capacity computes `energyNeededKwh`
- stale EV progress returns `unknown`
- EV disconnect returns `invalid_session`
- EV reconnect without fresh progress returns `invalid_session` or `unknown`
- direct remaining-time estimate can drive deadline evaluation without capacity

Planner/admission tests:

- soft objective does not bypass effective soft limit
- soft objective does not bypass daily budget soft limit
- hard objective bypasses effective soft limit when hard-cap safe
- hard objective uses `capacitySoftLimitKw` rather than daily-budget-lowered `softLimitKw`
- hard objective is blocked when hard-cap headroom cannot be made safe
- hard objective may keep or shed a lower-priority device to allow requested storage step
- objective urgency protects only `requestedMinimumStepId`
- higher-than-requested step remains opportunistic

Transition/trigger tests:

- stable likely to at-risk emits trigger after hysteresis
- cannot-meet emits immediately or according to chosen rule
- at-risk to likely requires stable recovery period
- target met emits trigger
- deadline missed emits trigger
- stale progress emits trigger
- invalid session emits trigger
