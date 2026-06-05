import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type {
  PlanInputDevice,
  StepPowerCalibrationView,
} from '../../packages/planner-types/src/planInputDevice';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  DeviceControlModel,
  DeviceControlAdapterSnapshot,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  PlannedDeviceState,
  RestorePowerSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TemperatureBoostConfig,
  TargetPowerSteppedLoadConfig,
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
 * Control-kind discriminant slices, slice 1 of the discriminated-types refactor.
 *
 * These intersection helpers pin the `controlModel` discriminant AND the
 * kind-specific fields that are *guaranteed present once the discriminant
 * holds* to REQUIRED, without changing the flat base types (`PlanInputDevice`
 * / `DevicePlanDevice` keep every field optional). The narrowing happens only
 * at the kind type-guards in `lib/plan/planSteppedLoad.ts`; consumers that
 * branch through a guard then read the kind-specific field without
 * optional-chaining or a null-assert.
 *
 * Field-level variant discrimination (moving fields off the base type so the
 * compiler forbids reading e.g. `currentTemperature` on a stepped device) is a
 * later slice and is deliberately NOT done here. `TargetDeviceSnapshot` is also
 * out of scope for this slice.
 */
export type SteppedLoadKind = {
  controlModel: 'stepped_load';
  // The stepped guard's predicate (`steppedLoadProfile?.model === 'stepped_load'`)
  // proves the profile is present, so it is required on the narrowed shape.
  steppedLoadProfile: SteppedLoadProfile;
};

export type SteppedPlanDevice = DevicePlanDevice & SteppedLoadKind;
export type SteppedPlanInputDevice = PlanInputDevice & SteppedLoadKind;

export type DevicePlanDevice = {
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
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
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
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  evChargingState?: string;
  // One-shot intent emitted by deferred-objective admission when a cap-off device's smart task
  // transitions out of a plannable status (or the device is in an idle bucket). EV chargers map
  // to 'ev_resume'/'ev_pause' and use the dedicated EV executor path; everything else maps to
  // 'shed_release', which causes the executor to issue the device's configured shedBehavior
  // (turn_off / set_temperature / set_step) exactly once, gated by observed-state idempotency.
  deferredReleaseIntent?: 'ev_resume' | 'ev_pause' | 'shed_release';
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
  evBoost?: EvBoostConfig;
  evBoostActive?: boolean;
  /**
   * Producer-resolved aggregate boost flag: `true` when either
   * `temperatureBoostActive` or `evBoostActive` fires this cycle. Resolved
   * once in `buildBoostPlanDeviceFields` so restore-side consumers read a
   * single bit instead of recomputing the OR per call.
   */
  boostActive?: boolean;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
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
