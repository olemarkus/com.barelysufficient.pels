import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan, SteppedPlanDevice } from '../plan/planTypes';
import type { PlanEngineState } from '../plan/planState';
import type {
  ExecutableSteppedLoadCommandSession,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import {
  isPlanDeviceObservedOff,
  isPlanDeviceObservedOn,
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
} from '../plan/planSteppedLoad';
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveBinaryShedReasonCode } from './lifecycleReleaseRecording';

export function resolveConfirmedBinaryCommandReasonCode(
  pending: PlanEngineState['pendingBinaryCommands'][string],
): string {
  if (!pending.desired) {
    return resolveBinaryShedReasonCode(pending.reason, pending.lifecycleRelease);
  }
  if (pending.logContext === 'capacity_control_off') {
    return 'capacity_control_off_restore';
  }
  return pending.restoreSource ?? 'current_plan';
}

export function hasStableUncontrolledRestoreActuation(
  dev: DevicePlan['devices'][number],
  state: PlanEngineState,
): boolean {
  return dev.controllable === false
    && dev.plannedState === 'keep'
    && isPlanDeviceObservedOff(dev)
    && Boolean(state.shedDecidedMs[dev.id]);
}

/**
 * Restore-log source label: `shed_state` when the planner still holds the
 * device in capacity-shed posture (decided-shed more recently than it was
 * restored), else `current_plan`. Reads the decision-time `shedDecidedMs`
 * clock so a write-skipped shed is still attributed to the shed state. The
 * result is a log field only — no decision branches on it.
 */
export function resolveRestoreLogSource(
  state: PlanEngineState,
  deviceId: string,
): 'shed_state' | 'current_plan' {
  const shedDecidedMs = state.shedDecidedMs[deviceId];
  if (!shedDecidedMs) return 'current_plan';
  const lastRestoreMs = state.lastDeviceRestoreMs[deviceId];
  return !lastRestoreMs || lastRestoreMs < shedDecidedMs ? 'shed_state' : 'current_plan';
}

export function hasStableBinaryReleaseActuation(dev: DevicePlan['devices'][number]): boolean {
  if (dev.binaryCommandPending === true) return false;
  if (dev.deferredReleaseIntent === 'binary_restore') {
    // Released = off-but-commandable, the only state a restore acts on. A device
    // with no control capability this cycle is not binary → not "observed off".
    // `currentOn` is the producer-resolved on/off truth (binary axis + stepped-off).
    return isBinaryPlanDevice(dev) && dev.currentOn === false && isCommandableNow(dev);
  }
  if (dev.deferredReleaseIntent === 'binary_release') {
    // On (the consolidated binary truth = `currentOn`). Non-binary keeps the prior
    // "on/unknown" default (true) so a release without observed-off evidence is not
    // yet stable.
    return isBinaryPlanDevice(dev) ? dev.currentOn : true;
  }
  return false;
}

export function isSteppedLoadRestoreFromOff(
  intent: ExecutableSteppedLoadIntent | null,
  action: ExecutableSteppedLoadDevice | null,
): boolean {
  return Boolean(intent?.purpose === 'keep' && action?.current.on === false);
}

const shouldInitializeUnknownRunningStep = (
  dev: SteppedPlanDevice,
  desiredStep: NonNullable<ReturnType<typeof getSteppedLoadStep>>,
  commandSession: ExecutableSteppedLoadCommandSession,
): boolean => {
  return dev.reportedStepId === undefined
    && dev.lastDesiredStepId === undefined
    && isPlanDeviceObservedOn(dev)
    && desiredStep.planningPowerW > 0
    && commandSession.reportedStepId === undefined
    && commandSession.initializationAssumedStepId === undefined
    && !commandSession.hasPriorStepCommand;
};

export function hasStableSteppedLoadStepActuation(
  dev: DevicePlan['devices'][number],
  commandSession: ExecutableSteppedLoadCommandSession,
): boolean {
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep') return false;
  const desiredStepId = resolveSteppedKeepDesiredStepId(dev);
  if (!desiredStepId) return false;
  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  if (!desiredStep) return false;
  if (shouldInitializeUnknownRunningStep(dev, desiredStep, commandSession)) {
    return allowsSteppedLoadKeepInvariantRestore(dev.reason);
  }
  if (desiredStepId === dev.selectedStepId) return false;
  if (hasEquivalentSteppedLoadCommandHold(dev, desiredStepId)) return false;

  const selectedStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  if (!selectedStep) return false;
  if (desiredStep.planningPowerW < selectedStep.planningPowerW) {
    // Stepping down. "Off" is kind-aware: a binary stepper via `currentOn`, a
    // step-only stepper (no onoff handle) via the step axis. Not-off ⇒ it can
    // still shed further (stable); when off, stability hinges on not being held
    // for a restore.
    return !isPlanDeviceObservedOff(dev) || !isRestoreHoldReason(dev.reason);
  }
  return desiredStep.planningPowerW > selectedStep.planningPowerW
    && allowsSteppedLoadKeepInvariantRestore(dev.reason);
}

/**
 * Keeps an observed-OFF binary stepper actionable even when its desired plan
 * signature is unchanged. Restore is one ordered executor operation: binary ON
 * first, then an immediate desired-step reassertion because activation may
 * reset the device's step.
 *
 * The plan signature carries desired state, not the fresh OFF observation, so
 * the regular step-actuation predicate can be stable while the binary axis
 * still needs work. This companion predicate makes sure the executor runs.
 * Commandability remains enforced downstream against the live snapshot. The
 * reason allow-set preserves planner-owned capacity and cooldown holds.
 */
export function hasStableSteppedLoadBinaryRestoreActuation(
  dev: DevicePlan['devices'][number],
): boolean {
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep') return false;
  // A binary handle is required: this is the binary-axis phase, and a step-only
  // stepper has no on/off to write (its restore rides the step axis instead).
  if (!isBinaryPlanDevice(dev)) return false;
  // The binary axis must read a trusted off: `currentOn` is the producer-resolved
  // strict boolean, the same gate the transition resolver uses for its
  // restore-from-off branch.
  if (dev.currentOn) return false;
  if (dev.binaryCommandPending === true) return false;
  if (!allowsSteppedLoadKeepInvariantRestore(dev.reason)) return false;
  const transition = resolveSteppedLoadTransition(dev, resolveSteppedKeepDesiredStepId(dev));
  return transition?.binaryTarget === true && transition.transitionPhase === 'binary_transition';
}

export function hasEquivalentSteppedLoadCommandHold(
  dev: DevicePlan['devices'][number],
  desiredStepId: string,
): boolean {
  const lastDesiredStepId = dev.lastDesiredStepId ?? dev.desiredStepId;
  const sameCommand = lastDesiredStepId === desiredStepId;
  if (!sameCommand) return false;
  if (dev.stepCommandPending === true) return true;
  return dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && Date.now() < dev.nextStepCommandRetryAtMs;
}

export function isRestoreHoldReason(reason: DeviceReason | undefined): boolean {
  return reason ? isRestoreAdmissionHoldReason(reason) : false;
}
