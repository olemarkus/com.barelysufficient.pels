import type { DeviceControlAdapterSnapshot, SteppedLoadProfile } from '../utils/types';
import type { SteppedStepActuationState } from './steppedLoadActuation';

export type ExecutablePlanDevice<TPlanDevice = unknown> = {
  planDevice: TPlanDevice;
};

export type ExecutablePlan<TPlanDevice = unknown> = {
  devices: ExecutablePlanDevice<TPlanDevice>[];
};

export type ProjectedExecutablePlanDevice<TPlanDevice = unknown> = ExecutablePlanDevice<TPlanDevice> & {
  steppedLoad: ExecutableSteppedLoadDevice | null;
};

export type ExecutableTargetCommand = {
  deviceId: string;
  name: string;
  targetCap: string;
  desired: number;
  observedValue: unknown;
};

export type ExecutableTargetUpdate = ExecutableTargetCommand & {
  isRestoring: boolean;
};

export type ExecutableSteppedLoadTransition = {
  effectiveTransition:
    | 'full_shed_to_off'
    | 'restore_from_off_at_low'
    | 'step_down_while_on'
    | 'step_up_while_on'
    | 'steady';
  stepPreparationPurpose: 'prepare_for_off' | 'prepare_for_on' | null;
  binaryTarget: boolean | null;
  commandStepId: string | undefined;
  plannedDesiredStepId: string | undefined;
  transitionPhase: 'step_preparation' | 'binary_transition' | 'settled';
};

export type ExecutableSteppedLoadRestoreAttempt = {
  status: 'awaiting_confirmation' | 'awaiting_power_settle' | 'retry_backoff';
  requestedStepId: string;
} | null;

export type ExecutableSteppedLoadState = {
  on: boolean | null;
  stepId?: string;
};

export type ExecutableSteppedLoadCurrentState = ExecutableSteppedLoadState & {
  stepForShed?: {
    stepId: string;
    planningPowerW: number;
  };
  stepIsOffStep: boolean;
};

export type ExecutableSteppedLoadDesiredState = ExecutableSteppedLoadState & {
  plannedStepId?: string;
};

export type ExecutableSteppedLoadDevice = {
  id: string;
  name: string;
  steppedLoadProfile: SteppedLoadProfile;
  communicationModel?: 'local' | 'cloud';
  controlAdapter?: DeviceControlAdapterSnapshot;
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  current: ExecutableSteppedLoadCurrentState;
  desired: ExecutableSteppedLoadDesiredState;
  previousStepId?: string;
  transition: ExecutableSteppedLoadTransition | null;
  stepActuation: SteppedStepActuationState;
  commandStepActuation: SteppedStepActuationState;
  matchingRestoreAttempt: ExecutableSteppedLoadRestoreAttempt;
  matchingCommandAttempt: ExecutableSteppedLoadRestoreAttempt;
  stepNeedsAdjustment: boolean;
  stepCommandRetryCount: number;
  nextStepCommandRetryAtMs?: number;
};
