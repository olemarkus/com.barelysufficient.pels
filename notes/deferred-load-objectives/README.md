# Deferred Load Objectives

This note defines the intended model for deadline-aware loads. It is design guidance for active and
future implementation work. The soft temperature slice is current shipped behavior: PELS can plan
deadline hours, make cap-off temperature devices visible during planned hours, keep them idle
outside planned hours, and raise the planned setpoint to the deadline target while still respecting
normal budget, capacity, priority, cooldown, and admission gates. EV pause/resume admission and
actuation are also shipped (`admission.ts` emits `ev_resume`/`ev_pause` intents;
`lib/executor/binaryExecutor.ts` applies them) — see `notes/ev-ready-by/README.md` for the user-
facing slice. Multi-objective contention and richer step escalation remain future work in this
note. Hard deadlines and
hard-boost rebalancing are deferred and moved to
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md); energy-based milestones and the
priority-adjusted horizon-planning detail are deferred and moved to
[`notes/planning-horizon-milestones/README.md`](../planning-horizon-milestones/README.md).

The first concrete runtime slice started as a diagnostics-only EV SoC objective bridge because PELS
already had native SoC snapshots and learned kWh-per-percent profiling. Connected 300-style
water-heater support adds the same settings and horizon-planning path for temperature objectives
using learned kWh per degree. The abstractions must serve both without making the planner
EV-percent-centric.

## Current Baseline

As of this note, PELS already has internal/native EV state-of-charge plumbing:

- native EV SoC capabilities can appear on snapshots as `stateOfCharge`
- SoC carries freshness and EV session validity
- stale or invalid SoC is available for diagnostics but must not drive planning
- learned EV objective profiles can supply kWh per 1% SoC
- learned temperature objective profiles can supply kWh per 1 C
- a versioned settings payload can define soft EV SoC or temperature objectives
- the diagnostics bridge can read persisted EV SoC and temperature objectives and run them through horizon planning
- the bridge is gated on the price feature and requires complete price buckets through the deadline
- public flow cards expose deadline creation, clearing, status conditions, and status-change /
  missed-deadline triggers; the earlier device-detail Settings UI card has been removed in favor of
  the flow-card surface (see `docs/flow-cards.md`)
- a status bus inside the bridge publishes status transitions and missed-deadline events that the
  flow trigger cards subscribe to
- soft temperature objectives participate in planner admission: planned hours admit the device,
  idle hours keep cap-off devices off, and planned temperature targets are lifted to the deadline
  target

Deadline objectives should build on that internal state, not reopen SoC as a user-facing feature
before the broader objective UX is ready.

## Persisted Settings Slice

The persisted objective format is one-shot and datetime-bound:

```ts
type DeferredObjectiveSettingsV1 = {
  version: 1;
  objectivesByDeviceId: Record<string, (
    {
      enabled: boolean;
      kind: 'ev_soc';
      enforcement: 'soft' | 'hard';
      targetPercent: number;
      deadlineAtMs: number; // absolute UTC timestamp
    }
    | {
      enabled: boolean;
      kind: 'temperature';
      enforcement: 'soft';
      targetTemperatureC: number;
      deadlineAtMs: number; // absolute UTC timestamp
    }
  )>;
};
```

Storage rules:

- Keep configured objective facts in settings and derived planning output out of settings.
- One v1 objective is keyed by device id. Multiple objectives per device require a later schema.
- Invalid or unsupported settings entries are ignored rather than interpreted with defaults.
- `targetPercent` must be at least 1 and at or below 100 (the EV flow card enforces this range;
  the contract normalizer rejects sub-1% values).
- `targetTemperatureC` must be finite and within the bounded settings range. The Settings UI should
  further constrain it to the device target capability range when that range is available.
- Clearing a deadline for a device that has no objective is a safe no-op: `removeObjective`
  returns settings unchanged, the status bus's `forgetDevice` and the trigger-suppression cache
  delete both no-op cleanly.
- `deadlineAtMs` is an absolute UTC timestamp. Flow cards take a `HH:mm` local-time argument and
  resolve it to the next future local moment **once at write time**; the persisted value never
  rolls forward on its own. When the deadline passes, the runtime auto-disables the entry
  (`enabled: false`) via the `deadlineJustPassed` hook in `statusTransitions.ts` so the same
  deadline never replans for the next day. Users re-arm by firing the flow card again.
- Temperature objectives are soft-only for now. The Settings UI must not expose hard temperature
  deadlines until runtime semantics are explicitly designed.
- `enforcement` is persisted on EV entries (`'soft' | 'hard'`), but only `'soft'` has runtime
  effect today and the EV flow card hardcodes `'soft'`. Hard enforcement is deferred — see
  [`notes/hard-deadlines/README.md`](../hard-deadlines/README.md) for the design.

The bridge reads this settings payload during plan construction, normalizes it, evaluates each
enabled objective, and emits structured `deferred_objectives` debug diagnostics. The bridge also
publishes status transitions and deadline-missed events to an in-process status bus that flow
trigger and condition cards subscribe to. Public flow cards are the user-facing surface for
creating and clearing deadlines. For soft temperature objectives, the planner uses the evaluation
to decide planned/idle participation and deadline target overrides.

Price gating is deliberate. The bridge only plans when price optimization is enabled and the
daily-budget price payload covers every hour from now through the objective deadline. If the
deadline is far enough in the future that tomorrow's prices are required, planning may remain
`unknown` with `objective_missing_price_horizon` until those prices are available. It must not
fall back to neutral or whole-range planning when the price horizon is incomplete.

That gate applies only while the objective still needs future energy. When fresh EV SoC or
temperature progress already meets the target, the bridge emits `satisfied` before price or
horizon gating because no future allocation is needed. `satisfied` remains a live evaluation,
not a terminal completion before the deadline: if a later fresh reading drops below the target,
the next cycle returns to normal deadline tracking.

## Soft Temperature Runtime Semantics

The first temperature UI stores the objective and lets horizon planning calculate planned hours.
Runtime actuation for the cap-off case is now wired in `lib/plan/deferredObjectives/admission.ts`
and applied at the planner boundary in `PlanBuilder.buildPlanSnapshotWithTimings`:

- The horizon planner computes the planned hours per cycle.
- For each enabled objective whose status is `on_track`, `at_risk`, or `cannot_meet`, an admission
  decision is produced: `planned` for the current bucket if it has planned energy, `idle`
  otherwise. `satisfied`, `unknown`, and `invalid` resolve to `inactive` so the device returns to
  its normal behavior once the goal is met or the objective cannot be trusted.
- Capacity-based control on/off is treated purely as device visibility for the planner: cap-on
  devices are always managed; cap-off devices are normally invisible to PELS (an externally
  toggled cap-off device runs undisturbed). When a cap-off device has a non-inactive deferred
  decision the planner makes it visible for that cycle by setting `controllable=true` on the
  input device. For idle decisions the planner also seeds the device into the shedding shed-set
  so the shedding lane keeps it off.
- Once a device is admitted, the shedding and restore lanes act on it with their normal logic
  and produce their normal reasons (cooldowns, restore-pending, capacity, etc.). The deferred
  plan does not override step selection, admission gates, or reason codes — it only decides
  whether the device participates this cycle. Soft deadlines therefore still respect budget,
  capacity, priority, and cooldown rules, exactly as the original design called for.
- During planned hours of an active deferred temperature objective, the planner commands
  `max(modeTarget + priceOptDelta, deadlineTargetC)` to the device so the device's own
  thermostat can actually reach the deadline. The price-opt cheap/expensive delta combines only
  with the mode side; the deadline target is never further modulated. Outside planned hours, or
  once the diagnostic transitions to `satisfied`/`cannot_meet`, the override drops out and the
  setpoint reverts to the regular mode target. The override applies regardless of the
  capacity-based control toggle (cap-on and cap-off devices both pick it up).
  Implementation: `buildDeferredTargetOverrides` in `lib/plan/deferredObjectives/admission.ts`
  derives the per-cycle map from `deferredEvaluations`; `resolvePlannedTarget` in
  `lib/plan/planDevices.ts` consumes it after applying the price-opt delta and before the
  capability clip. Capacity-based shedding (`set_temperature` shed action) still wins because
  `buildBasePlanDevice` overwrites `plannedTarget` with the shed temperature when the device is
  in the shed-set.

Cap-on temperature admission and contention across multiple deferred objectives are still future
work. EV pause/resume admission shipped — see `notes/ev-ready-by/README.md`. Hard deadlines and
hard-boost rebalancing are deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

EV admission has one additional safety gate beyond the temperature path: `ev_resume` intents
are dropped by `planBuilder.attachDeferredEvCommandIntents` when
`context.powerFreshnessState !== 'fresh'`. Stale whole-home power readings can't justify
restoring an EV charger — the gate is one-way (pause is always safe and isn't gated).

### Active plan persistence and replan policy

`lib/plan/deferredObjectives/activePlanRecorder.ts` stores the *current* deadline-plan
allocation per device alongside the outcome history described below. Where the history
recorder captures sealed outcomes (met/missed/abandoned), the active-plan recorder
captures the plan that is *being executed right now* so the Settings UI and any
downstream consumer reads a stable allocation rather than re-deriving one on every load.

Persisted shape (`deferred_objective_active_plans` settings key, V1):

```ts
type ActivePlan = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  startedAtMs: number;
  pending: boolean;            // flow card fired, no revision yet
  pendingReason?: 'awaiting_horizon_plan' | 'price_feature_disabled' | 'device_data_missing';
  objectiveSignature: string;  // hash of (kind, targets, deadline, enforcement)
  original: Revision | null;   // first non-pending revision
  latest:   Revision | null;   // current revision (== original until replanned)
};

type Revision = {
  revision: number;
  revisedAtMs: number;
  computedFromPricesUpTo: number | null;
  reason: 'flow_card' | 'prices_arrived' | 'objective_changed'
        | 'prices_revised' | 'rate_refined' | 'device_unavailable'
        | 'measured_deviation';
  hours: { startsAtMs: number; plannedKWh: number }[];
  energyNeededKWh: number;
  planStatus: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied';
  kwhPerUnitSource?: 'learned' | 'bootstrap';
};
```

The recorder is fed two events: `markPending` (called from the
`set_temperature_deadline` / `set_ev_charge_deadline` flow cards) and `observe` (called
once per plan cycle with the diagnostic stream, alongside the history recorder).

#### Replan policy

The recorder treats the per-cycle horizon plan as advisory and only writes a new
revision on these triggers:

1. **`flow_card`** — A deadline flow card fires. If prices for the horizon are already
   available, the next plan cycle stamps `original` + `latest`. Otherwise the record is
   created with `pending: true` until the next trigger fires.
2. **`prices_arrived`** — `pending` flips to false because the planner produced its
   first horizon plan. Stamps `original` + `latest`.
3. **`objective_changed`** — The objective signature (kind, target value, deadline
   timestamp, enforcement) differs from the stored signature, mid-flight. Replaces
   `latest`; `original` is preserved unless the deadline timestamp itself changed.
4. **`prices_revised`** — The hour signature of the planner's allocation differs from
   the stored `latest.hours` while the objective signature is unchanged. (The most
   common cause is Nordpool publishing a revised series that shifts which hours are
   cheapest.) Replaces `latest`. The user-facing `deadline_plan_changed` flow trigger
   is gated further: it only fires when the *number* of planned hours changes and the
   new schedule is non-empty. Same-count hour swaps still persist a revision (Settings
   UI needs fresh metadata) but stay quiet on the flow bus, and empty schedules
   (satisfied / cannot_meet / invalid) are surfaced via `deadline_status_changed`
   instead, since the plan-changed notification template needs `projectedFinishAtMs`
   to render.
5. **`rate_refined`** — A learned kWh-per-unit value replaces a conservative bootstrap fallback,
   or otherwise changes the energy basis enough to produce a different stable allocation.
6. **`device_unavailable`** — The diagnostic stops appearing for an extended period
   while the deadline is still in the future. Tracked for future use; today the
   recorder simply drops the record once a diagnostic disappears, matching the
   history recorder's abandon path.
7. **`measured_deviation`** — Reserved for the future per-device metering work. Not
   yet emitted.

A normal plan cycle whose output happens to match the stored `latest.hours` does **not**
mutate the record. This is what makes the plan stable: the runtime can re-evaluate every
cycle, but only listed triggers produce a new revision.

Records are dropped automatically when:
- The deadline passes (the history recorder records the outcome from its own observation).
- The diagnostic stops appearing for the device (objective was disabled, device removed,
  evaluator dropped to unknown indefinitely).

The Settings UI bootstrap (`SettingsUiBootstrap.deferredObjectiveActivePlans`) reads the
recorder snapshot directly rather than re-allocating from prices on every page load. The
deadline-plan page renders a *pending* hero state when `pending: true` and a *ready* hero
plus chart when `latest` is populated.

### Plan history capture

`lib/plan/deferredObjectives/planHistory.ts` runs alongside the diagnostics evaluator to
capture per-(device, deadline) outcomes for the Past tasks list on the Smart tasks tab and
for the per-entry detail view at the `?page=deadline-plan&historyId=…` SPA route inside
`index.html`. (The standalone `deadline-plan.html` sub-page was removed because the Homey
mobile WebView does not inject the Homey SDK on sub-pages; the deadline-plan view now lives
as an in-page route off `index.html`.):

- The recorder observes the diagnostic stream once per plan cycle. It starts an in-progress
  record on the first plannable diagnostic for a `(deviceId, deadlineAtMs)` pair, refreshes
  progress + planning flags each cycle, and stamps `metAtMs` while the status is `satisfied`.
  If progress drops below the target again before the deadline, the recorder clears that live
  satisfied marker and continues tracking; a later recovered `satisfied` status stamps the later
  met time.
- A run is finalized as `met` when the latest trustworthy progress at finalization is at or
  above the target, `missed` when the deadline passed below target, `abandoned` when the user
  clears the objective (or when the diagnostic stops appearing for >1 hour with the deadline
  still in the future), `replaced` when the user picks a new deadline or changes the target
  value on the same deadline, and `unknown` when there's not enough fresh input to classify.
  These stored outcome names are internal compatibility values. Public Settings UI labels
  expose `met` as `Succeeded`, `missed` as `Missed`, and user-clear/replacement/disappear
  outcomes as `Abandoned`.
- Flow card writes route through `applyDeferredObjectiveChange`
  (`lib/plan/deferredObjectives/objectiveChange.ts`) so a user-initiated replace or clear
  finalizes the prior in-progress run immediately rather than waiting for the abandon-grace
  window. The runtime auto-disable path (`statusTransitions.deadlineJustPassed`) stays on
  the `deadline_passed` classification — only user-initiated changes produce `replaced` or
  the prompt `abandoned`.
- Same-deadline target changes finalize the prior history entry as `replaced` and start a
  fresh entry. The active-plan recorder is intentionally asymmetric here: it keeps a single
  record across the change and writes an `objective_changed` revision, because the hero is a
  live view of intent while history is an audit trail with one stable target per entry.
- Entries are persisted to `deferred_objective_plan_history` with a 30-entry rolling cap.
  Throttled writes happen on finalize (rare); `onUninit` flushes any pending entries.
- The Settings UI fetches this via `/ui_deferred_objective_history` and renders
  per-device cards in the History tab next to the existing current-plan view.

End-of-run events for smart tasks are surfaced via the unified `deadline_ended` flow trigger,
published by the plan history recorder at finalization. The trigger carries an `outcome` arg
(`succeeded` / `missed` / `abandoned`) and corresponding tokens (target text, deadline local time,
finished-at local time when succeeded, shortfall text when missed). `replaced` (user changed the
deadline) and `unknown` (PELS never observed enough to classify) outcomes are intentionally
suppressed — they do not fire the trigger. Backfill entries reconstructed from settings after a
PELS-off window also stay quiet so users do not receive retroactive notifications.

Original design semantics (still authoritative for future slices):

- Planned hours are the hours selected by the deadline plan to add useful energy before the
  deadline.
- Inside planned hours, the device uses normal PELS behavior for shed/restore admission, cooldowns,
  budget, and priority. The one exception is the temperature setpoint: the planner lifts the
  commanded target to `max(modeTarget + priceOptDelta, deadlineTargetC)` so the device's own
  thermostat can actually reach the deadline. The deadline target is never further adjusted by the
  price-opt delta.
- Outside planned hours, the existing capacity-based control toggle decides the fallback behavior:
  - toggle on: normal PELS behavior may still run the device outside the deadline plan
  - toggle off: PELS keeps the device idle by plan outside the deadline plan **(shipped)**
- Soft deadlines should still respect budget and capacity planning. Soft means the objective is not
  a separate hard-safety override; it does not mean PELS may ignore the deadline as the normal path.
- Priority affects planning risk and normal PELS decisions, not whether the deadline card stores a
  temperature target.

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

> **Note:** the types below are forward-design types capturing the eventual planner contract.
> The shipped persisted shape is `DeferredObjectiveSettingsV1` (see §"Persisted Settings Slice")
> and the shipped evaluation type is `DeferredObjectiveDiagnostic` in
> `lib/plan/deferredObjectives/diagnosticsBridge.ts`. Fields below that don't appear on the
> shipped types (e.g. `stableStatus`, `requiredAverageKw`, `conservativeNetGainKw`) are
> aspirational and may never ship as named. Mode-related fields have moved with the deferred
> mode-override design to [`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

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

  activeMode: 'none' | 'soft';
  progressStatus: 'unknown' | 'fresh' | 'stale' | 'invalid_session';

  energyNeededKwh?: number;
  requiredAverageKw?: number;
  conservativeNetGainKw?: number;
  projectedCompletionAtMs?: number;

  rateEstimate?: ObjectiveRateEstimate;

  requestedMinimumStepId?: string;
  requestedStepReasonCode?: ObjectiveReasonCode;

  reasonCode?: ObjectiveReasonCode;
};
```

Mode-related request fields (`requestedModeId`, `requestedModeReasonCode`) live with the
deferred mode-override design in
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md) §"Mode override".

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
deadline can be met. The EV settings bridge started from that foundation: it uses learned
kWh-per-percent to calculate required energy. EV admission and pause/resume actuation have since
shipped (see `notes/ev-ready-by/README.md`).

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

Shipped v1 uses a learned `kWhPerUnit` (kWh per 1°C) multiplied by the remaining `ΔT` to derive
`energyNeededKWh`. The profile learns from observed temperature rises with credible energy
evidence (`lib/core/objectiveProfiles.ts`). There is no anchored "baseline temperature" in the
shipped path — the profile is unit-rate based and `ΔT` carries the rest:

```ts
energyNeededKwh = Math.max(0, kWhPerUnit.mean * (targetTemperatureC - currentTemperatureC));
```

This is intentionally simpler than the tank-volume / baseline-temperature math required for
explicit usable-stored-energy modeling. The baseline-anchored design below is preserved as
future direction for a native adapter that owns trusted capacity facts (e.g. reports stored
energy directly or carries a reserve baseline).

#### Future native-adapter design (not the v1 path)

For thermal storage, `currentEnergyKwh` *would* mean usable stored energy relative to an
adapter-defined baseline rather than vague total heat content. A native adapter could compute:

```ts
currentEnergyKwh = energyBetween(baselineTemperatureC, measuredTemperatureC);
targetEnergyKwh = energyBetween(baselineTemperatureC, targetTemperatureC);
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);
```

The baseline would need to be explicit in the adapter/profile (minimum useful temperature,
reserve temperature, or another device-specific comfort/safety baseline). When a device reports
stored energy directly, prefer that over a temperature-derived estimate. Temperature can still
be used for UX, diagnostics, and fallback mapping. None of this ships today.

### Mode-dependent capacity and mode override

Deferred — see [`notes/hard-deadlines/README.md`](../hard-deadlines/README.md)
§"Mode override (water heaters and similar)" for the design (mode-aware
capacity, override rules, request fields). The shipped runtime has no
mode-change path.

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
  changed deadline target, boost, or manual/user action asks for it. Implementation:
  `applyDeferredObjectiveAdmission` (`lib/plan/deferredObjectives/admission.ts`) emits a terminal
  `ev_pause` for `satisfied + ev_soc + controllable=false`. The `planExecutor` cap-off branch
  routes that intent through `applyDeferredEvCommand`; the executor short-circuits when the
  charger is already paused, so per-cycle re-emission is idempotent.

## Energy Calculation

Shipped v1 uses a single path:

```ts
energyNeededKwh = Math.max(0, kWhPerUnit.mean * remainingUnits);
```

where `remainingUnits` is `(targetTemperatureC - currentTemperatureC)` for thermal or
`(targetPercent - currentPercent)` for EV. The `kWhPerUnit` value comes from the learned
profile, or for EV from the conservative bootstrap (`BOOTSTRAP_EV_SOC_KWH_PER_PERCENT = 1.0`)
until learning matures. Source: `lib/plan/deferredObjectives/profileEnergyResolution.ts`.

Available time:

```ts
availableHours = Math.max(0, (deadlineAtMs - nowMs) / 3_600_000);
requiredAverageKw = energyNeededKwh / availableHours;
```

If `energyNeededKwh <= 0`, the objective is met (status `satisfied` via `energy_already_met`).

Missing, stale, invalid, or impossible inputs produce `unknown` or `cannot_meet`, never
optimistic planning.

#### Future input modes (not the v1 path)

A more general objective model could accept any of these inputs and route through the same
planner. These remain forward-design and are not exercised today:

```ts
// Direct remaining energy:
energyNeededKwh = Math.max(0, remainingEnergyKwh);

// Current and target energy:
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);

// Percent and capacity:
remainingPercent = Math.max(0, targetPercent - progressPercent);
energyNeededKwh = remainingPercent / 100 * capacityKwh;

// Temperature and thermal profile (baseline-anchored — see §"Thermal Energy Semantics" future
// section):
currentEnergyKwh = energyBetween(baselineTemperatureC, measuredTemperatureC);
targetEnergyKwh = energyBetween(baselineTemperatureC, targetTemperatureC);
energyNeededKwh = Math.max(0, targetEnergyKwh - currentEnergyKwh);
```

## Conservative Net Rate

Deadline feasibility is based on conservative net useful-energy gain, not raw electrical
input.

For water heaters, useful stored energy can fall while the element is on because of heat loss or
hot-water use. For EVs, charging may taper near high SoC; AC home charging is often
charger-limited and close to flat for much of the session, but a flat rate to 100% can still be
optimistic.

Shipped v1 uses one rate source plus EV bootstrap fallback:

1. Learned `kWhPerUnit` profile (`lib/core/objectiveProfiles.ts`), or
2. For EV without a learned profile: `BOOTSTRAP_EV_SOC_KWH_PER_PERCENT = 1.0`
   (`packages/shared-domain/src/objectiveProfileBootstrap.ts`). The recorder emits a
   `rate_refined` revision when learning takes over.
3. Otherwise → `objective_missing_capacity` (thermal) or `objective_missing_charge_rate` (no
   step profile) status `unknown`; no optimistic planning.

For stepped loads, per-step useful kW comes from `resolveStepDeliveryUsefulKw`
(`lib/plan/deferredObjectives/objectiveStepPower.ts`), which prefers measured calibration
(`lib/observer/devicePowerCalibration.ts`) over nameplate planning power. That governs how the
horizon planner sizes bucket allocation, not the `energyNeededKwh` computation itself.

#### Future rate-source preference (not the v1 path)

The original design enumerated a five-tier preference order. None of tiers 1, 3, 4 ship today:

1. Fresh direct remaining-time estimate.
2. Learned net gain or session average, derated.
3. Configured planning power or native profile, derated.
4. Fresh current measured charging power, only if it is a reasonable forecast for the current
   device state.
5. Unknown.

Do not treat circuit maximum as sufficient for `on_track` unless a native adapter/profile can
prove it is a conservative planning estimate.

For stepped loads, the design intent is to evaluate each candidate step independently:

```ts
projectedCompletionAtMs =
  nowMs + (energyNeededKwh / conservativeStepNetGainKw) * 3_600_000;
```

## Status Semantics

The shipped status values on the diagnostic
(`lib/plan/deferredObjectives/diagnosticsBridge.ts`):

- `unknown` — required inputs are missing, stale, invalid, or impossible to evaluate.
- `on_track` — the plan fits entirely before the deadline minus a 1-hour reserve (the
  planner's safety buffer); every earlier hour has enough headroom to land the required
  energy.
- `at_risk` — the planner has dipped into the reserved final hour to land the required
  energy (every earlier hour is fully booked at planning power), or the plan relies on
  policy-avoid hours to land.
- `cannot_meet` — even using the reserve hour at the highest allowed hard-cap-safe
  behavior cannot plausibly meet the target before the deadline. (`hard-cap-safe` here
  means within the physical capacity hard cap.)
- `satisfied` — current progress is at or above target. Live; if a later reading drops below
  target, the next cycle returns to one of the values above.

Status transitions today fire immediately on change (no hysteresis); the flow trigger bus
suppresses same-status re-fires. The shipped `deadlineMarginMs = 1 hour` is a flat reserve,
not confidence-scaled. Deadlines closer than the reserve window collapse to a fully-reserve
horizon: any allocation reads as `at_risk` (or `cannot_meet` if the energy still doesn't
fit), never `on_track`.

An internal `'invalid'` value exists on `DeferredObjectiveHorizonStatus` and the bus snapshot
type (`statusBus.ts`), produced by the horizon planner when a precondition fails inside the
planning step. `diagnosticsBridge` collapses `'invalid'` to `'unknown'` before it reaches the
flow surface — user-facing status is always one of the five above. The internal value is
retained for runtime branching only; tightening the bus type to `Exclude<…, 'invalid'>` is
possible but cosmetic.

Hysteresis and confidence-scaled margin are deferred — see
[`notes/status-hysteresis/README.md`](../status-hysteresis/README.md). Picked up only if real
telemetry shows user-observable status flapping.

## Soft and Hard Deadlines

Soft enforcement is shipped v1 and respects normal PELS policy (effective soft limit, daily
budget, priority, cooldowns, stepped progression, safety failsafes). Soft objective can use
existing boost behavior; it must not shed a higher-priority device solely to meet the deadline.

Hard enforcement is deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md) for the design contract
(admission lane, hard-objective admission headroom, hard-boost rebalancing).

## Planning Horizon and Milestones

Every deferred objective creates a planning horizon:

```text
now -> deadline
```

Within that horizon, PELS allocates the required useful energy into hourly buckets, preferring
cheap or budget-friendly windows while preserving deadline margin. Status resolves from the
result using the reason codes `planned_with_margin`, `planned_using_deadline_reserve`,
`planned_using_policy_avoid`, `target_cannot_be_met`, `no_bucket_capacity`, or
`energy_already_met` (see §"Reason Codes"). The horizon planner recomputes on every relevant plan
cycle and emits its current-bucket recommendation as `requestedMinimumStepId`.

The priority-adjusted horizon model and the energy-based milestone framework are deferred — see
[`notes/planning-horizon-milestones/README.md`](../planning-horizon-milestones/README.md). What
shipped covers the same intent ("let soft objectives wait through expensive hours without
flipping to at-risk") via the `planned_using_policy_avoid` reason and the deadline-reserve
margin, without computing explicit milestones.

### Rate Bootstrap (EV SoC only)

EV SoC objectives need a kWh-per-percent value to convert "target 80%" into "X kWh required" before
the horizon planner can allocate buckets. The value is normally learned from observed charging
samples (`lib/core/objectiveProfiles.ts`), but SoC reporting depends on a plugged-in charge session,
so a learned profile is often unavailable when the user first sets a deadline.

To unblock the first cycle, the diagnostic falls back to `BOOTSTRAP_EV_SOC_KWH_PER_PERCENT` (1.0,
from `packages/shared-domain/src/objectiveProfileBootstrap.ts`) when no learned `kwhPerUnit` exists.
This is intentionally conservative-high — over-booking is harmless because the device stops at
target SoC; under-booking risks missing the deadline. Each diagnostic carries `kwhPerUnitSource:
'learned' | 'bootstrap' | null`, and the active-plan recorder writes a `rate_refined` revision the
first time it observes the source flip from `bootstrap` to `learned` after the initial sample lands.

Temperature objectives do not get a bootstrap default. Thermal mass varies by orders of magnitude
across devices (a small radiator vs a 200 L water tank), so no single constant is safe. Temperature
profiles also start learning on day one for any device with `measure_power` (or a configured
stepped-load profile with `planningPowerW`), because `updateObjectiveProfilesFromSnapshot` runs
every power sample on the whole device snapshot — not gated on an objective being set.

## Deadline Plan Visibility

The user-facing deadline plan lives as an SPA route off the Settings UI `index.html`, rendered
by `packages/settings-ui/src/ui/views/DeadlinePlan.tsx` (a standalone HTML page existed briefly
during prototyping but was retired because the Homey mobile WebView does not inject the Homey
SDK on sub-pages — see the corresponding note in §"Plan history capture").

For EV chargers, the page should make the plan answer concrete questions from issue 147:

- how much energy remains to reach the target SoC
- how many charging hours are expected
- which hours are planned because they are cheap
- which hours are kept as backup because charging may be blocked
- what assumptions affect backup hours and confidence

The shipped chart uses two stacked ECharts grids: the upper grid shows hourly electricity prices
tone-coded (cheap / normal / expensive); the lower grid stacks background usage, current planned
charge, and an overlay of the *original* planned charge (dashed border) for hours where the plan
revised. A progress target line sits on the left Y axis in the device's display unit (°C for
temperature, % for EV), and observed device delivery is rendered as a dotted line when
available. This keeps the behavior recognizable as cheapest-hour EV planning while showing the
PELS difference: priority and background usage risk widen the plan or add backup hours, but
they do not make expensive hours look cheap.

The durable product home is per-device, because the deadline objective belongs to one charger
or storage device. Budget may later show aggregate impact, but it should not own the full
per-device objective plan.

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
- Which energy buckets were planned?
- Is the device on track, at risk, or impossible to finish?
- What step/mode is being requested now, and why?
- Did the device reach the target?
- Did stale/missing input prevent planning?

Log events:

**Shipped today** (emitted from `lib/plan/deferredObjectives/diagnosticDebugPayload.ts`):

- `deferred_objective_horizon_planned` — fired when the bridge can build a horizon plan.
- `deferred_objective_unknown` — fired when required inputs are missing, stale, invalid, or
  price-gated.

**Planned, not yet emitted:**

- `deferred_objective_evaluated`
- `deferred_objective_step_requested`
- `deferred_objective_mode_requested`
- `deferred_objective_goal_met`
- `deferred_objective_deadline_missed`

Lifecycle events (target met, deadline missed) are currently surfaced through status transitions
and the `deadline_ended` flow trigger outcome rather than as their own structured log events.
Milestone-status logging is deferred — see
[`notes/planning-horizon-milestones/README.md`](../planning-horizon-milestones/README.md).

Useful fields:

- `deviceId`
- `deviceName`
- `objectiveKind`
- `activeMode`
- `status`
- `reasonCode`
- `targetTemperatureC`
- `targetPercent`
- `targetEnergyKwh`
- `currentEnergyKwh`
- `energyNeededKWh`
- `kWhPerPercent`
- `deadlineAtMs`
- `deadlineLocalTime` (display-only; formatted from `deadlineAtMs` + Homey timezone)
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
- `dailyBudgetExhaustedBucketCount` (public diagnostic — number of horizon buckets the daily
  budget reports as exhausted; UI consumes to explain `cannot_meet` outcomes due to budget vs.
  device limits)

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

Hard enforcement is deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md) for the planner behavior under
`hard` admission mode and the constraints around step progression and stale-data handling.

## Flow Triggers

### Shipped today

Three trigger cards registered in `flowCards/deadlineObjectiveCards.ts`:

- **`deadline_status_changed`** — fires when the status bus reports a transition between
  `waiting` / `on_track` / `at_risk` / `unachievable` / `satisfied`. First-observation and
  same-status re-fires are suppressed. Tokens: `device_name`, `status` (display label),
  `target_text`, `deadline_local_time`, `kind`. A sticky `deadlineMissed` flag on the snapshot
  blocks re-fires once the deadline has passed (the missed transition is surfaced via
  `deadline_ended` instead); the flag clears on `satisfied` or when the objective is rescheduled.
- **`deadline_ended`** — fires once per run conclusion with `outcome` = `succeeded` /
  `missed` / `abandoned`. Tokens: `device_name`, `outcome` (display label), `kind`,
  `target_text`, `deadline_local_time`, `finished_at_local_time` (empty when not succeeded),
  `shortfall_text`. `replaced` and `unknown` outcomes are intentionally suppressed.
- **`deadline_plan_changed`** — fires when a replan changes the number of planned hours.
  Tokens: `device_name`, `remaining_kwh`, `planned_hours`, `projected_finish_local_time`.

Plus two condition cards:

- **`deadline_status_is`** — true if the current effective status matches the chosen dropdown
  value (`waiting` / `on_track` / `at_risk` / `unachievable` / `satisfied`). The runlistener
  also accepts a legacy id set (`none`, `pending_prices`, `cannot_meet`, `cannot_finish`,
  `done`) for backwards compatibility with older user flows; only the canonical ids are exposed
  in today's dropdown JSON.
- **`has_active_deadline`** — true if the device has an enabled objective entry.

The `clear_deadline` action card's device autocomplete is filtered to devices with an active
task; if no enabled tasks exist, it falls back to the full device list so the card remains
usable.

### Pending — proposed redesign

The trigger cards above ship with `outcome` and `status` dropdown args that filter at trigger
time. That design forces users into one flow per filtered value and makes the tokens emit
English display labels rather than stable ids — fine for notification text, awkward for
condition logic. A proposed redesign drops the dropdown args, exposes stable-id tokens
(`outcome_id`, `status_id`, `previous_status_id`, `change_reason_id`) as public-API contract,
adds numeric tokens for math/comparison, and adds a composed `notification_text` token to
every trigger. See [`notes/smart-task-flow-cards/README.md`](../smart-task-flow-cards/README.md)
for the full proposal. Tracked as P0 in `TODO.md`.

The richer-tokens slice originally drafted as `ev-ready-by/README.md` §P2.3
(`planned_start_local`, `planned_finish_local`, `required_kwh`, `planning_speed_kw`,
`estimated_duration_text`, `risk_reason`, `notification_text`) is part of the same redesign.

## Reason Codes

Use structured reason codes rather than prose as planner contract. The live source-of-truth is
the union in `lib/plan/deferredObjectives/types.ts` plus the per-module narrow types in
`diagnosticsBridge.ts`, `policyHorizon.ts`, and `horizonPlanner.ts`.

### Shipped today

Diagnostics bridge (`diagnosticsBridge.ts`):

- `objective_missing_device`
- `objective_invalid_deadline`
- `objective_invalid_session`
- `objective_progress_stale`
- `objective_missing_temperature`
- `objective_missing_charge_rate`
- `objective_missing_capacity`

Policy horizon (`policyHorizon.ts`):

- `objective_price_feature_disabled`
- `objective_missing_price_horizon`

Horizon planner result (`horizonPlanner.ts`):

- `energy_already_met`
- `planned_with_margin`
- `planned_using_deadline_reserve`
- `planned_using_policy_avoid`
- `target_cannot_be_met`
- `no_bucket_capacity`

Plus the generic `status: 'unknown' | 'on_track' | 'at_risk' | 'cannot_meet' | 'satisfied'`
status field on the diagnostic — note that status is a separate field from the reason code.

### Reserved for pending slices

Design placeholders that are not yet emitted, and aren't shipped because today's narrower codes
cover their cases (or because the slice they belong to is deferred):

- `objective_unknown` — generic; today partially covered by `status: 'unknown'` + the more
  specific `objective_missing_*` reasons.
- `objective_missing_target`, `objective_missing_deadline` — design placeholders; today both
  cases collapse to `objective_invalid_deadline`.
- `objective_missing_thermal_profile` — design placeholder; today covered by
  `objective_missing_capacity` (the thermal profile is how kWh-per-degree is learned).
- `objective_mode_cannot_reach_target`, `objective_mode_override_disabled` — reserved for the
  mode-override slice.
- `objective_likely_to_meet`, `objective_at_risk`, `objective_cannot_be_met` — these belong on
  the status field, not the reason field; included here only for backwards reference to the
  original design.
- `objective_soft_deadline_restore` — reserved for a possible future restore-lane reason.
- `objective_target_met`, `objective_deadline_missed` — lifecycle codes; today covered by status
  transitions and the `deadline_ended` outcome rather than a reason code.

Hard-deadline reason codes are reserved separately — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

## Implementation Shape

This should be phased. The first settings-backed slice started with EV SoC diagnostics. The first
thermal implementation target is Connected 300-style thermal storage, not a generic public flow-card
objective surface.

Current implementation slice:

1. Learned objective profiling exists before deadline control.
2. EV SoC and soft temperature objectives can be read from versioned settings.
3. Settings objectives store an absolute `deadlineAtMs`. Flow cards resolve the user's HH:mm
   input to a future moment **once at write time**; the bridge never re-resolves on its own.
4. Planning is price-feature gated and feeds soft temperature admission/target overrides.
5. The bridge waits for tomorrow's price buckets instead of assuming neutral prices when the
   deadline falls past the current daily horizon.
6. The bridge emits structured debug diagnostics and supplies planner admission decisions for the
   shipped soft temperature slice.
7. When a deadline passes, `statusTransitions.ts` auto-disables the entry so the same deadline
   does not silently replan for the next day.
8. The Settings UI exposes Smart tasks and per-device deadline-plan/history pages; deadline
   creation and clearing are handled by public flow cards.

Recommended implementation order:

1. Add generic objective state/evaluation types and pure evaluator tests.
2. Add the settings-backed EV SoC diagnostics bridge that exercises the horizon scheduler without
   flow cards or actuation.
3. Add Connected 300-oriented thermal objective diagnostics using stepped-load profiles, fresh
   temperature input, target temperature, learned kWh per degree, and requested minimum step.
4. Expose deadline creation, clearing, status conditions, and status-change / missed-deadline
   triggers through public flow cards. The earlier short-lived device-detail Settings UI card has
   been retired in favor of this flow-card surface.
5. Add runtime actuation for planned-hour admission and outside-planned-hour behavior. Shipped for
   soft temperature objectives.
6. Surface objective diagnostics and reason codes without a full Settings editor. Current UI
   surfaces Smart tasks and per-device plan/history views; broader public docs still need refresh.
7. Integrate soft objective through existing normal device behavior while preserving normal budget
   and priority policy.

Hard admission and hard-boost rebalancing are deferred — see
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

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

Status legend: ✅ shipped, ⏳ pending, ⏸ deferred to a dedicated note.

Core objective v1:

- ✅ Objective state and evaluation are separate types or modules.
- ✅ A native or semi-native adapter can set target temperature for a thermal storage objective.
- ✅ Progress, energy, temperature, targets, deadlines, and freshness appear on snapshot/plan
  diagnostics.
- ✅ Missing or stale inputs produce `unknown`, not optimistic planning.
- ✅ Public flow cards (`set_*_deadline`, `clear_deadline`, plus status/plan/ended triggers and
  conditions) are the v1 user-facing surface for soft temperature smart tasks; the
  short-lived device-detail Settings UI card has been retired.

Connected 300-style behavior:

- ✅ Target is expressed as temperature by deadline.
- ⏸ Current/target temperature can map to usable stored energy through a thermal profile (the
  baseline-anchored design — shipped path uses learned `kWhPerUnit × ΔT` directly).
- ⏸ Mode-dependent max temperature and usable capacity are accounted for (deferred — see
  [`notes/hard-deadlines/README.md`](../hard-deadlines/README.md) §"Mode override").
- ⏸ Mode override is disabled by default for soft deadlines (deferred — no mode override
  ships).
- ✅ The horizon scheduler chooses budget-friendly buckets while maintaining deadline margin.
- ✅ Stepped loads compute `requestedMinimumStepId`.
- ✅ Stepped loads still ramp one configured step at a time.
- ✅ Objective urgency protects only the requested minimum step.
- ✅ If the objective is satisfied, the device does not request power merely because its
  physical max step is high.

EV behavior:

- ✅ EV disconnect invalidates effective progress.
- ✅ EV reconnect requires a fresh progress report newer than reconnect/session start.
- ✅ Stale or invalid EV progress is not used for planning.
- ✅ EV planning stays `unknown` when percent is available but capacity, remaining energy, or
  direct remaining-time estimate is missing.
- ✅ When the EV deadline target is met, PELS removes the deadline charging request (admission
  resolves `satisfied` → `inactive`).
- ⏳ If Power-limit control is on, normal managed charging may continue after the deadline
  target is met, especially when the target is below 100%. (Behavior follows from normal
  admission resuming after deferred admission drops out; not specifically tested.)
- ✅ If Power-limit control is off, meeting the deadline target pauses charging. Admission
  emits a terminal `ev_pause` for the cap-off + `satisfied` + `ev_soc` case, and the executor's
  cap-off branch routes that intent through `applyDeferredEvCommand`. The pause is re-emitted
  per cycle while `satisfied`; the executor short-circuits when the charger is already paused
  so re-emission is idempotent.

Deadline behavior:

- ✅ Status is computed from energy needed, conservative net gain, and deadline. (Note:
  confidence-adjusted margin is deferred — see
  [`notes/status-hysteresis/README.md`](../status-hysteresis/README.md).)
- ✅ Power-limit control off leaves the device alone for normal capacity, budget, and price
  work unless an active objective grants temporary deadline authority.
- ✅ Soft deadline may request boost/step-up, but does not bypass effective soft limit, daily
  budget, priority, cooldowns, or stepped rules.

Hard-deadline acceptance items are tracked in
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

Diagnostics and triggers:

- Stable transitions can trigger likely, at-risk, cannot-meet, met, missed, stale, and invalid
  session events.
- Logs/diagnostics include reason codes for unknown, blocked, requested step selection, and
  requested mode selection. Hard-deadline-specific reason codes are reserved (see
  [`notes/hard-deadlines/README.md`](../hard-deadlines/README.md)).
- A dedicated deferred-objectives debug topic exposes horizon buckets, goal achievement, and
  risk evaluation details without noisy default logs. Milestone-status logging is deferred — see
  [`notes/planning-horizon-milestones/README.md`](../planning-horizon-milestones/README.md).

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
- horizon plan prefers cheap or budget-friendly hour buckets while maintaining deadline margin

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
- soft objective requests boost through normal stepped-load policy

EV tests:

- EV percent plus capacity computes `energyNeededKwh`
- stale EV progress returns `unknown`
- EV disconnect returns `invalid_session`
- EV reconnect without fresh progress returns `invalid_session` or `unknown`
- direct remaining-time estimate can drive deadline evaluation without capacity

Planner/admission tests:

- soft objective does not bypass effective soft limit
- soft objective does not bypass daily budget soft limit
- objective urgency protects only `requestedMinimumStepId`
- higher-than-requested step remains opportunistic

Hard-objective admission tests are tracked in
[`notes/hard-deadlines/README.md`](../hard-deadlines/README.md).

Transition/trigger tests:

- on_track to at_risk emits trigger
- cannot_meet emits immediately
- at_risk to on_track emits trigger
- target met emits trigger
- deadline missed emits trigger
- stale progress emits trigger
- invalid session emits trigger

Hysteresis-related transition tests (stable recovery, consecutive-evaluation gates) are
deferred — see [`notes/status-hysteresis/README.md`](../status-hysteresis/README.md).
