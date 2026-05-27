import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  DeviceControlModel,
  DeviceControlAdapterSnapshot,
  BinaryControlObservation,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  SteppedLoadActualStepSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TemperatureBoostConfig,
  TargetCapabilitySnapshot,
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

export type DevicePlanDevice = {
  id: string;
  name: string;
  deviceClass?: string;
  // Transitional snapshot field only. Planner truth must come from currentState.
  currentOn: boolean;
  currentState: string;
  plannedState: string;
  currentTarget: number | null;
  plannedTarget?: number;
  observationStale?: boolean;
  communicationModel?: 'local' | 'cloud';
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  reportedStepId?: string;
  targetStepId?: string;
  selectedStepId?: string;
  desiredStepId?: string;
  previousStepId?: string;
  lastDesiredStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  hasBinaryControl?: boolean;
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
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  binaryCommandPending?: boolean;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
  shedStepId?: string | null;
  available?: boolean;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  pendingTargetCommand?: PendingTargetCommandSummary;
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  hasRecentObservedDrawAtSelectedStep?: boolean;
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

export type PlanInputDevice = {
  id: string;
  name: string;
  targets: TargetCapabilitySnapshot[];
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  observationStale?: boolean;
  communicationModel?: 'local' | 'cloud';
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  reportedStepId?: string;
  targetStepId?: string;
  selectedStepId?: string;
  desiredStepId?: string;
  previousStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  hasBinaryControl?: boolean;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  priority?: number;
  /**
   * Producer-resolved bit (chunk 2 of the planner-detype refactor): true when
   * the device is commandable in this cycle, false when physically blocked
   * (EV unplugged/discharging, snapshot `available === false`, etc.). Optional
   * for the duration of the dual-read transition; chunk 6 makes it required.
   * Consumers MUST go through `lib/device/deviceActionProjection.isCommandableNow`
   * (or the boost equivalent) so the dual-read fallback applies uniformly.
   */
  commandableNow?: boolean;
  /** Opaque diagnostic string; UI / diagnostics consumers only. */
  commandableNowReason?: string | null;
  /**
   * Producer-resolved aggregate boost flag (chunk 2): true if either the
   * temperature-boost or EV-boost policy is active this cycle.
   */
  boostActive?: boolean;
  /**
   * Producer-resolved residual-kW projection (chunk 3 of the planner-detype
   * refactor). `shed` is the observable kW the configured shed behavior would
   * remove if applied right now (post-kind-switch). Consumers in
   * `lib/plan/planRemainingSheddableLoad.ts` read this directly after the
   * flat plan-cycle gates instead of branching on the device's discriminated-
   * union kind. Optional for the duration of the dual-read transition; chunk
   * 6 makes it required. Future chunks layer `restore` (chunk 4) and
   * potentially `keep` (chunk 5) on this same field.
   */
  residualKw?: {
    shed: number;
  };
  // Raw observed binary snapshot input. Planner decisions should resolve through currentState helpers.
  currentOn: boolean;
  currentState?: string;
  evChargingState?: string;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  currentTemperature?: number;
  temperatureBoost?: TemperatureBoostConfig;
  evBoost?: EvBoostConfig;
  // Set by the deferred limit-lower-priority rescue lane (admission) to force boost on while
  // the smart task is in its planned hours; the boost resolvers honour it independent of the
  // device's own boost config/threshold, so the escalation/shedding machinery claims capacity
  // from lower-priority devices.
  forceBoostActive?: boolean;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  controllable?: boolean;
  managed?: boolean;
  budgetExempt?: boolean;
  available?: boolean;
  zone?: string;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  binaryCommandPending?: boolean;
  binaryCommandPendingDesired?: boolean;
  binaryControlObservation?: BinaryControlObservation;
  /**
   * Per-step calibrated power view, populated at plan-build time from the
   * persisted power-calibration store. When a `(deviceId, stepId)` pair has
   * confident observations, admission and delivery estimates are learned from
   * samples inside that configured step's power band and bounded by its
   * configured step power.
   * Missing entries mean the planner should fall back to `planningPowerW`
   * from the profile.
   */
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  /**
   * True when the calibration store has a recent positive observation at the
   * device's currently reported step. Used by boost-driven stepped escalation
   * to avoid escalating a device that isn't accepting load at its current
   * step.
   */
  hasRecentObservedDrawAtSelectedStep?: boolean;
};

export type StepPowerCalibrationView = {
  admissionPowerKw: number;
  deliveryPowerKw: number;
};
