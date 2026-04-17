import type { HeadroomCardCooldownSource } from './planHeadroomDevice';
import type {
  DeviceControlModel,
  SteppedLoadActualStepSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  SteppedLoadStepSource,
  TargetCapabilitySnapshot,
} from '../utils/types';

export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';

export type PendingTargetObservationSource =
  | 'rebuild'
  | 'snapshot_refresh'
  | 'realtime_capability'
  | 'device_update';

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

export type DevicePlanDevice = {
  id: string;
  name: string;
  deviceClass?: string;
  // Transitional snapshot field only. Planner truth must come from currentState.
  currentOn: boolean;
  currentState: string;
  plannedState: string;
  currentTarget: number | null;
  plannedTarget: number | null;
  observationStale?: boolean;
  communicationModel?: 'local' | 'cloud';
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  reportedStepId?: string;
  targetStepId?: string;
  inferredStepId?: string;
  stepSource?: SteppedLoadStepSource;
  selectedStepId?: string;
  desiredStepId?: string;
  lastDesiredStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  budgetExempt?: boolean;
  currentTemperature?: number;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  binaryCommandPending?: boolean;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
  shedStepId?: string | null;
  available?: boolean;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  headroomCardBlocked?: boolean;
  headroomCardCooldownSec?: number | null;
  headroomCardCooldownSource?: HeadroomCardCooldownSource;
  headroomCardCooldownFromKw?: number | null;
  headroomCardCooldownToKw?: number | null;
  pendingTargetCommand?: PendingTargetCommandSummary;
};

export type DevicePlan = {
  meta: {
    totalKw: number | null;
    softLimitKw: number;
    capacitySoftLimitKw?: number;
    dailySoftLimitKw?: number | null;
    softLimitSource?: 'capacity' | 'daily' | 'both';
    headroomKw: number | null;
    capacityShortfall?: boolean;
    shortfallBudgetThresholdKw?: number;
    shortfallBudgetHeadroomKw?: number | null;
    hardCapHeadroomKw?: number | null;
    hourlyBudgetExhausted?: boolean;
    usedKWh?: number;
    budgetKWh?: number;
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

export type PlanSnapshotWriteReason = 'action_changed' | 'detail_changed' | 'meta_only';
export type PelsStatusWriteReason = 'initial' | 'action_changed' | 'throttle';

export type StatusPlanChanges = Pick<
  PlanChangeSet,
  'actionChanged' | 'actionSignature' | 'detailSignature' | 'metaSignature'
>;

export type PlanRebuildOutcome = {
  buildMs: number;
  changeMs: number;
  snapshotMs: number;
  snapshotWriteMs: number;
  statusMs: number;
  statusWriteMs: number;
  applyMs: number;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
  appliedActions: boolean;
  deviceWriteCount: number;
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
  inferredStepId?: string;
  stepSource?: SteppedLoadStepSource;
  selectedStepId?: string;
  desiredStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  hasBinaryControl?: boolean;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  priority?: number;
  // Raw observed binary snapshot input. Planner decisions should resolve through currentState helpers.
  currentOn: boolean;
  evChargingState?: string;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  currentTemperature?: number;
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
};
