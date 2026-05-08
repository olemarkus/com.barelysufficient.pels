# Deferred Load Objectives

This note defines the intended model for deadline-aware loads. It is design guidance for active and
future implementation work. Some supporting pieces already exist, but deadline objective behavior is
not current shipped actuation behavior.

The first concrete runtime slice is a diagnostics-only EV SoC objective bridge because PELS already
has native SoC snapshots and learned kWh-per-percent profiling. Connected 300-style water-heater
support remains the first concrete thermal target. The abstractions must still serve both without
making the planner EV-percent-centric.

## Current Baseline

As of this note, PELS already has internal/native EV state-of-charge plumbing:

- native EV SoC capabilities can appear on snapshots as `stateOfCharge`
- SoC carries freshness and EV session validity
- stale or invalid SoC is available for diagnostics but must not drive planning
- learned EV objective profiles can supply kWh per 1% SoC
- a versioned settings payload can define diagnostics-only EV SoC objectives
- the diagnostics bridge can read persisted EV SoC objectives and run them through horizon planning
- the bridge is gated on the price feature and requires complete price buckets through the deadline
- no public objective or SoC flow-card UX is exposed yet

Deadline objectives should build on that internal state, not reopen SoC as a user-facing feature
before the broader objective UX is ready.

## Persisted Settings Slice

The first persisted objective format is intentionally narrow and versioned:

```ts
type DeferredObjectiveSettingsV1 = {
  version: 1;
  objectivesByDeviceId: Record<string, {
    enabled: boolean;
    kind: 'ev_soc';
    enforcement: 'soft' | 'hard';
    targetPercent: number;
    deadlineLocalTime: string; // HH:mm in the Homey timezone.
  }>;
};
```

Storage rules:

- Keep configured objective facts in settings and derived planning output out of settings.
- One v1 objective is keyed by device id. Multiple objectives per device require a later schema.
- Invalid or unsupported settings entries are ignored rather than interpreted with defaults.
- `targetPercent` must be above 0 and at or below 100.
- `deadlineLocalTime` is local `HH:mm`. If that time has already passed today, the deadline resolves
  to the next local day.
- `enforcement` records soft or hard intent, but the current bridge only emits diagnostics and does
  not change admission behavior.

The bridge reads this settings payload during plan construction, normalizes it, evaluates each
enabled objective, and emits structured `deferred_objectives` debug diagnostics. It does not expose
Settings UI controls, flow cards, triggers, or device actuation yet.

Price gating is deliberate. The v1 bridge only plans when price optimization is enabled and the
daily-budget price payload covers every hour from now through the objective deadline. If tomorrow's
deadline has been selected because today's `HH:mm` is already in the past, planning may remain
`unknown` with `objective_missing_price_horizon` until tomorrow's prices are available. It must not
fall back to neutral or whole-range planning when the price horizon is incomplete.

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
  requestedStepReasonCode?: ObjectiveReasonCode;

  requestedModeId?: string;
  requestedModeReasonCode?: ObjectiveReasonCode;

  reasonCode?: ObjectiveReasonCode;
};
```

```ts
type ObjectiveRateEstimate = {
  nominalKw: number;
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

Flow-backed objectives are a later exposure layer, not the first public surface. Generic devices
must eventually provide objective data through explicit PELS flow cards, PELS user configuration,
or a purpose-built integration. PELS should not inspect arbitrary app-specific settings for generic
devices.

Future generic inputs may include:

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

These cards should not be exposed until objective planning, diagnostics, and user-facing semantics
are ready enough that the feature can be explained and supported end to end. If a flow later
reports only percent without capacity, remaining energy, or a direct time estimate, PELS may
display the progress but must not produce optimistic deadline planning.

### Native Adapters

Native adapters may use known capability mappings, settings, and device profiles. Native discovery
must be explicit per adapter or device family. Do not scrape arbitrary setting names into generic
planner truth.

Every inferred value must carry provenance such as `capability`, `settings`, `native_profile`,
`user`, `flow`, or `learned`.

Native adapters own device-specific translation. Examples:

- A water-heater adapter can translate temperature and mode into usable stored energy.
- The existing EV SoC snapshot support can become an EV objective input once target/capacity or
  direct remaining-energy semantics exist.
- A future learned model can estimate net gain rate by step or charge rate by SoC band.

## Learned Profiling First

The first implementation step is profiling, not deadline control. PELS should learn compact
per-device conversion and rate facts from observed behavior before it tries to decide whether a
deadline can be met. The EV settings bridge starts from that foundation: it may use learned
kWh-per-percent to calculate required energy, but it remains diagnostics-only until admission and
actuation semantics are implemented.

For temperature devices, the useful learned unit is energy per degree:

```text
kWh per 1 C temperature increase
```

For EVs, the equivalent is energy per percent:

```text
kWh per 1% SoC increase
```

These profiles must be compact and bounded. Store aggregate statistics and the latest accepted
sample per device, not raw history. The profile should carry confidence and provenance, and it
must remain diagnostic until enough valid observations exist to support planner decisions.

Temperature-device profiling should not require tank volume or static thermal capacity. Real
devices may change mode, set temperature, usable capacity, and heat-loss behavior. Until a native
adapter or user setting supplies trusted capacity facts, PELS should learn from observed
temperature changes and credible energy evidence instead.

Credible energy evidence can come from:

- measured device power
- a confirmed stepped-load step with configured planning power, at lower confidence
- native EV charging power/current evidence, where available

Whole-home power and broad controlled-load attribution are not enough by themselves to create
high-confidence per-device energy conversion. If credible energy evidence is missing, PELS may
still learn progress rate such as `C/hour` or `%/hour`, but should not derive `kWh/degree` or
`kWh/%` from it.

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

For Connected 300-style v1 diagnostics, prefer learned energy-per-degree over theoretical tank
volume math. Tank volume based conversion is valid only for a native adapter or explicit user
configuration that owns those assumptions.

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
requestedModeReasonCode?: ObjectiveReasonCode;
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

EV deadline support should use the same objective model but different adapter semantics. Internal
SoC observation already exists; deadline planning is the future layer that adds target, capacity or
remaining-energy semantics, conservative rate, and deadline evaluation.

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

For the first EV objective implementation, actuation should remain pause/resume unless a
stepped/current profile exists. Do not add phase/current control without a separate design and PR.

EV deadline control must distinguish deadline charging from normal managed charging. A deadline
objective may start, resume, or step up charging only while that action is needed to meet the
target. When the target is met, PELS removes the deadline charging request. What happens next
depends on the per-device Power-limit control setting:

- Power-limit control on: normal managed charging may continue after deadline pressure ends. This
  matters when the deadline target is below 100% and the charger would otherwise keep charging;
  PELS may continue to manage it through normal capacity, priority, budget, and price policy.
- Power-limit control off: PELS leaves the charger alone for normal capacity, budget, and price
  work. If the deadline objective was the reason PELS allowed charging, meeting the target removes
  that allowance and PELS should pause charging. It should not restart charging unless a new or
  changed deadline target, boost, or manual/user action asks for it.

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

Soft and hard deadlines are the same objective model with different admission authority. Both may
request the minimum required boost, step, or mode needed to stay on plan.

Deadline authority is separate from per-device Power-limit control. With no active objective,
Power-limit control off means PELS leaves the device alone for normal capacity, budget, and price
work: it should not start, resume, limit, or step the device just because normal policy has budget
or available power. An active deadline objective is an explicit temporary exception for the minimum
action needed to keep the objective on plan. When that objective is met, missed, cleared, stale, or
invalid, the temporary authority ends.

Soft objective means budget-aware boost. It may request boost or step-up behavior, but admission of
that request remains inside normal PELS policy. It must respect:

- effective soft limit
- daily budget soft limit
- device priority
- restore cooldowns
- one-restore-at-a-time behavior
- stepped-load progression
- stale power failsafe
- pending command confirmation and backoff
- existing safety/freshness rules

Soft objective can use existing boost behavior. If that behavior sheds lower-priority devices to
make room for a step-up, the objective may benefit from it. Soft objective must not shed a
higher-priority device solely to meet the deadline.

Hard objective means deadline-first boost. It may request the same minimum required boost, step, or
mode as soft objective, but can use stronger admission rules when the deadline is at risk. It may
bypass:

- daily budget blocking
- effective soft-limit blocking
- normal priority ordering, if a future hard-boost lane explicitly allows shedding higher-priority
  eligible devices

It must still respect:

- hard capacity cap and margin
- live power freshness failsafe
- device availability
- actuator capability
- EV connected/resumable state
- stepped-load progression
- pending-command confirmation and backoff
- stale power failsafe

Hard deadline admission should use margin-adjusted capacity-soft-limit headroom:

```ts
hardObjectiveAdmissionHeadroomKw = capacitySoftLimitKw - totalKw;
```

not the effective `softLimitKw` when daily budget has lowered it. Do not confuse this with the
existing physical `hardCapHeadroomKw` concept, which is based on the absolute hard limit rather
than the margin-adjusted capacity soft limit.

Long term, hard objective mode may create hard-cap-safe headroom by rebalancing flexible devices.
That rebalancing must:

- protect only `requestedMinimumStepId`
- preserve hard capacity safety
- prefer keeping devices active where possible
- shed or keep shed eligible flexible devices when needed
- avoid shedding devices protected by equal or higher hard objectives
- drop back once the objective is safe again
- never skip configured stepped-load progression

Hard objective is not a whole-home energy cap. The target remains device readiness:

```text
device X should reach state Y by time Z
```

The hard-mode difference is that budget and normal priority policy may yield to the device
deadline. The hard capacity cap never yields.

## Planning Horizon and Milestones

Every deferred objective creates a planning horizon:

```text
now -> deadline
```

Within that horizon, PELS should try to place the required useful energy in the best available
windows while preserving enough margin to meet the deadline.

For soft objectives, "best" means normal PELS policy: daily budget state, expected price/budget
pressure, device priority, and existing boost rules. Price is not a separate primitive here; it
enters through the budget/price policy PELS already uses to decide when spending energy is
acceptable. Soft objective should prefer cheap or budget-friendly windows when that does not create
deadline risk.

For hard objectives, the same horizon exists, but deadline feasibility outranks budget and normal
priority policy. Hard objective should still prefer cheaper or budget-friendly windows when there
is enough margin, but it should not miss the deadline merely because the remaining feasible window
is expensive.

Priority should affect horizon planning through admission risk, not by directly rewriting price
ordering. A lower-priority device may be blocked by higher-priority managed devices during otherwise
cheap windows, so those windows should count as less dependable for soft objectives. The planner can
model that by reducing usable bucket capacity, increasing deadline reserve, or widening the number
of candidate hours before the deadline. A higher-priority device can use more of its configured
step capacity as dependable energy, while a lower-priority device should need more time or more
margin to be considered on track.

This risk adjustment is still a planning estimate. Actual admission remains a runtime decision made
by normal PELS policy for soft objectives and by the hard-objective admission lane for hard
objectives. If the current bucket's requested minimum step is blocked, the next evaluations should
consume deadline margin, replan remaining energy, and eventually move the objective toward
`at_risk` or `cannot_be_met`.

The horizon plan should produce derived milestones. Milestones should be energy-based where
possible, not arbitrary wall-clock percentages:

```text
by 01:00: planned useful energy added >= 0.5 kWh
by 03:00: planned useful energy added >= 1.0 kWh
by 05:00: planned useful energy added >= 4.5 kWh
by 07:00: planned useful energy added >= 6.0 kWh
```

This allows soft mode to intentionally wait through expensive periods without being falsely marked
behind, while still detecting when the plan has fallen behind enough to request a higher step.

For v1, the horizon scheduler can be conservative and simple:

1. Build coarse time buckets from now to the deadline.
2. Estimate useful energy available per bucket for each configured step.
3. Prefer buckets that normal policy already considers cheap or budget-friendly.
4. Keep a confidence margin or fallback reserve near the end.
5. Output the requested minimum step for the current bucket.
6. Recompute on every relevant plan cycle.

Required-average kW remains useful as a diagnostic, but horizon scheduling is the mechanism that
makes soft objectives budget-aware instead of just "boost immediately."

## Logging and Diagnostics

Add a separate debug topic for deferred objectives before exposing a broad UI. The topic should
allow detailed objective logging without making normal runtime logs noisy.

Suggested topic:

```ts
deferred_objectives
```

Use structured logs with stable field names. Logs should make it possible to answer:

- What target is this device trying to reach?
- What horizon was evaluated?
- Which energy buckets or milestones were planned?
- Is the device on track, at risk, or impossible to finish?
- What step/mode is being requested now, and why?
- Did the device reach the target?
- Did stale/missing input prevent planning?

Initial log events:

- `deferred_objective_evaluated`
- `deferred_objective_horizon_planned`
- `deferred_objective_milestone_status`
- `deferred_objective_step_requested`
- `deferred_objective_mode_requested`
- `deferred_objective_goal_met`
- `deferred_objective_deadline_missed`
- `deferred_objective_unknown`

The current settings-backed EV bridge emits `deferred_objective_horizon_planned` when a horizon plan
can be built and `deferred_objective_unknown` when required inputs are missing, stale, invalid, or
price-gated. Later planner integration can add milestone, step request, target met, and deadline
missed lifecycle events once objectives can affect device behavior.

Useful fields:

- `deviceId`
- `deviceName`
- `objectiveKind`
- `activeMode`
- `status`
- `stableStatus`
- `reasonCode`
- `targetTemperatureC`
- `targetPercent`
- `targetEnergyKwh`
- `currentEnergyKwh`
- `energyNeededKWh`
- `kWhPerPercent`
- `deadlineAtMs`
- `deadlineLocalTime`
- `deadlineRollsToNextDay`
- `horizonStartMs`
- `horizonEndMs`
- `horizonBucketCount`
- `currentBucketStartMs`
- `currentBucketEndMs`
- `plannedEnergyByNowKwh`
- `actualEnergyByNowKwh`
- `plannedEnergyAtDeadlineKwh`
- `requiredAverageKw`
- `conservativeNetGainKw`
- `rateConfidence`
- `deadlineMarginMs`
- `projectedCompletionAtMs`
- `requestedMinimumStepId`
- `requestedModeId`
- `milestoneStatus`

Log the full bucket plan only when the debug topic is enabled. Normal structured info logs should
be limited to lifecycle events such as target met, deadline missed, or a stable transition to
`at_risk`/`cannot_be_met`.

Goal achievement should be explicit and deduplicated. Once an objective crosses its target, emit a
single `deferred_objective_goal_met` event for that objective instance with the achieved state,
target, and deadline. If the deadline passes before the target is reached, emit
`deferred_objective_deadline_missed` with the final measured state and reason code.

## Planner Integration

Add an objective evaluator before restore/shed planning.

Inputs:

- device snapshots
- objective state
- current time
- totalKw and freshness
- capacity soft limit
- effective soft limit
- hard objective admission headroom
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

## Implementation Shape

This should be phased. The first settings-backed slice is EV SoC diagnostics. The first thermal
implementation target remains Connected 300-style thermal storage, not a generic public flow-card
objective surface.

Current implementation slice:

1. Learned objective profiling exists before deadline control.
2. EV SoC objectives can be read from versioned settings.
3. EV SoC settings objectives resolve a local `HH:mm` deadline, rolling to tomorrow when needed.
4. Planning is diagnostics-only and price-feature gated.
5. A next-day rolled deadline waits for tomorrow price buckets instead of assuming neutral prices.
6. The bridge emits structured debug diagnostics without changing restore/admission behavior.

Recommended implementation order:

1. Add generic objective state/evaluation types and pure evaluator tests.
2. Add the settings-backed EV SoC diagnostics bridge that exercises the horizon scheduler without
   flow cards or actuation.
3. Add Connected 300-oriented thermal objective support using stepped-load profiles, temperature
   input, target temperature, mode constraints, and requested minimum step.
4. Add freshness rules for thermal objective inputs.
5. Add a simple horizon scheduler that can place required energy in budget-friendly buckets and
   emit current-bucket milestones.
6. Surface objective diagnostics and reason codes without a full Settings editor.
7. Integrate soft objective through existing boost/step-up behavior while preserving normal budget
   and priority policy.
8. Add hard admission for already available hard objective admission capacity.
9. Add hard-boost rebalancing as a follow-up if it touches limit planning deeply.
10. Expose public flow-backed objective cards only after the planner behavior and UX contract are
   ready.

The first Connected 300 implementation should focus on temperature-by-deadline UX, thermal energy
mapping, per-step rate estimates, requested minimum step selection, and diagnostics.

Out of scope unless explicitly included:

- automatic EV/car polling
- full settings UI editor
- calendar/recurrence UI
- EV current or phase control
- automatic battery capacity learning
- thermal temperature-to-energy learning
- charge curves by SoC band
- public generic objective flow cards
- multi-device global optimization across objectives

## Acceptance Criteria

Core objective v1:

- Objective state and evaluation are separate types or modules.
- A native or semi-native adapter can set target temperature for a thermal storage objective.
- Progress, energy, temperature, targets, deadlines, and freshness appear on snapshot/plan
  diagnostics.
- Missing or stale inputs produce `unknown`, not optimistic planning.
- Public flow cards are not required for v1.

Connected 300-style behavior:

- Target is expressed as temperature by deadline.
- Current/target temperature can map to usable stored energy through a thermal profile.
- Mode-dependent max temperature and usable capacity are accounted for.
- Mode override is disabled by default for soft deadlines.
- Hard deadline can request the minimum safe mode when override is explicitly allowed.
- The horizon scheduler can choose budget-friendly buckets while maintaining deadline margin.
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
- When the EV deadline target is met, PELS removes the deadline charging request.
- If Power-limit control is on, normal managed charging may continue after the deadline target is
  met, especially when the target is below 100%.
- If Power-limit control is off, meeting the deadline target pauses charging if the objective was
  the reason PELS allowed charging and no new deadline target, boost, or manual action grants
  authority.

Deadline behavior:

- Status is computed from energy needed, conservative net gain, confidence-adjusted margin, and
  deadline.
- Power-limit control off leaves the device alone for normal capacity, budget, and price work
  unless an active objective grants temporary deadline authority.
- Soft deadline may request boost/step-up, but does not bypass effective soft limit, daily budget,
  priority, cooldowns, or stepped rules.
- Hard deadline may bypass effective soft limit and daily budget soft limit.
- Hard deadline never bypasses hard-cap safety.
- Hard objective mode can eventually preserve or create hard-cap-safe headroom for the requested
  minimum step.
- Hard objective may eventually use a hard-boost lane that can shed higher-priority eligible
  devices, but only when needed for the protected minimum step.

Diagnostics and triggers:

- Stable transitions can trigger likely, at-risk, cannot-meet, met, missed, stale, and invalid
  session events.
- Logs/diagnostics include reason codes for unknown, blocked, hard deadline restore, hard deadline
  rebalancing, requested step selection, and requested mode selection.
- A dedicated deferred-objectives debug topic exposes horizon buckets, milestones, goal
  achievement, and risk evaluation details without noisy default logs.

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
- horizon plan prefers budget-friendly buckets while maintaining deadline margin
- horizon milestones allow intentional delay without marking the objective behind

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
- soft objective requests boost through normal stepped-load policy
- hard objective protects only the minimum requested step, not max

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
- hard objective is blocked when hard objective admission headroom cannot be made safe
- hard objective may keep or shed a lower-priority device to allow requested storage step
- hard objective can use hard-boost policy to shed a higher-priority eligible device when
  explicitly allowed
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
