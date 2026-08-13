import type {
  DeviceControlAdapterSnapshot,
  DeviceDescriptor,
  ObservedDeviceState,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { SteppedStepActuationState } from './steppedLoadActuation';

export type ExecutablePlan = {
  devices: ExecutableDeviceIntent[];
};

/**
 * The decomposed snapshot surface the executor consumes: observer-owned
 * observed truth (`ObservedDeviceState`) plus the descriptor config its
 * actuation gates read (commandability and the stepped-load ladder).
 * Deliberately narrower than the raw producer
 * `TargetDeviceSnapshot` — the executor is a downstream consumer, so it depends
 * on the decomposed halves, never the full producer snapshot. The full snapshot
 * remains structurally assignable to this, so producers feed it unchanged.
 */
export type ExecutorDeviceSnapshot = ObservedDeviceState
  & Pick<
    DeviceDescriptor,
    | 'capabilities'
    | 'canSetControl'
    | 'communicationModel'
    | 'deviceClass'
  >
  & SteppedLoadDescriptorProbe
  & { currentOn?: boolean; commandableNow?: boolean };

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
  snapshot: ExecutorDeviceSnapshot;
  available: boolean | null;
  commandableNow: boolean;
  // The raw observed binary axis, carried for the actuation-path readers
  // (`executableSteppedLoadProjection` / `shedReleaseActuation` read it via
  // `isBinaryOnOrUnknown`). Present on the executor/dispatch path (raw snapshot);
  // absent (undefined) on the drift/reconcile path, which feeds a plan device that
  // carries `currentOn` instead — those readers are never reached on that path.
  binaryControl?: { on: boolean };
  /**
   * Binary observed state for drift comparison, an honest boolean (an unobserved
   * binary control resolves to a non-optimistic `false`). The executor actuates
   * against the observed value; freshness/abandon-grace is the producer's concern.
   *
   * Path-dependent by design: built from a live `PlanInputDevice` (drift/reconcile
   * path) it is the producer-resolved `currentOn` (binary axis AND stepped-off
   * fold); built from a raw transport snapshot (executor/dispatch path, no
   * `currentOn`) it is the raw binary axis (`isBinaryOnOrUnknown`). The two agree
   * for pure-binary devices and diverge only for a binary+stepped device parked at
   * its off step — where the drift path WANTS the folded "effectively off" value
   * (the stepped step-drift catches the step) and the dispatch path WANTS the raw
   * axis (`shedReleaseActuation` decides whether to also issue a binary-on).
   */
  observedBinaryState: 'on' | 'off';
  target: ExecutableObservedTargetState | null;
  steppedLoad: ExecutableObservedSteppedLoadState | null;
};

export type ExecutableObservedTargetState = {
  target: 'temperature';
  observedValue: unknown;
};

export type ExecutableObservedSteppedLoadState = {
  on: boolean | null;
  // Producer-resolved EFFECTIVE step (reported, or planning fallback when no
  // report). `reportedStepId` is the real telemetry; when it is absent,
  // `stepId` is the assumed fallback.
  stepId?: string;
  reportedStepId?: string;
  /**
   * Producer-resolved current draw (`getCurrentDrawKw`), REQUIRED. Read by
   * exactly one consumer: `resolveObservedStepForShed` prices an unknown-step
   * `set_step` shed from it when no step id is available. It used to be an
   * optional `measuredPowerKw`, fed the raw snapshot field on one path and an
   * adapted `currentDrawKw` on the other — one name for two provenances, with
   * nothing at either end saying who read it.
   */
  currentDrawKw: number;
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
  communicationModel?: 'local' | 'cloud';
  purpose: 'target_update' | 'shed_temperature';
};

export type ExecutableTargetCommand = {
  deviceId: string;
  name: string;
  target: 'temperature';
  desired: number;
  observedValue: unknown;
  communicationModel?: 'local' | 'cloud';
};

export type ExecutableTargetUpdate = ExecutableTargetCommand & {
  isRestoring: boolean;
};

export type ExecutableSteppedLoadTransition = {
  effectiveTransition:
    | 'full_shed_to_off'
    | 'restore_from_off_at_low'
    | 'initialize_unknown_step_at_low'
    | 'step_down_while_on'
    | 'step_up_while_on'
    | 'steady';
  stepPreparationPurpose: 'prepare_for_off' | 'prepare_for_on' | 'initialize_unknown_step' | null;
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
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  desired: ExecutableSteppedLoadDesiredState;
  previousStepId?: string;
  transition: ExecutableSteppedLoadTransition | null;
  matchingRestoreAttempt: ExecutableSteppedLoadRestoreAttempt;
  matchingCommandAttempt: ExecutableSteppedLoadRestoreAttempt;
  stepCommandRetryCount: number;
  nextStepCommandRetryAtMs?: number;
  // Step of the last issued step command when that command was confirmed by
  // device-side feedback (`stepCommandStatus === 'success'`). Consumed as
  // restore-preparation materialization evidence only while the device is
  // observed off — see `ExecutableSteppedStepState.confirmedCommandStepId`.
  confirmedCommandStepId?: string;
};

export type ExecutableSteppedLoadDevice = {
  id: string;
  name: string;
  purpose: 'keep' | 'shed';
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
  initializationStepId?: string;
};

export type ExecutableSteppedLoadCommandSession = {
  initializationAssumedStepId?: string;
  hasPriorStepCommand: boolean;
  reportedStepId?: string;
};
