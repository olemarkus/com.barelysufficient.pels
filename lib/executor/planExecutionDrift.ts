import type { DevicePlan, PlanInputDevice } from '../plan/planTypes';
import { isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import type {
  ExecutableDeviceIntent,
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import {
  buildExecutableDeviceIntent,
  buildExecutableObservedDeviceState,
} from './executablePlanProjection';

type PlanDevice = DevicePlan['devices'][number];
type BinaryState = 'on' | 'off';
type DriftPendingBinaryCommand =
  | { kind: 'pending'; desired: boolean | 'unknown' }
  | { kind: 'none' };
type DriftPendingStepCommand = { kind: 'pending' } | { kind: 'none' };
type DriftPendingTargetCommand =
  | { kind: 'pending'; desired: number }
  | { kind: 'none' };

type DriftRuntimeState = {
  pendingBinary: DriftPendingBinaryCommand;
  pendingStep: DriftPendingStepCommand;
  pendingTarget: DriftPendingTargetCommand;
};
type ExecutableSteppedLoadTransition = NonNullable<ExecutableSteppedLoadIntent['transition']>;

export function hasPlanExecutionDriftForDevice(params: {
  plan: DevicePlan;
  liveDevices: PlanInputDevice[];
  deviceId: string;
}): boolean {
  const { plan, liveDevices, deviceId } = params;
  const previous = plan.devices.find((device) => device.id === deviceId);
  if (!previous) return false;

  const live = liveDevices.find((device) => device.id === deviceId);
  if (!live) return false;
  return hasPlanDeviceExecutionDrift({ planDevice: previous, liveDevice: live });
}

export function hasPlanDeviceExecutionDrift(params: {
  planDevice: PlanDevice;
  liveDevice: PlanInputDevice;
}): boolean {
  const { planDevice, liveDevice } = params;
  return hasExecutableDeviceExecutionDrift({
    intent: buildExecutableDeviceIntent(planDevice),
    observed: buildExecutableObservedDeviceState(liveDevice),
    runtime: buildDriftRuntimeState(planDevice, liveDevice),
  });
}

function hasExecutableDeviceExecutionDrift(params: {
  intent: ExecutableDeviceIntent;
  observed: ExecutableObservedDeviceState;
  runtime: DriftRuntimeState;
}): boolean {
  // Drift compares observer-reported state with planner-intended state.
  // Observer-reported state is authoritative here — even a stale observation
  // is what the device actually shows, and re-actuating against a drift is
  // idempotent, so we no longer gate drift on observation freshness.
  const { intent, observed, runtime } = params;
  if (hasExecutableBinaryExecutionDrift(intent, observed, runtime)) return true;
  return hasExecutableTargetExecutionDrift(intent, observed, runtime);
}

// Drift no longer suppresses on observation staleness — observer-reported
// state is authoritative. Repeat-drift dampening depends on the per-axis
// pending-command flags (`binaryCommandPending`, `stepCommandPending`,
// `pendingTargetCommand`) being set whenever the executor dispatches a command
// in response to detected drift, and cleared on success/failure. Any future
// actuation path that bypasses those flags would turn the new behavior into a
// tight retry loop on unresponsive devices — `targetExecutor` reconcile mode
// in particular bypasses pending-target retry suppression, so the
// `pendingTarget` dampener below is what keeps drift from re-firing while a
// target command is awaiting settlement.
function buildDriftRuntimeState(
  planDevice: PlanDevice,
  liveDevice: PlanInputDevice,
): DriftRuntimeState {
  // `pendingTargetCommand` is engine state, projected onto the plan device by
  // `planBuilder.shouldExposePendingTargetCommand`. The plan snapshot is the
  // authoritative source for in-flight target commands; the input device only
  // carries observed capability values.
  const pendingTarget = planDevice.pendingTargetCommand;
  return {
    pendingBinary: liveDevice.binaryCommandPending === true
      ? {
        kind: 'pending',
        desired: typeof liveDevice.binaryCommandPendingDesired === 'boolean'
          ? liveDevice.binaryCommandPendingDesired
          : 'unknown',
      }
      : { kind: 'none' },
    pendingStep: liveDevice.stepCommandPending === true ? { kind: 'pending' } : { kind: 'none' },
    pendingTarget: pendingTarget
      ? { kind: 'pending', desired: pendingTarget.desired }
      : { kind: 'none' },
  };
}

function hasExecutableTargetExecutionDrift(
  intent: ExecutableDeviceIntent,
  observed: ExecutableObservedDeviceState,
  runtime: DriftRuntimeState,
): boolean {
  if (!intent.target) return false;
  if (intent.target.purpose !== 'shed_temperature' && hasNonTemperatureShedIntent(intent)) return false;
  if (isPendingTargetCommandMatchingExpected(runtime.pendingTarget, intent.target.desired)) return false;
  return !Object.is(observed.target?.observedValue, intent.target.desired);
}

function isPendingTargetCommandMatchingExpected(
  pending: DriftPendingTargetCommand,
  expectedTarget: number,
): boolean {
  if (pending.kind !== 'pending') return false;
  return Object.is(pending.desired, expectedTarget);
}

function hasNonTemperatureShedIntent(intent: ExecutableDeviceIntent): boolean {
  return intent.binary?.kind === 'shed' || intent.steppedLoad?.purpose === 'shed';
}

function hasExecutableBinaryExecutionDrift(
  intent: ExecutableDeviceIntent,
  observed: ExecutableObservedDeviceState,
  runtime: DriftRuntimeState,
): boolean {
  if (intent.steppedLoad) {
    return hasExecutableSteppedLoadExecutionDrift(intent.steppedLoad, observed, runtime);
  }
  const release = intent.release;
  if (release && (release.kind === 'ev_resume' || release.kind === 'ev_pause')) {
    return hasExecutableEvExecutionDrift({ ...release, kind: release.kind }, observed, runtime);
  }
  // shed_release is materialized at apply time via getShedBehavior; the resulting actuation
  // (binary off, target setpoint write, stepped command) reuses the same axis-specific
  // executor primitives that have their own pending-command dampening, so drift here is the
  // empty case — re-emission cycle-over-cycle is the intended idempotent behaviour.
  const expectedBinaryState = resolveExpectedBinaryStateForIntent(intent);
  return hasBinaryStateDrift({
    expectedBinaryState,
    observed,
    pendingBinary: runtime.pendingBinary,
  });
}

function hasExecutableEvExecutionDrift(
  intent: ExecutableReleaseIntent & { kind: 'ev_resume' | 'ev_pause' },
  observed: ExecutableObservedDeviceState,
  runtime: DriftRuntimeState,
): boolean {
  if (isPendingBinaryCommandMatchingExpected(runtime.pendingBinary, intent.kind === 'ev_resume' ? 'on' : 'off')) {
    return false;
  }
  const chargingState = observed.snapshot.evChargingState;
  if (intent.kind === 'ev_resume') {
    return chargingState === 'plugged_in_paused';
  }
  return chargingState === 'plugged_in_charging';
}

function hasExecutableSteppedLoadExecutionDrift(
  intent: ExecutableSteppedLoadIntent,
  observed: ExecutableObservedDeviceState,
  runtime: DriftRuntimeState,
): boolean {
  if (isSteppedBinaryTransitionInFlight(intent, observed, runtime)) return false;
  const expectedBinaryState = resolveExpectedBinaryStateForSteppedIntent(intent);
  if (hasBinaryStateDrift({ expectedBinaryState, observed, pendingBinary: runtime.pendingBinary })) {
    return true;
  }
  return hasSteppedStepDrift(intent, observed);
}

function hasBinaryStateDrift(params: {
  expectedBinaryState: BinaryState | undefined;
  observed: ExecutableObservedDeviceState;
  pendingBinary: DriftPendingBinaryCommand;
}): boolean {
  const { expectedBinaryState, observed, pendingBinary } = params;
  if (!expectedBinaryState) return false;
  if (isPendingBinaryCommandMatchingExpected(pendingBinary, expectedBinaryState)) return false;
  const observedBinaryState = observed.observedBinaryState;
  // `'unknown'` means no trusted binary observation has been recorded yet
  // (e.g. after a Homey restart, before any snapshot refresh). Treating a
  // defaulted `currentOn` as observation truth would re-actuate against
  // never-observed devices, so skip drift here and wait for real evidence.
  if (observedBinaryState === 'unknown') return false;
  return observedBinaryState !== expectedBinaryState;
}

function resolveExpectedBinaryStateForIntent(intent: ExecutableDeviceIntent): BinaryState | undefined {
  if (intent.binary?.kind === 'restore') {
    return intent.binary.source === 'controlled' ? 'on' : undefined;
  }
  if (intent.binary?.kind === 'shed') return 'off';
  return undefined;
}

function resolveExpectedBinaryStateForSteppedIntent(
  intent: ExecutableSteppedLoadIntent,
): BinaryState | undefined {
  if (intent.purpose === 'shed' && intent.shedAction === 'set_step') {
    const desiredStepId = intent.desired.stepId ?? intent.desired.plannedStepId;
    if (!desiredStepId) return undefined;
    return isSteppedLoadOffStep(intent.steppedLoadProfile, desiredStepId) ? 'off' : 'on';
  }
  if (intent.desired.on === true) return 'on';
  if (intent.desired.on === false) return 'off';
  if (intent.purpose === 'keep') return 'on';
  if (intent.shedAction !== 'set_step') return 'off';
  return undefined;
}

function isPendingBinaryCommandMatchingExpected(
  pending: DriftPendingBinaryCommand,
  expectedBinaryState: BinaryState,
): boolean {
  if (pending.kind !== 'pending') return false;
  if (pending.desired === 'unknown') return false;
  return (pending.desired ? 'on' : 'off') === expectedBinaryState;
}

function hasSteppedStepDrift(
  intent: ExecutableSteppedLoadIntent,
  observed: ExecutableObservedDeviceState,
): boolean {
  const observedStepId = observed.steppedLoad?.stepId;
  if (observedStepId === undefined) return false;
  return intent.planningCurrentStepId !== observedStepId;
}

function isSteppedBinaryTransitionInFlight(
  intent: ExecutableSteppedLoadIntent,
  observed: ExecutableObservedDeviceState,
  runtime: DriftRuntimeState,
): boolean {
  const transition = intent.transition;
  if (!transition || transition.binaryTarget === null) return false;
  if (!hasRelevantPendingForTransition(runtime, transition.binaryTarget)) return false;
  const liveStepId = observed.steppedLoad?.stepId;
  if (!isObservedStepAllowedForTransition(transition, liveStepId, intent.planningCurrentStepId)) return false;
  return isObservedBinaryStateForTransition(transition, observed);
}

function hasRelevantPendingForTransition(
  runtime: DriftRuntimeState,
  binaryTarget: boolean,
): boolean {
  if (hasConflictingPendingBinaryCommand(runtime.pendingBinary, binaryTarget)) return false;
  return runtime.pendingStep.kind === 'pending'
    || isPendingBinaryCommandMatchingExpected(runtime.pendingBinary, binaryTarget ? 'on' : 'off');
}

function isObservedStepAllowedForTransition(
  transition: ExecutableSteppedLoadTransition,
  liveStepId: string | undefined,
  previousStepId: string | undefined,
): boolean {
  if (transition.transitionPhase === 'binary_transition') {
    return Boolean(transition.commandStepId && liveStepId === transition.commandStepId);
  }
  if (transition.transitionPhase === 'step_preparation') {
    const expectedStepIds = new Set(
      [previousStepId, transition.commandStepId].filter((stepId): stepId is string => typeof stepId === 'string'),
    );
    return expectedStepIds.size === 0 || expectedStepIds.has(liveStepId ?? '');
  }
  return true;
}

function isObservedBinaryStateForTransition(
  transition: ExecutableSteppedLoadTransition,
  observed: ExecutableObservedDeviceState,
): boolean {
  if (observed.observedBinaryState === 'unknown') return false;
  if (transition.effectiveTransition === 'restore_from_off_at_low') return observed.observedBinaryState === 'off';
  if (transition.effectiveTransition === 'full_shed_to_off') return observed.observedBinaryState === 'on';
  return false;
}

function hasConflictingPendingBinaryCommand(
  pending: DriftPendingBinaryCommand,
  binaryTarget: boolean,
): boolean {
  return pending.kind === 'pending'
    && pending.desired !== 'unknown'
    && pending.desired !== binaryTarget;
}
