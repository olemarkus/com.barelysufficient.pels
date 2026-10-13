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
} from '../plan/planSteppedLoad';
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveSteppedCommandAttempt } from './steppedCommandAttempt';

export function resolveConfirmedBinaryCommandReasonCode(
  pending: PlanEngineState['pendingBinaryCommands'][string],
): string {
  if (!pending.desired) return pending.lifecycleRelease ? 'lifecycle_release' : 'shedding';
  if (pending.logContext === 'capacity_control_off') {
    return 'capacity_control_off_restore';
  }
  return 'activation';
}

export function hasStableUncontrolledRestoreActuation(
  dev: DevicePlan['devices'][number],
  state: PlanEngineState,
): boolean {
  return dev.control.commandAuthority === false
    && dev.plannedState === 'keep'
    && isPlanDeviceObservedOff(dev)
    && state.shedDecisions.standingShedIds.has(dev.id);
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
  intent: ExecutableSteppedLoadIntent | undefined,
  action: ExecutableSteppedLoadDevice | null,
): boolean {
  return Boolean(intent !== undefined && intent.plannedShedTarget === undefined
    && action?.current.on === false);
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

/**
 * A kept stepped device whose planned step differs from its current one, with no
 * equivalent command already in flight.
 *
 * `intent` is the stepped intent dispatch will carry out
 * (`buildExecutableSteppedLoadIntent`), and its absence is the answer: the
 * projection holds a device the plan does not let change step (a
 * restore-admission hold, or a keep reason other than `keep` / `restoreNeed`),
 * so dispatch issues nothing for it and this must not ask for an apply either.
 * A hold never blocks lowering a device, so a running device's step-down under
 * one still has an intent and this gate reports it; dispatch writes it only
 * while the device's latest report is still above the target (`down_only`).
 */
export function hasStableSteppedLoadStepActuation(
  dev: DevicePlan['devices'][number],
  intent: ExecutableSteppedLoadIntent | undefined,
  commandSession: ExecutableSteppedLoadCommandSession,
): boolean {
  if (!intent || !isSteppedLoadDevice(dev) || dev.plannedState !== 'keep') return false;
  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, intent.desired.plannedStepId);
  if (!desiredStep) return false;
  if (shouldInitializeUnknownRunningStep(dev, desiredStep, commandSession)) return true;
  if (desiredStep.id === dev.selectedStepId) return false;
  // An EV target-power probe commands a rung outside the configured ladder,
  // which the decorator resolves the stored command against, so the plan device
  // carries no `lastDesiredStepId` for it. The plan's own desired step then
  // names the command in flight.
  const commanded = { ...dev, lastDesiredStepId: dev.lastDesiredStepId ?? dev.desiredStepId };
  if (resolveSteppedCommandAttempt(commanded, desiredStep.id, Date.now()) !== null) return false;
  const selectedStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  return selectedStep !== null && desiredStep.planningPowerW !== selectedStep.planningPowerW;
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
 * projection's hold (no intent) preserves planner-owned capacity and cooldown
 * holds.
 */
export function hasStableSteppedLoadBinaryRestoreActuation(
  dev: DevicePlan['devices'][number],
  intent: ExecutableSteppedLoadIntent | undefined,
): boolean {
  // No intent: the projection holds this device's state (see above).
  if (!intent || dev.plannedState !== 'keep') return false;
  // A binary handle is required: this is the binary-axis phase, and a step-only
  // stepper has no on/off to write (its restore rides the step axis instead).
  if (!isBinaryPlanDevice(dev)) return false;
  // The binary axis must read a trusted off: `currentOn` is the producer-resolved
  // strict boolean, the same gate the transition resolver uses for its
  // restore-from-off branch.
  if (dev.currentOn) return false;
  if (dev.binaryCommandPending === true) return false;
  const { transition } = intent;
  return transition?.binaryTarget === true && transition.transitionPhase === 'binary_transition';
}
