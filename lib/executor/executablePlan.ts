import type {
  DeviceControlAdapterSnapshot,
  SteppedLoadActualStepSource,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import type { SteppedStepActuationState } from './steppedLoadActuation';

export type ExecutablePlan = {
  devices: ExecutableDeviceIntent[];
};

export type ExecutableDeviceIntent = {
  id: string;
  name: string;
  controllable: boolean;
  target: ExecutableTargetIntent | null;
  binary: ExecutableBinaryIntent | null;
  ev: ExecutableEvIntent | null;
  steppedLoad: ExecutableSteppedLoadIntent | null;
  projectionError?: unknown;
};

export type ExecutableObservedState = {
  devices: ExecutableObservedDeviceState[];
};

export type ExecutableObservedDeviceState = {
  id: string;
  name: string;
  snapshot: TargetDeviceSnapshot;
  available: boolean | null;
  currentOn: boolean;
  /**
   * Discriminated binary observation for drift comparison. `'unknown'` means
   * no trusted binary observation has been recorded yet (e.g. after a Homey
   * restart, before any snapshot refresh). Drift detection skips binary
   * comparisons in that case so a defaulted `currentOn` cannot trigger a
   * spurious reapply against a never-observed device.
   */
  observedBinaryState: 'on' | 'off' | 'unknown';
  target: ExecutableObservedTargetState | null;
  steppedLoad: ExecutableObservedSteppedLoadState | null;
};

export type ExecutableObservedTargetState = {
  targetCap: string;
  observedValue: unknown;
};

export type ExecutableObservedSteppedLoadState = {
  on: boolean | null;
  stepId?: string;
  reportedStepId?: string;
  actualStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  assumedStepId?: string;
  measuredPowerKw?: number;
};

export type ExecutableBinaryIntent =
  | {
    kind: 'shed';
    deviceId: string;
    name: string;
    reason?: string;
  }
  | {
    kind: 'restore';
    deviceId: string;
    name: string;
    source: 'controlled' | 'uncontrolled';
  };

export type ExecutableEvIntent = {
  kind: 'ev_resume' | 'ev_pause';
  deviceId: string;
  name: string;
};

export type ExecutableTargetIntent = {
  deviceId: string;
  name: string;
  desired: number;
  purpose: 'target_update' | 'shed_temperature';
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

export type ExecutableSteppedLoadIntent = {
  id: string;
  name: string;
  purpose: 'keep' | 'shed';
  steppedLoadProfile: SteppedLoadProfile;
  communicationModel?: 'local' | 'cloud';
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  desired: ExecutableSteppedLoadDesiredState;
  planningCurrentOn: boolean | null;
  planningCurrentStepId?: string;
  previousStepId?: string;
  transition: ExecutableSteppedLoadTransition | null;
  matchingRestoreAttempt: ExecutableSteppedLoadRestoreAttempt;
  matchingCommandAttempt: ExecutableSteppedLoadRestoreAttempt;
  stepCommandRetryCount: number;
  nextStepCommandRetryAtMs?: number;
};

export type ExecutableSteppedLoadDevice = {
  id: string;
  name: string;
  purpose: 'keep' | 'shed';
  steppedLoadProfile: SteppedLoadProfile;
  communicationModel?: 'local' | 'cloud';
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
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
