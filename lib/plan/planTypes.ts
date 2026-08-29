import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import type { PlannedTemperatureState } from '../../packages/shared-domain/src/plannedTemperatureState';
import type {
  PlanInputDevice,
  PlanInputDeviceBase,
  StepPowerCalibrationView,
} from '../../packages/planner-types/src/planInputDevice';
import type { PowerFreshnessState } from '../power/sampleFreshness';
import type {
  DeviceControlAdapterSnapshot,
  ExpectedPowerSource,
  PlannedDeviceState,
  RestorePowerSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';

/**
 * Where this cycle's shed decision leaves a device — the END STATE, not the
 * policy that picked it:
 *
 * - `binary_off` — off on its binary axis.
 * - `step` — parked at a step of its own ladder.
 * - `target_value` — at the setpoint the plan carries as `plannedTarget`, so
 *   that write is the whole of this device's contribution.
 *
 * Absent when the device is not shed this cycle. Resolved by the planner (see
 * `resolvePlannedShedTargetKind`) so consumers downstream never have to read
 * `shedAction` — a device's configured shed behaviour is a FLOOR, the deepest
 * the planner may go, so it is not something a consumer can correctly re-read
 * as this cycle's decision.
 */
export type PlannedShedTargetKind = 'binary_off' | 'step' | 'target_value';

// Canonical observation-source union lives in `lib/observer/`; plan
// continues to surface this name for compatibility with the many target-
// command callers that already import it from here.
import type { PendingObservationSource } from '../observer/pendingBinaryCommandTypes';
export type PendingTargetObservationSource = PendingObservationSource;

export type PendingTargetCommandStatus =
  | 'waiting_confirmation'
  | 'temporary_unavailable';

export type PendingTargetCommandSummary = {
  desired: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: PendingTargetCommandStatus;
  lastObservedValue?: unknown;
  lastObservedSource?: PendingTargetObservationSource;
};

/**
 * A device's CONFIGURED shed behaviour: how far the owner allows PELS to limit
 * it. Persisted under `OVERSHOOT_BEHAVIORS`, resolved once by
 * `normalizeShedBehaviors` (`lib/utils/capacityHelpers.ts`) and read every plan
 * cycle through `getShedBehavior`.
 *
 * Discriminated on `action`, so `set_temperature` always carries its setpoint.
 * The producer already validated it (finite, clamped to ±50); consumers narrow
 * on `action` and read `temperature` inside the branch — they must not
 * re-validate, and there is no longer a temperature-less `set_temperature` to
 * fall through on. That fall-through used to send a device configured for
 * setpoint limiting down the turn-off axis instead.
 *
 * `set_step` carries no step id on purpose: the producer never stores one, and
 * every consumer that wants a rung resolves it from the device's own ladder
 * (`getSteppedLoadLowestActiveStep`). Note this is the FLOOR — the deepest a
 * cycle may go — not a decision; the delivered rung is `shedStepTargets`
 * (`lib/plan/shedding/AGENTS.md`).
 */
export type ShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_temperature'; temperature: number }
  | { action: 'set_step' };

/** The one member that carries a setpoint, for helpers reached past the narrow. */
export type TemperatureShedBehavior = Extract<ShedBehavior, { action: 'set_temperature' }>;

/**
 * Control-kind discriminant slices of the discriminated-types refactor.
 *
 * "Stepped load" is a yes/no capability = presence of a valid
 * `steppedLoadProfile`. `controlModel` is a producer-only setting carried on the
 * snapshot (`TargetDeviceSnapshot`) and is NOT a planner field — the planner
 * discriminates purely on profile presence. These intersection helpers pin the
 * profile (guaranteed present once the discriminant holds) to REQUIRED, without
 * changing the flat base types (`DevicePlanDevice` keeps every other field
 * optional). The narrowing happens only at the kind type-guards in
 * `lib/plan/planSteppedLoad.ts`; consumers that branch through a guard then read
 * the profile without optional-chaining or a null-assert.
 *
 * Field-level variant discrimination (moving fields off the base type so the
 * compiler forbids reading e.g. `currentTemperature` on a stepped device) is a
 * later slice and is deliberately NOT done here. `TargetDeviceSnapshot` is also
 * out of scope for this slice.
 */
export type SteppedLoadKind = {
  // The stepped guard's predicate is profile PRESENCE (`isSteppedLoadSnapshot`),
  // which proves the profile is there, so it is required on the narrowed shape.
  steppedLoadProfile: SteppedLoadProfile;
  /**
   * Producer-resolved EFFECTIVE step (`reportedStepId` ?? planning fallback) —
   * a fact about a step ladder, so it belongs on the variant that has one, and
   * REQUIRED for the same reason `steppedLoadProfile` is: the producer chain
   * (usable-ladder admission ⇒ lowest-active fallback ⇒ the effective step
   * always resolves) guarantees it for every stepped device. NOTE: the EV
   * target-power substitution can leave this naming a rung the CAPPED planner
   * profile lacks, so `getSteppedLoadStep(profile, selectedStepId)` membership
   * checks downstream are real domain questions, not presence hedges.
   */
  selectedStepId: string;
  /**
   * The draw the currently selected step is expected to pull — a fact about a
   * step ladder, so it belongs on the variant that has one, and REQUIRED for
   * the same reason `steppedLoadProfile` is. See the twin docblock on
   * `SteppedPlanInputKind` for why the producer always has an answer.
   */
  planningPowerKw: number;
};

/**
 * Non-stepped control-kind discriminant. The discriminant field
 * `steppedLoadProfile` is split across the two variants: the stepped variant
 * requires it (`SteppedLoadKind`), the non-stepped variant omits it. This makes
 * the compiler reject un-narrowed `device.steppedLoadProfile` reads on a
 * `DevicePlanDevice` / `PlanInputDevice` union — consumers must pass through the
 * `isSteppedLoadDevice` guard (or hold an already-narrowed `Stepped*` value)
 * before touching the profile.
 *
 * The non-stepped variant OMITS `steppedLoadProfile` entirely (rather than
 * `?: never`) so an un-narrowed read on the union is a hard compile error
 * (TS2339) — `?: never` would still type the read as `SteppedLoadProfile |
 * undefined` and silently permit it. It carries no other discriminant field, so
 * it stays `{}`-shaped (no index signature, so the base fields it is
 * intersected with survive); the discriminant is profile presence alone.
 */
export type NonSteppedLoadKind = Record<never, never>;

/**
 * Temperature field cluster (temperature-variant slice of the
 * discriminated-types refactor).
 *
 * ORTHOGONAL to the stepped axis (an air-treatment unit
 * can be both temperature- and stepped-controlled), so it is NOT a union member
 * alongside `Stepped|NonStepped`; it is the intersection the
 * `isTemperaturePlanDevice` type-guard (`lib/plan/planTemperatureDevice.ts`)
 * adds onto whichever stepped variant the device already is. The fields are
 * OMITTED from `DevicePlanDeviceBase`, so a `device.currentTarget` /
 * `.currentTemperature` read on a bare `DevicePlanDevice` is a hard compile
 * error (TS2339); consumers must pass through `isTemperaturePlanDevice` (or hold
 * an already-narrowed value) first.
 *
 * ALL THREE fields are REQUIRED on the narrowed shape. The observer admits the
 * temperature facet atomically — a finite sensor reading AND a finite exact
 * target snapshot, or no facet at all (`deviceType` flips to `'onoff'` and the
 * device leaves the temperature branch entirely) — so once the temperature
 * discriminant holds:
 *
 * - `currentTarget` is a plain `number`: the facet's target value, stamped by
 *   the producer at `toPlanDevice`. There is no transient-read `null` — a
 *   failed read removes the whole facet upstream, it never produces a partial
 *   temperature device.
 * - `currentTemperature` is a plain `number`: the facet's sensor reading,
 *   guaranteed alongside the target.
 * - `plannedTarget` is a plain `number`: the planner ALWAYS resolves a
 *   commanded setpoint for a temperature device (mode target, else the
 *   device's own current target as a no-op seed). "No decision this cycle"
 *   materializes as `plannedTarget === currentTarget`, which the executor's
 *   no-op fence skips — never as absence.
 *
 * Boost is NOT here and is not a temperature fact: the plan device carries one
 * kind-free `boostActive` decision on its base (`lib/plan/planBoost.ts`).
 */
// One definition, aliased rather than restated: the trio is the same fact the
// overview card renders, so a rename must not be able to drift between the two
// ends of the seam. It is defined under a consumer-neutral name in shared-domain
// (the lowest layer both sides may import) precisely so the planner's control
// cluster is not defined by a type named for the UI — read the ownership rules
// on `PlannedTemperatureState` before adding a field to either side.
export type TemperatureKind = PlannedTemperatureState;

/**
 * Binary-control field cluster (binary-variant slice of the discriminated-types
 * refactor).
 *
 * Like `TemperatureKind`, binary control is ORTHOGONAL to the stepped
 * axis (a stepped device also has an onoff control), so this is NOT a union
 * member; it is the intersection the `isBinaryPlanDevice` type-guard
 * (`lib/plan/planBinaryDevice.ts`) adds onto whichever stepped variant the
 * device is. `currentOn` is OMITTED from `DevicePlanDeviceBase`, so an
 * un-narrowed `device.currentOn` read is a hard compile error (TS2339);
 * consumers must pass through `isBinaryPlanDevice` first.
 *
 * `currentOn` is REQUIRED on the narrowed shape: a binary device's on-state is
 * always resolved to a concrete boolean by the producer. The guard's runtime
 * discriminant is producer-resolved `currentOn !== undefined`; transport
 * capability presence is resolved before this boundary.
 */
export type BinaryControlKind = {
  // The single public on/off truth for a binary device: a strict boolean the
  // producer resolves once (`resolveCurrentOn` — binary axis AND stepped-off fold,
  // no staleness gate). Consumers narrow via `isBinaryPlanDevice` and read this
  // directly; the on/off question is meaningful ONLY for binary devices, so there
  // is no kind-agnostic wrapper. The raw observed `binaryControl` no longer rides
  // on the plan kinds — it stays transport/observer-internal; the producer folds
  // it into `currentState`/`currentOn` once at `toPlanDevice`.
  currentOn: boolean;
};

export type SteppedPlanDevice = DevicePlanDeviceBase & SteppedLoadKind;
export type NonSteppedPlanDevice = DevicePlanDeviceBase & NonSteppedLoadKind;
export type DevicePlanDevice = SteppedPlanDevice | NonSteppedPlanDevice;

/**
 * A "might be stepped" device probe: the stepped discriminant
 * (`steppedLoadProfile` presence) as a plain optional. Used by step helpers that
 * accept a device before it is narrowed through `isSteppedLoadDevice`, and by
 * `withSteppedDiscriminant` to re-tie the discriminant.
 */
export type SteppedDiscriminantProbe = {
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
  planningPowerKw?: number;
};

/**
 * The stepped cluster as a UNIT: either both fields or neither. This is what
 * makes `SteppedLoadKind.planningPowerKw` being required mean something.
 *
 * With the probe alone, a producer could hand `withSteppedDiscriminant` a bare
 * `steppedLoadProfile` and no power, and it type-checked — the returned object
 * satisfied the NON-stepped member of the result union, so nothing ever
 * required the number. Verified by deleting the field from `toPlanDevice`: tsc
 * stayed silent. That is precisely the "compiles clean, reads `undefined`"
 * shape this whole change exists to remove.
 *
 * Producers build the pair through a conditional that returns this or `{}`, so
 * supplying a profile without its planning power is a compile error at the
 * producer, where the ladder invariant actually lives.
 */
export type SteppedClusterFields =
  | SteppedLoadKind
  // NOT `Record<never, never>`: `{}` accepts every object, so the union never
  // discriminated and a half-cluster type-checked against it. Forbidding every
  // field on the empty member is what makes "profile without its step or its
  // power" a compile error at the producer.
  | { steppedLoadProfile?: never; selectedStepId?: never; planningPowerKw?: never };

/**
 * Rebuild a discriminated plan device from a loose bag whose `steppedLoadProfile`
 * is still a plain optional (e.g. the result of a `{ ...current, ...updates }`
 * merge, or a `...snapshot` spread). Strips the discriminant field off the base
 * and re-attaches it as a single variant-shaped result
 * (`SteppedLoadKind | NonSteppedLoadKind`), so the result lands cleanly in one
 * union member.
 *
 * Stripping is essential: an object spread can never *remove* a key, so a stale
 * `steppedLoadProfile` would otherwise survive onto a non-stepped result. The
 * runtime predicate is `isSteppedLoadSnapshot` — the same one `isSteppedLoadDevice`
 * delegates to, so the regrouper and the guard cannot drift; anything it rejects
 * resolves to the non-stepped discriminant, which omits the whole stepped cluster
 * (`steppedLoadProfile` and its `planningPowerKw`) entirely.
 */
export function withSteppedDiscriminant<TBase extends object>(
  loose: TBase & SteppedDiscriminantProbe,
):
  | (Omit<TBase, keyof SteppedDiscriminantProbe> & SteppedLoadKind)
  | (Omit<TBase, keyof SteppedDiscriminantProbe> & NonSteppedLoadKind) {
  // The discriminant stays the shared profile-presence predicate ALONE. It is
  // tempting to require the whole cluster here — but this helper cannot be the
  // enforcement point, and trying makes it dangerous: its result type is a union
  // whose non-stepped member accepts anything, so a half-cluster type-checks
  // either way, and refusing one at runtime would silently un-step a device
  // instead of failing loudly. Enforcement belongs at the producers, which build
  // the pair through `SteppedClusterFields`.
  if (isSteppedLoadSnapshot(loose)) {
    const { steppedLoadProfile, selectedStepId, planningPowerKw, ...base } = loose;
    // The casts here are the seam's honest shape: the probe types the fields as
    // independent optionals, so nothing here PROVES they co-vary. Making the
    // parameter a co-presence union does prove it, but the resulting errors at
    // the call sites are unreadable (`Omit` chains over intersections resolve
    // to "two different types with this name exist"), which buys enforcement at
    // the cost of anyone being able to act on it. Enforcement lives at the
    // producers instead: each builds the trio as a `SteppedClusterFields`
    // value, where a partial cluster is a plain, local compile error.
    return {
      ...base,
      steppedLoadProfile,
      selectedStepId: selectedStepId as string,
      planningPowerKw: planningPowerKw as number,
    };
  }
  const {
    steppedLoadProfile: _stripped,
    selectedStepId: _strippedSelectedStep,
    planningPowerKw: _strippedPlanningPower,
    ...base
  } = loose;
  return { ...base };
}

/**
 * Temperature field cluster as plain independent optionals: the "might be
 * temperature" loose shape a construction/merge site carries before the cluster
 * is regrouped onto the orthogonal `TemperatureKind` intersection. Used by
 * `withTemperatureDiscriminant`.
 */
export type TemperatureDiscriminantProbe = {
  currentTarget?: number;
  currentTemperature?: number;
  plannedTarget?: number;
};

/**
 * The temperature cluster as a UNIT: all three fields or none. Same enforcement
 * shape as `SteppedClusterFields`, for the same reason: the regrouper's result
 * type is a union whose non-temperature member accepts anything, so without a
 * co-presence type at the producer, a half-cluster (a target with no reading,
 * or either with no planned target) would type-check and read `undefined` at
 * runtime behind a required type. Producers build the trio through a
 * conditional that returns this or `{}`, so a partial cluster is a compile
 * error at the producer, where the atomic-facet invariant actually lives.
 */
export type TemperatureClusterFields =
  | TemperatureKind
  | { currentTarget?: never; currentTemperature?: never; plannedTarget?: never };

/**
 * Regroup the temperature field cluster off a loose bag (whose temperature
 * fields are independent optionals on the base, e.g. the result of a
 * `{ ...current, ...updates }` merge or a `...snapshot` spread) onto the
 * orthogonal `TemperatureKind` intersection — or strip it entirely when the
 * device is not a temperature device.
 *
 * DISCRIMINATED like `withBinaryDiscriminant`: the runtime predicate is the
 * browser-safe `isTemperatureControlDevice` (`deviceType === 'temperature'`) —
 * the exact predicate `isTemperaturePlanDevice` delegates to, so the regrouper
 * and the guard cannot drift. The transport co-produces `deviceType` with the
 * atomic temperature facet (both set together, both removed together), so for a
 * temperature device the full trio is present on the loose bag by producer
 * invariant; for anything else the fields are stripped so a stale cluster a
 * spread dragged in cannot survive onto a non-temperature result.
 *
 * The cast mirrors `withSteppedDiscriminant`'s: the probe types the fields as
 * independent optionals, so nothing HERE proves the trio co-varies — that proof
 * lives at the producers, which build the cluster as a `TemperatureClusterFields`
 * value where a partial trio is a plain, local compile error.
 */
export function withTemperatureDiscriminant<TBase extends object>(
  loose: TBase & TemperatureDiscriminantProbe,
):
  | (Omit<TBase, keyof TemperatureDiscriminantProbe> & TemperatureKind)
  | Omit<TBase, keyof TemperatureDiscriminantProbe> {
  const { currentTarget, currentTemperature, plannedTarget, ...base } = loose;
  if (isTemperatureControlDevice(loose)) {
    return {
      ...base,
      currentTarget: currentTarget as number,
      currentTemperature: currentTemperature as number,
      plannedTarget: plannedTarget as number,
    };
  }
  return { ...base };
}

/**
 * Binary-control field as a plain optional: the "might be binary" loose shape a
 * construction/merge site carries before the field is regrouped onto the
 * orthogonal `BinaryControlKind` intersection. Used by `withBinaryDiscriminant`.
 */
export type BinaryControlDiscriminantProbe = {
  binaryControl?: { on: boolean };
  currentOn?: boolean;
};

/**
 * Regroup the binary-control field off a loose bag onto a single
 * `BinaryControlKind` intersection — or omit it when the device is non-binary.
 *
 * Like the temperature and stepped regroupers, this DISCRIMINATES rather than
 * always re-attaching: the discriminant is the producer-resolved `currentOn`
 * alone (`resolveCurrentOn` runs once at `toPlanDevice`), so a device with no
 * binary axis this cycle is regrouped WITHOUT the cluster — and so is a loose
 * bag carrying only the RAW `binaryControl`, which means it skipped its
 * producer. The regrouper deliberately does not re-resolve the on-state from
 * raw evidence; resolution belongs to the producer.
 *
 * Stripping is essential either way: an object spread can never remove a key,
 * so the raw `binaryControl` (transport/observer-internal) would otherwise
 * survive onto the plan kinds.
 */
export function withBinaryDiscriminant<TBase>(
  loose: TBase & BinaryControlDiscriminantProbe,
):
  | (Omit<TBase, keyof BinaryControlDiscriminantProbe> & BinaryControlKind)
  | Omit<TBase, keyof BinaryControlDiscriminantProbe> {
  const { binaryControl: _strippedBinaryControl, currentOn, ...base } = loose;
  // The discriminant is the producer-resolved `currentOn` ALONE: the producer
  // resolves the strict boolean once (`resolveCurrentOn` at `toPlanDevice` /
  // the fixture builders' mirror), so a bag carrying only the raw
  // `binaryControl` has skipped its producer and is regrouped WITHOUT the
  // cluster rather than re-resolved here. The raw `binaryControl` is still
  // STRIPPED off the result either way (it stays transport/observer-internal
  // and a spread can never remove a key).
  if (currentOn !== undefined) {
    return { ...base, currentOn };
  }
  return { ...base };
}

export type SteppedPlanInputDevice = PlanInputDeviceBase & SteppedLoadKind;

type DevicePlanDeviceBase = {
  id: string;
  name: string;
  deviceClass?: string;
  // Carried flat (like `deviceClass`) so the `isTemperaturePlanDevice` guard's
  // runtime predicate (`deviceType === 'temperature'`) reads identically on the
  // output plan device as on the input device. Stamped by the producer in
  // `lib/plan/planDevices.ts`.
  deviceType?: 'temperature' | 'onoff';
  // `binaryControl` is split off onto the orthogonal `BinaryControlKind` cluster;
  // reach it through the `isBinaryPlanDevice` guard (`lib/plan/planBinaryDevice.ts`).
  // Present iff the producer resolved a binary `currentOn` value.
  currentState: string;
  plannedState: PlannedDeviceState;
  // `currentTarget`, `currentTemperature`, and `plannedTarget` (planner output)
  // are split off onto the orthogonal `TemperatureKind` cluster; reach them
  // through the `isTemperaturePlanDevice` guard
  // (`lib/plan/planTemperatureDevice.ts`). The boost configs and readings are
  // off the plan device entirely — it carries the resolved `boostActive`
  // decision and nothing behind it.
  // There is intentionally no
  // `observationStale` field: the plan has no right to distrust observer data
  // (it trusts the producer-resolved `currentOn`/`currentState`), and staleness
  // *reporting* is the observer's concern, not the plan's.
  communicationModel?: 'local' | 'cloud';
  reportedStepId?: string;
  targetStepId?: string;
  // `selectedStepId` is NOT here: it is a fact about a step ladder and lives on
  // `SteppedLoadKind`, reached through `isSteppedLoadDevice`.
  desiredStepId?: string;
  previousStepId?: string;
  lastDesiredStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  controlAdapter?: DeviceControlAdapterSnapshot;
  // No `evBoost` / `stateOfCharge` / `temperatureBoost`: a boost threshold is
  // configuration and a battery level is an observation, and the plan device
  // carries neither. It carries the DECISION they produced (`boostActive`
  // below), resolved once by the producer. The battery level reaches the
  // settings UI from the seam that owns it (`getObservedStateOfCharge` in
  // `createPlanService`); the configured thresholds never cross the plan wire at
  // all — the settings UI reads them straight from the settings store.
  /**
   * Producer-resolved commandability, REQUIRED so no consumer can read absence
   * as an answer. It was optional through the dual-read transition, and the
   * consequence was concrete: the plan device does not carry `evChargingState`,
   * so every plan-device `isCommandableNow` call fell into the raw-field
   * fallback, found nothing, and returned "charger state unknown" — leaving
   * `hasStableBinaryReleaseActuation` dead in production. Same class of bug as a
   * fabricated `currentOn: true`.
   */
  commandableNow: boolean;
  commandabilityReason?: PlanInputDevice['commandabilityReason'];
  objectiveKind?: PlanInputDevice['objectiveKind'];
  /** Producer-resolved standing demand — see the twin docblock on `PlanInputDevice`. */
  hasStandingDemand: boolean;
  // One-shot intent emitted by deferred-objective admission when a cap-off device's smart task
  // transitions out of a plannable status (or the device is in an idle bucket). Binary-controlled
  // devices map to 'binary_restore'/'binary_release' and use the dedicated binary executor path;
  // everything else maps to 'shed_release', which causes the executor to issue the device's
  // configured shedBehavior (turn_off / set_temperature / set_step) exactly once, gated by
  // observed-state idempotency.
  deferredReleaseIntent?: 'binary_restore' | 'binary_release' | 'shed_release';
  /** Rank in the active mode: unique, gap-free `1..N`, lower wins. REQUIRED —
   * see the twin docblock on `PlanInputDevice`. */
  priority: number;
  /** Draw when running, in kW. REQUIRED — see the twin docblock on `PlanInputDevice`. */
  expectedPowerKw: number;
  // `planningPowerKw` is NOT here: it is a stepped-ladder fact and lives on
  // `SteppedLoadKind`, reached through `isSteppedLoadDevice`.
  /** Which rung produced the figure. REQUIRED — see the twin docblock on `DeviceDescriptor`. */
  expectedPowerSource: ExpectedPowerSource;
  /** Current draw in kW. REQUIRED — see the twin docblock on `PlanInputDevice`. */
  currentDrawKw: number;
  // Formal planner decision contract. UI/log text must be rendered from this structured reason.
  reason: DeviceReason;
  zone?: string;
  /**
   * Producer-resolved: whether PELS manages this device this cycle. REQUIRED —
   * `toPlanDevice` resolves the owner's setting before the planner receives the
   * device, and the deferred-objective rescue lane's override lands before
   * materialization. Optional
   * bought nothing here: absence never reached this type, and typing it as if
   * it might left `undefined` meaning "managed" — a third state for a two-state
   * fact. Consumers read the required boolean directly; absence is not a plan
   * state on either the input or output contract.
   */
  controllable: boolean;
  budgetExempt?: boolean;
  /**
   * The device's boost decision this cycle, and the planner's whole boost
   * vocabulary. REQUIRED: `resolveBoostActive` (`lib/plan/planBoost.ts`) answers
   * it for every device from the producer's two kind-free bits plus the runnable
   * gate, so absence is never a state — it would only ever be a fixture that
   * forgot, read by a consumer as "not boosting".
   *
   * There are no per-axis twins any more, here or on the wire. `temperatureBoostActive`
   * and `evBoostActive` used to ride beside this bit; nothing in the planner
   * could tell them apart (every decision site read the OR), and the settings
   * snapshot could not answer "which axis" correctly either — it guessed from
   * which observer seams happened to return a value. Naming the axis is a copy
   * concern, so the view names it, from the device's own facets.
   */
  boostActive: boolean;
  // Producer-resolved: `true` when a surplus-absorb lift is the binding cause of this
  // cycle's planned target (raised the setpoint to self-consume solar, not overridden by a
  // deadline floor). Drives the device card's "Raised to use your solar power" reason line.
  surplusAbsorbActive?: boolean;
  // Producer-resolved "Run on solar surplus" dump-load posture, forwarded flat from
  // `PlanInputDevice.surplusOnly` (see its doc block). Rides the plan device so the
  // builder can maintain the plan-less-safe `surplusOnlyShedByDevice` stamp from the
  // finalized shed set.
  surplusOnly?: true;
  // Producer-resolved "Match solar surplus" tracking posture, forwarded flat from
  // `PlanInputDevice.surplusTracking` (see its doc block). Rides the plan device
  // so the reason-pair validator can pair `awaiting_solar_surplus` with the
  // posture that earned it, exactly as `surplusOnly` does.
  surplusTracking: boolean;
  // Producer-resolved "Leave off until turned on again" posture, forwarded flat
  // from `PlanInputDevice.externalOffHoldActive` (see its doc block). The planner
  // makes the device inactive and never asks why it is off.
  externalOffHoldActive?: true;
  // Forwarded flat from `PlanInputDevice.reservesStartupPower` (see its doc block): this device
  // may hold back its lowest-active-step power from lower-priority devices' admission until it
  // has started. Read only by `lib/plan/admission/headroomReserve.ts`.
  reservesStartupPower?: true;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  binaryCommandPending?: boolean;
  // The shed triple, materialized as a unit by `materializeShedSnapshotFields`
  // (`lib/plan/planActionMaterialization.ts`) at both producers
  // (`lib/plan/planDevicesBase.ts`, `lib/plan/restore/marking.ts`), so in
  // practice all three are always present together. They stay optional anyway:
  // every consumer gates on `typeof x === 'number'` / a `shedAction` equality,
  // so `undefined` and `null` are indistinguishable here and requiring them
  // would delete no branch — and requiring only one of the three would make the
  // triple less coherent, not more. Tighten all three together or not at all.
  shedAction?: ShedAction;
  shedTemperature?: number | null;
  releaseShedStepId?: string | null;
  /**
   * The step THIS cycle's shed decision parks a stepped device at — the rung the
   * shedding planner priced the shed at (`SheddingPlan.shedStepTargets`), or the
   * configured behaviour's floor when no rung was chosen.
   *
   * Planner bookkeeping, and the input `resolvePlannedShedTargetKind` needs to
   * tell a `turn_off` device left running at an intermediate rung (`step`) from
   * one taken to its off step (`binary_off`). Absent means "this cycle's shed
   * was not decided with a step", which is exactly the state of a device a LATER
   * stage flipped to `shed` (a rejected restore) — its `desiredStepId` was
   * resolved on the keep path and says nothing about a shed destination, which
   * is why this field exists instead of reading that one.
   *
   * Executor code reads `plannedShedTargetKind` and `desiredStepId`, not this.
   */
  plannedShedStepId?: string;
  /**
   * This cycle's shed END STATE — see `PlannedShedTargetKind`. Stamped once, by
   * `finalizePlanDevices`, from the device's FINAL `plannedState` + shed
   * triple: the restore, swap, and hold stages each revise `plannedState`
   * through their own paths, so anything derived earlier would go stale at the
   * next revision.
   *
   * It is what consumers outside the planner read instead of `shedAction`. The
   * `step` rung is deliberately NOT carried here: the executor resolves its own
   * command step (transition step ?? planned step), which can differ from
   * `desiredStepId`, and pairs it with this kind.
   */
  plannedShedTargetKind?: PlannedShedTargetKind;
  /**
   * Executor bookkeeping, planner-resolved: applying this plan's target write
   * counts as a RESTORE — the executor stamps the restore clocks
   * (`lastRestoreMs`/`lastDeviceRestoreMs`, cooldown bump) when it lands.
   * True exactly when the device's observed setpoint sits AT its
   * capability-normalized shed floor and the planned target raises it.
   * Stamped once, by `finalizePlanDevices` (like `plannedShedTargetKind`:
   * anything derived earlier goes stale when a later stage revises
   * `plannedState`/`plannedTarget`); every constructor before finalize sets
   * `false`. The executor consumes this instead of re-deriving the
   * classification from shed config — why the planner chose the setpoint is
   * the planner's problem (owner ruling, 2026-08-25).
   */
  recordRestoreOnTargetApply: boolean;
  /**
   * Producer-resolved reachability. REQUIRED because the transport already
   * answers it for every device — but note HOW: `managerHelpers.getIsAvailable`
   * resolves a non-boolean read OPTIMISTICALLY to `true`. So this field means
   * "not known to be unavailable", and every reader has always spelled that
   * `!== false`. Requiring it changes no decision; it just stops a third state
   * existing in the type for a two-state answer.
   *
   * That optimism is the capacity-UNSAFE direction (`planHeadroomDevice` zeroes
   * headroom only on `available === false`, so an unreadable device stays
   * sheddable and its expected relief may never materialize). Pre-existing, and
   * not something requiring the field makes better or worse — but do not read
   * this field as proof Homey said yes.
   */
  available: boolean;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  pendingTargetCommand?: PendingTargetCommandSummary;
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  // `confirmedNotDrawing` deliberately does NOT travel onto the plan output.
  // It is an input to the one boost decision (`resolveBoostActive`), and that
  // decision's result — `boostActive` — is what the plan carries. Propagating
  // the evidence as well is how the restore path came to re-ask the same
  // question with its own answer.
  /**
   * Producer-resolved residual-kW projection propagated from
   * `PlanInputDevice.residualKw` at plan-build time (chunks 3-4 of the
   * planner-detype refactor). Consumers in
   * `lib/plan/planRemainingSheddableLoad.ts` (chunk 3) and
   * `lib/plan/restore/accounting.ts` (chunk 4) read this after the flat
   * plan-cycle gates. See the corresponding doc-block on `PlanInputDevice`
   * for field semantics.
   *
   * Both halves are REQUIRED, for the reason stated there: the producer always
   * stamps them, so absence is not a state a consumer can observe.
   */
  residualKw: {
    shed: number;
    restore: {
      kw: number;
      source: RestorePowerSource;
    };
  };
};

export type DevicePlan = {
  generatedAtMs?: number;
  /**
   * REQUIRED means the producer always writes it. `buildPlanMeta` copies most of
   * this straight off `PlanContext`, where these are already non-optional — so
   * an optional here was the guarantee being discarded one layer below the wire,
   * and the wire then discarded it again. A consumer that hedges on one of these
   * is defending against a state the planner cannot produce.
   *
   * OPTIONAL is reserved for genuine absence, and each one below says why.
   */
  meta: {
    // NULLABLE ONLY AS A RESIDUE — due to be a plain `number`.
    //
    // It meant "no meter reading this cycle": the guard held `null` until its
    // meter's first sample, and again between an in-place meter swap and the
    // new meter's first reading. The build gate (`setup/powerMeasurementGate.ts`)
    // now refuses to build a plan in either state, so no plan can carry a null
    // total for any reason a home can actually be in — a raw untrusted total has
    // no business on a plan type in the first place.
    totalKw: number | null;
    softLimitKw: number;
    capacitySoftLimitKw: number;
    // `null` = no daily budget configured. Always written (`?? null`).
    dailySoftLimitKw: number | null;
    budgetPaceKw: number | null;
    projectedExemptKw: number | null;
    // No `'both'`. `resolveSoftLimitSource` (`planBuilder.ts`) is total over
    // these two — when the paces coincide within `SOFT_LIMIT_EPSILON` it answers
    // `'capacity'`, not a third "they meet here" state — and `PlanContext`
    // already types it `SoftLimitSource = 'capacity' | 'daily'`. The third
    // member was declared here and on the wire with nothing able to produce it,
    // which bought a dead branch in every consumer that switched on it.
    softLimitSource: 'capacity' | 'daily';
    headroomKw: number;
    powerNowKw: number | null;
    hasLivePowerSample: boolean;
    powerSampleAgeMs: number | null;
    powerFreshnessState: PowerFreshnessState;
    /**
     * Producer-resolved: did this cycle have a measurement. Downstream layers
     * that gate a positive (turn-on) action read THIS, never
     * `powerFreshnessState` — `lib/executor` used to test the label itself and
     * so answered the same question with a different predicate (`fresh` alone,
     * where the planner required a total too).
     */
    powerIsMeasured: boolean;
    capacityShortfall: boolean;
    // Genuinely absent when there is no capacity guard: the threshold is the
    // guard's own, and `getCapacityGuard()` returns `undefined` before wiring.
    shortfallBudgetThresholdKw?: number;
    shortfallBudgetHeadroomKw: number | null;
    // From `capacitySettings.limitKw`, a plain required `number` passed straight
    // through — so neither `?` nor `| null` was ever right here.
    hardCapLimitKw: number;
    hardCapHeadroomKw: number | null;
    hourlyBudgetExhausted: boolean;
    usedKWh: number;
    budgetKWh: number;
    capacityLimitKw: number;
    minutesRemaining: number;
    // `splitControlledUsageKw` states the asymmetry outright: the managed side
    // always resolves; the whole-home total is a separate reading that can
    // genuinely be missing, so only the background side is nullable.
    controlledKw: number;
    uncontrolledKw: number | null;
    // Genuinely absent when the hour has no bucket data yet
    // (`resolveHourlyUsageSplit` returns `{}`).
    hourControlledKWh?: number;
    hourUncontrolledKWh?: number;
    dailyBudgetRemainingKWh: number;
    dailyBudgetExceeded: boolean;
    // Genuinely absent when the daily budget is disabled or the bucket index is
    // out of range (`extractDailyBudgetHourKWh`).
    dailyBudgetHourKWh?: number;
    // Genuinely absent before the power tracker's first timestamp.
    lastPowerUpdateMs?: number;
  };
  devices: DevicePlanDevice[];
};

export type PlanChangeSet = {
  actionSignature: string;
  detailSignature: string;
  metaSignature: string;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
};

export type PelsStatusWriteReason = 'initial' | 'action_changed' | 'posture_flip' | 'throttle';

export type StatusPlanChanges = Pick<
  PlanChangeSet,
  'actionChanged' | 'actionSignature' | 'detailSignature' | 'metaSignature'
>;

export type PlanRebuildOutcome = {
  buildMs: number;
  changeMs: number;
  snapshotMs: number;
  statusMs: number;
  statusWriteMs: number;
  applyMs: number;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
  appliedActions: boolean;
  deviceWriteCount: number;
  /**
   * Ids of the devices this rebuild actually wrote to. `appliedActions` says only
   * that SOMETHING was written; this says which.
   *
   * Its original consumer was the realtime circuit breaker, which needed per-device
   * attribution to avoid charging a strike to a device that merely reported a
   * change while a different one was actuated. That breaker went with the
   * observation lane, so nothing reads this today — it survives as the honest
   * shape of the answer, and as what a per-device consumer would need.
   */
  writtenDeviceIds: string[];
  commandRequestCount: number;
  hadShedding: boolean;
  isDryRun: boolean;
  failed: boolean;
  /**
   * True when no plan was built because the wiring layer's build gate was shut
   * (in production: this home has no meter measurement yet). Distinct from
   * `failed` — nothing went wrong, there was simply nothing to plan from — and
   * distinct from a zeroed no-op, which means a plan WAS built and changed
   * nothing.
   */
  gated: boolean;
};

// `PlanInputDevice` (the planner's input contract) and its `StepPowerCalibrationView`
// helper now live in the `@pels/planner-types` workspace, below the domain peer
// layer alongside `@pels/contracts`. They are re-exported here so the existing
// consumers that import them from `lib/plan/planTypes` keep working, while
// producer modules outside `lib/plan` (the smart-task controller in
// `lib/objectives`) can import them downward without inverting the peer DAG.
// See notes/state-management/deferred-objective-lifecycle-carveout.md.
export type { PlanInputDevice, StepPowerCalibrationView };
