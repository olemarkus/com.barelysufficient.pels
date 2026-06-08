import type {
  DeviceControlAdapterSnapshot,
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
  release: ExecutableReleaseIntent | null;
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
  // Present iff binary control; absence is the old fabricated `currentOn: true`.
  binaryControl?: { on: boolean };
  /**
   * Binary observed state for drift comparison, resolved from the
   * producer-resolved binary state (an honest boolean — an unobserved binary
   * control resolves to a non-optimistic `false`). The executor actuates against
   * the observed value; freshness/abandon-grace is the producer's concern.
   */
  observedBinaryState: 'on' | 'off';
  target: ExecutableObservedTargetState | null;
  steppedLoad: ExecutableObservedSteppedLoadState | null;
};

export type ExecutableObservedTargetState = {
  targetCap: string;
  observedValue: unknown;
};

export type ExecutableObservedSteppedLoadState = {
  on: boolean | null;
  // Producer-resolved EFFECTIVE step (reported, or planning fallback when no
  // report). `reportedStepId` is the real telemetry; when it is absent,
  // `stepId` is the assumed fallback.
  stepId?: string;
  reportedStepId?: string;
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

export type ExecutableReleaseIntent = {
  kind: 'binary_restore' | 'binary_release' | 'shed_release';
  deviceId: string;
  name: string;
  // Producer-resolved release-cascade target step (configured `shedBehavior.stepId` →
  // lowest-active → off-step). Populated only for `shed_release` on a stepped device whose
  // configured shedBehavior is `set_step`; null otherwise (including for binary release/restore).
  // The lifecycle-end release executor reads this directly instead of re-running the
  // cascade at apply time.
  releaseShedStepId?: string | null;
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

/**
 * Producer-resolved current state used by the device-projection ONLY when the
 * device has no observation this cycle (absent from `getSnapshot()` between
 * planning and dispatch). The observed-state producer owns the resolution from
 * the plan device's effective values (`resolveEffectiveCurrentOn` /
 * `selectedStepId`); the executor never re-derives a planning fallback. When an
 * observation exists, the observed state is authoritative and this is ignored.
 */
export type ExecutableSteppedLoadCurrentFallback = {
  on: boolean | null;
  stepId?: string;
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
