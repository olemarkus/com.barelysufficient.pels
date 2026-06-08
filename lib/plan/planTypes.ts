import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { EvChargingState } from '../../packages/contracts/src/types';
import type {
  PlanInputDevice,
  PlanInputDeviceBase,
  StepPowerCalibrationView,
} from '../../packages/planner-types/src/planInputDevice';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  BinaryControlCapabilityId,
  DeviceControlAdapterSnapshot,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
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

export type PlanCandidateReasons = {
  offStateAnalysis?: string;
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
  // The stepped guard's predicate (`steppedLoadProfile?.model === 'stepped_load'`)
  // proves the profile is present, so it is required on the narrowed shape.
  steppedLoadProfile: SteppedLoadProfile;
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
 * The flat EV plug-state sub-fields (`evBlockReason` / `evSessionInactive` /
 * `evChargerNotResumable`) are NOT here: they live on `DevicePlanDeviceBase`
 * alongside `commandableNow`, materialized once by the producer from the
 * observed `evChargingState` (the observer owns the raw plug-state).
 */
export type EvKind = {
  evBoost?: EvBoostConfig;
  evBoostActive?: boolean;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
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
};

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
 * runtime predicate matches `isSteppedLoadDevice` — the profile is honoured only
 * when its own `model === 'stepped_load'`; anything else resolves to the
 * non-stepped discriminant, which omits `steppedLoadProfile` entirely.
 */
export function withSteppedDiscriminant<TBase extends object>(
  loose: TBase & SteppedDiscriminantProbe,
):
  | (Omit<TBase, keyof SteppedDiscriminantProbe> & SteppedLoadKind)
  | (Omit<TBase, keyof SteppedDiscriminantProbe> & NonSteppedLoadKind) {
  const { steppedLoadProfile, ...base } = loose;
  if (steppedLoadProfile?.model === 'stepped_load') {
    return { ...base, steppedLoadProfile };
  }
  return { ...base };
}

/**
 * EV field cluster as plain independent optionals: the "might be EV" loose
 * shape a construction/merge site carries before the cluster is regrouped onto
 * the orthogonal `EvKind` intersection. Used by `withEvDiscriminant`.
 *
 * `evChargingState` is NOT a planner field (the observer owns the raw plug-state;
 * the planner carries the resolved flat EV sub-fields on the base). It is listed
 * here only so `withEvDiscriminant` strips any stale copy a `...snapshot`/
 * `...device` spread carried in, and so the regrouped result type omits it from
 * the base.
 */
export type EvDiscriminantProbe = {
  evChargingState?: EvChargingState;
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
 * The raw observed `evChargingState` is observer-owned and must never ride on a
 * plan device. It is no longer a planner field, but a `...snapshot`/`...device`
 * spread upstream could still carry a stale copy in; strip and discard it here so
 * it can never survive onto the regrouped result.
 */
export function withEvDiscriminant<TBase extends object>(
  loose: TBase & EvDiscriminantProbe,
): Omit<TBase, keyof EvDiscriminantProbe> & EvKind {
  const {
    evBoost, evBoostActive, stateOfCharge,
    evChargingState: _evChargingState,
    ...base
  } = loose;
  return {
    ...base,
    ...(evBoost !== undefined ? { evBoost } : {}),
    ...(evBoostActive !== undefined ? { evBoostActive } : {}),
    ...(stateOfCharge !== undefined ? { stateOfCharge } : {}),
  };
}

export type SteppedPlanInputDevice = PlanInputDeviceBase & SteppedLoadKind;

type DevicePlanDeviceBase = {
  id: string;
  name: string;
  deviceClass?: string;
  // Transitional snapshot field only. Planner truth must come from currentState.
  // Present iff binary control; absence is the old fabricated `currentOn: true`.
  binaryControl?: { on: boolean };
  currentState: string;
  plannedState: PlannedDeviceState;
  currentTarget: number | null;
  plannedTarget?: number;
  observationStale?: boolean;
  communicationModel?: 'local' | 'cloud';
  reportedStepId?: string;
  targetStepId?: string;
  // Producer-resolved EFFECTIVE step (`reportedStepId` ?? planning fallback).
  // The retired raw-evidence trio (actualStepId / assumedStepId /
  // actualStepSource) collapsed into this plus the typed stepped-state adapter.
  selectedStepId?: string;
  desiredStepId?: string;
  previousStepId?: string;
  lastDesiredStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  controlCapabilityId?: BinaryControlCapabilityId;
  controlAdapter?: DeviceControlAdapterSnapshot;
  // EV cluster fields (`evBoost`, `evBoostActive`, `stateOfCharge`) are split off
  // onto the orthogonal `EvKind`; reach them through the `isEvPlanDevice` guard
  // (`lib/plan/planEvDevice.ts`). The flat EV plug-state sub-fields below are on
  // the base, materialized once by the producer from the observed
  // `evChargingState` (the observer owns the raw plug-state).
  evBlockReason?: string | null;
  evSessionInactive?: boolean;
  evChargerNotResumable?: boolean;
  // One-shot intent emitted by deferred-objective admission when a cap-off device's smart task
  // transitions out of a plannable status (or the device is in an idle bucket). Binary-controlled
  // devices map to 'binary_restore'/'binary_release' and use the dedicated binary executor path;
  // everything else maps to 'shed_release', which causes the executor to issue the device's
  // configured shedBehavior (turn_off / set_temperature / set_step) exactly once, gated by
  // observed-state idempotency.
  deferredReleaseIntent?: 'binary_restore' | 'binary_release' | 'shed_release';
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  // Formal planner decision contract. UI/log text must be rendered from this structured reason.
  reason: DeviceReason;
  // Planner-only debug metadata. This must be stripped before the final plan snapshot is written.
  candidateReasons?: PlanCandidateReasons;
  zone?: string;
  controllable?: boolean;
  budgetExempt?: boolean;
  currentTemperature?: number;
  temperatureBoost?: TemperatureBoostConfig;
  temperatureBoostActive?: boolean;
  /**
   * Producer-resolved aggregate boost flag: `true` when either
   * `temperatureBoostActive` or `evBoostActive` fires this cycle. Resolved
   * once in `buildBoostPlanDeviceFields` so restore-side consumers read a
   * single bit instead of recomputing the OR per call.
   */
  boostActive?: boolean;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  binaryCommandPending?: boolean;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
  releaseShedStepId?: string | null;
  available?: boolean;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  pendingTargetCommand?: PendingTargetCommandSummary;
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  hasRecentObservedDrawAtSelectedStep?: boolean;
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
    softLimitSource?: 'capacity' | 'daily' | 'both';
    headroomKw: number;
    powerKnown?: boolean;
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

export type PelsStatusWriteReason = 'initial' | 'action_changed' | 'throttle';

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
