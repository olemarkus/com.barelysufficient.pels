import type { HeadroomCardCooldownSource } from './planHeadroomDevice';
import type {
  DeviceControlModel,
  SteppedLoadActualStepSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetCapabilitySnapshot,
} from '../utils/types';

export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';

export type PendingTargetObservationSource =
  | 'rebuild'
  | 'snapshot_refresh'
  | 'realtime_capability'
  | 'device_update';

export type PendingTargetCommandSummary = {
  desired: number;
  retryCount: number;
  nextRetryAtMs: number;
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
  currentState: string;
  plannedState: string;
  currentTarget: unknown;
  plannedTarget: number | null;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
  desiredStepId?: string;
  lastDesiredStepId?: string;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default' | 'step-planning';
  measuredPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  budgetExempt?: boolean;
  currentTemperature?: number;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
  shedStepId?: string | null;
  available?: boolean;
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

export type PlanInputDevice = {
  id: string;
  name: string;
  targets: TargetCapabilitySnapshot[];
  deviceType?: 'temperature' | 'onoff';
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
  desiredStepId?: string;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  hasBinaryControl?: boolean;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  priority?: number;
  currentOn?: boolean;
  evChargingState?: string;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default' | 'step-planning';
  measuredPowerKw?: number;
  currentTemperature?: number;
  controllable?: boolean;
  managed?: boolean;
  budgetExempt?: boolean;
  available?: boolean;
  zone?: string;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
};
