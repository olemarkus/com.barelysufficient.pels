import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import type { PlannedTemperatureState } from '../../packages/shared-domain/src/plannedTemperatureState';
import type {
  PlanInputDevice,
  PlanInputDeviceBase,
  StepPowerCalibrationView,
} from '../../packages/planner-types/src/planInputDevice';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  DeviceControlAdapterSnapshot,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  ExpectedPowerSource,
  PlannedDeviceState,
  RestorePowerSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';

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

export type ShedBehavior = {
  action: ShedAction;
  temperature?: number;
  stepId?: string;
};

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
 * EV field cluster (EV-variant slice of the discriminated-types refactor).
 *
 * EV is ORTHOGONAL to the stepped/non-stepped axis: an EV charger can also be
 * stepped-controlled. So `EvKind` is NOT a union member alongside
 * `Stepped|NonStepped`; it is an intersection the `isEvPlanDevice` type-guard
 * adds back on top of whichever stepped variant the device already is. The EV
 * fields are OMITTED from `DevicePlanDeviceBase`, so neither stepped nor
 * non-stepped variants expose them un-narrowed — a `device.stateOfCharge` /
 * `.evBoost*` read on a bare `DevicePlanDevice` is a hard compile error
 * (TS2339); consumers must pass through `isEvPlanDevice` (or hold an
 * already-narrowed value) first.
 *
 * Every field is OPTIONAL: `evBoost` / `evBoostActive` / `stateOfCharge` are
 * only present when boost is configured / the charger reports SoC. So the guard
 * groups the cluster onto the variant WITHOUT asserting presence the producer
 * does not guarantee.
 *
 * Raw plug-state stays in observer/transport. Planning carries only the
 * producer-resolved objective and commandability facts on its base type.
 */
export type EvKind = {
  evBoost?: EvBoostConfig;
  evBoostActive?: boolean;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

/**
 * Temperature field cluster (temperature-variant slice of the
 * discriminated-types refactor).
 *
 * Like `EvKind`, this is ORTHOGONAL to the stepped axis (an air-treatment unit
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
 * The boost cluster (`temperatureBoost` / `temperatureBoostActive`) is NOT here:
 * it stays on `DevicePlanDeviceBase` (entangled with the cross-kind boost
 * machinery).
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
 * Like `EvKind`/`TemperatureKind`, binary control is ORTHOGONAL to the stepped
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
 * EV field cluster as plain independent optionals: the "might be EV" loose
 * shape a construction/merge site carries before the cluster is regrouped onto
 * the orthogonal `EvKind` intersection. Used by `withEvDiscriminant`.
 *
 * Raw plug-state never enters this construction shape; the adapter strips it
 * before producing a `PlanInputDevice`.
 */
export type EvDiscriminantProbe = {
  evBoost?: EvBoostConfig;
  evBoostActive?: boolean;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

/**
 * Regroup the EV field cluster off a loose bag (whose EV fields are independent
 * optionals on the base, e.g. the result of a `{ ...current, ...updates }`
 * merge or a `...snapshot` spread) onto a single `EvKind`-shaped intersection.
 *
 * Stripping is essential for the same reason as `withSteppedDiscriminant`: an
 * object spread can never *remove* a key, so the EV fields would otherwise
 * survive on the base part of the result and re-pollute the base shape the EV
 * slice deliberately omits them from. EV is orthogonal to the stepped axis, so
 * there is no boolean discriminant to recompute — the cluster is regrouped
 * byte-identically (every EV value is forwarded unchanged) and re-attached as
 * `EvKind`. The result's base part is `Omit<TBase, keyof EvDiscriminantProbe>`,
 * matching the EV-stripped `DevicePlanDeviceBase`.
 *
 */
export function withEvDiscriminant<TBase>(
  loose: TBase & EvDiscriminantProbe,
):
  Omit<TBase, keyof EvDiscriminantProbe> & EvKind {
  const {
    evBoost, evBoostActive, stateOfCharge, ...base
  } = loose;
  // Discriminated like `withBinaryDiscriminant`: the cluster is attached only to
  // an actual EV device, so a non-EV device cannot carry a stale plug-state a
  // spread dragged in. The cast mirrors that regrouper's `?? { on: false }` — an
  // EV device always has a plug-state (the parse boundary drops one that cannot
  // report a valid member), so `undefined` here means a hand-built fixture
  // dropped the value, not a state the planner has to model.
  return {
    ...base,
    ...(evBoost !== undefined ? { evBoost } : {}),
    ...(evBoostActive !== undefined ? { evBoostActive } : {}),
    ...(stateOfCharge !== undefined ? { stateOfCharge } : {}),
  } as Omit<TBase, keyof EvDiscriminantProbe> & EvKind;
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
  if (isTemperatureControlDevice(loose as { deviceType?: string })) {
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
  // (`lib/plan/planTemperatureDevice.ts`). The boost cluster
  // (`temperatureBoost*`) stays on the base. There is intentionally no
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
  evBoost?: EvBoostConfig;
  evBoostActive?: boolean;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  // EV cluster fields (`evBoost`, `evBoostActive`, `stateOfCharge`) are split off
  // onto the orthogonal `EvKind`; reach them through the `isEvPlanDevice` guard
  // (`lib/plan/planEvDevice.ts`). The flat EV plug-state sub-fields below are on
  // the base, materialized once by the producer from the observed
  // `evChargingState` (the observer owns the raw plug-state).
  /**
   * Producer-resolved commandability, REQUIRED so no consumer can read absence
   * as an answer. It was optional through the dual-read transition, and the
   * consequence was concrete: `withEvDiscriminant` strips `evChargingState`, so
   * every plan-device `isCommandableNow` call fell into the raw-field fallback,
   * found nothing, and returned "charger state unknown" — leaving
   * `hasStableBinaryReleaseActuation` dead in production. Same class of bug as a
   * fabricated `currentOn: true`.
   */
  commandableNow: boolean;
  commandabilityReason?: PlanInputDevice['commandabilityReason'];
  objectiveKind?: PlanInputDevice['objectiveKind'];
  objectiveSessionInactive?: boolean;
  // One-shot intent emitted by deferred-objective admission when a cap-off device's smart task
  // transitions out of a plannable status (or the device is in an idle bucket). Binary-controlled
  // devices map to 'binary_restore'/'binary_release' and use the dedicated binary executor path;
  // everything else maps to 'shed_release', which causes the executor to issue the device's
  // configured shedBehavior (turn_off / set_temperature / set_step) exactly once, gated by
  // observed-state idempotency.
  deferredReleaseIntent?: 'binary_restore' | 'binary_release' | 'shed_release';
  priority?: number;
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
  temperatureBoost?: TemperatureBoostConfig;
  temperatureBoostActive?: boolean;
  /**
   * Producer-resolved aggregate boost flag: `true` when either
   * `temperatureBoostActive` or `evBoostActive` fires this cycle. Resolved
   * once in `buildBoostPlanDeviceFields` so restore-side consumers read a
   * single bit instead of recomputing the OR per call.
   */
  boostActive?: boolean;
  // Producer-resolved: `true` when a surplus-absorb lift is the binding cause of this
  // cycle's planned target (raised the setpoint to self-consume solar, not overridden by a
  // deadline floor). Drives the device card's "Raised to use your solar power" reason line.
  surplusAbsorbActive?: boolean;
  // Producer-resolved "Run on solar surplus" dump-load posture, forwarded flat from
  // `PlanInputDevice.surplusOnly` (see its doc block). Rides the plan device so the
  // builder can maintain the plan-less-safe `surplusOnlyShedByDevice` stamp from the
  // finalized shed set.
  surplusOnly?: true;
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
  hasRecentObservedDraw?: boolean;
  /**
   * Producer-resolved residual-kW projection propagated from
   * `PlanInputDevice.residualKw` at plan-build time (chunks 3-4 of the
   * planner-detype refactor). Consumers in
   * `lib/plan/planRemainingSheddableLoad.ts` (chunk 3) and
   * `lib/plan/restore/accounting.ts` (chunk 4) read this after the flat
   * plan-cycle gates. See the corresponding doc-block on `PlanInputDevice`
   * for field semantics.
   */
  residualKw?: {
    shed: number;
    restore?: {
      kw: number;
      source: RestorePowerSource;
    };
  };
};

export type DevicePlan = {
  generatedAtMs?: number;
  meta: {
    totalKw: number | null;
    softLimitKw: number;
    capacitySoftLimitKw?: number;
    dailySoftLimitKw?: number | null;
    budgetPaceKw?: number | null;
    projectedExemptKw?: number | null;
    softLimitSource?: 'capacity' | 'daily' | 'both';
    headroomKw: number;
    powerNowKw?: number | null;
    hasLivePowerSample?: boolean;
    powerSampleAgeMs?: number | null;
    powerFreshnessState?: PowerFreshnessState;
    capacityShortfall?: boolean;
    shortfallBudgetThresholdKw?: number;
    shortfallBudgetHeadroomKw?: number | null;
    hardCapLimitKw?: number | null;
    hardCapHeadroomKw?: number | null;
    hourlyBudgetExhausted?: boolean;
    usedKWh?: number;
    budgetKWh?: number;
    capacityLimitKw?: number;
    minutesRemaining?: number;
    controlledKw?: number;
    uncontrolledKw?: number;
    hourControlledKWh?: number;
    hourUncontrolledKWh?: number;
    dailyBudgetRemainingKWh?: number;
    dailyBudgetExceeded?: boolean;
    dailyBudgetHourKWh?: number;
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
   * Ids of the devices this rebuild actually wrote to. `appliedActions` says
   * only that SOMETHING was written; a consumer acting per device (the realtime
   * circuit breaker) needs to know which, or it charges a strike to a device
   * that merely reported a change while a different one was actuated.
   */
  writtenDeviceIds: string[];
  commandRequestCount: number;
  hadShedding: boolean;
  isDryRun: boolean;
  failed: boolean;
};

// `PlanInputDevice` (the planner's input contract) and its `StepPowerCalibrationView`
// helper now live in the `@pels/planner-types` workspace, below the domain peer
// layer alongside `@pels/contracts`. They are re-exported here so the existing
// consumers that import them from `lib/plan/planTypes` keep working, while
// producer modules outside `lib/plan` (the smart-task controller in
// `lib/objectives`) can import them downward without inverting the peer DAG.
// See notes/state-management/deferred-objective-lifecycle-carveout.md.
export type { PlanInputDevice, StepPowerCalibrationView };
