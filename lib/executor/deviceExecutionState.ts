import { isBinaryDrivenIntent } from './executableDesiredState';
import { hasBinaryCommand } from './executablePlan';
import type { DeviceExecutionState, AxisProgress } from '../planContract/deviceExecutionState';
import type { ExecutableDeviceIntent, ExecutableObservedDeviceState } from './executablePlan';
import { hasSteppedCommand, hasTargetCommand, hasReleaseCommand } from './executablePlan';
import type { DriftCommandRead } from './driftObservedDevice';
import { getSteppedLoadStep, isSteppedLoadStepOff } from '../../packages/shared-domain/src/deviceControlProfiles';
import {
  resolveExpectedBinaryStateForIntent,
  resolveExpectedBinaryStateForSteppedIntent,
  isPendingBinaryCommandMatchingExpected,
} from './executionExpectations';

export type ExecutionCommandState = DriftCommandRead & { target: { desired: number } | null };

/** Comparison, never command eligibility. Pending suppression is not settlement. */
function progress<T>(desired: T | null, observed: T | null, pending: boolean): AxisProgress {
  if (desired === null) return 'undriven';
  if (pending) return 'pending';
  if (observed === null) return 'unobserved';
  return Object.is(desired, observed) ? 'settled' : 'unmet';
}

function resolveDesiredBinary(intent: ExecutableDeviceIntent): DeviceExecutionState['desiredBinary'] {
  if (hasReleaseCommand(intent)) {
    if (intent.release.kind === 'binary_restore') return 'on';
    if (intent.release.kind === 'binary_release') return 'off';
  }
  if (hasSteppedCommand(intent)) return resolveExpectedBinaryStateForSteppedIntent(intent.steppedLoad) ?? null;
  return resolveExpectedBinaryStateForIntent(intent) ?? null;
}

function resolveDesiredStep(intent: ExecutableDeviceIntent): string | null {
  if (!hasSteppedCommand(intent)) return null;
  const stepped = intent.steppedLoad;
  if (stepped.plannedShedTarget?.kind === 'binary_off') return null;
  if (stepped.plannedShedTarget?.kind === 'step') return stepped.plannedShedTarget.stepId ?? null;
  return stepped.desired.stepId ?? null;
}

function resolveDesiredTarget(intent: ExecutableDeviceIntent): number | null {
  if (!hasTargetCommand(intent)) return null;
  if (hasSteppedCommand(intent)) {
    const shed = intent.steppedLoad.plannedShedTarget;
    if (shed !== undefined && shed.kind !== 'target_value') return null;
  }
  if (resolveDesiredBinary(intent) === 'off') return null;
  return intent.target.desired;
}

function resolvePhysicalState(
  observed: ExecutableObservedDeviceState | undefined,
): DeviceExecutionState['physicalState'] {
  if (!observed || (observed.binaryControl === undefined && observed.steppedLoad === null)) return 'not_applicable';
  return observed.observedEffectiveOn ? 'on' : 'off';
}

function resolveBinaryProgress(
  intent: ExecutableDeviceIntent,
  desired: DeviceExecutionState['desiredBinary'],
  observed: ExecutableObservedDeviceState | undefined,
  command: DriftCommandRead['binary'],
): AxisProgress {
  let actual: string | null = observed ? resolvePhysicalState(observed) : null;
  const drivesBinary = hasBinaryCommand(intent)
    || (hasSteppedCommand(intent) && isBinaryDrivenIntent(intent.steppedLoad))
    || (hasReleaseCommand(intent) && intent.release.kind !== 'shed_release');
  if (drivesBinary) actual = observed?.binaryControl ? observed.observedBinaryAxis : null;
  return progress(desired, actual, desired !== null && isPendingBinaryCommandMatchingExpected(command, desired));
}

function resolveResumeExpected(
  intent: ExecutableDeviceIntent,
  desiredBinary: DeviceExecutionState['desiredBinary'],
  desiredStepId: string | null,
): boolean {
  if (desiredBinary === 'off') return false;
  if (desiredBinary === 'on') return true;
  if (!hasSteppedCommand(intent)) return false;
  const step = getSteppedLoadStep(intent.steppedLoad.steppedLoadProfile, desiredStepId);
  return step !== null && !isSteppedLoadStepOff(step);
}

function resolveTargetProgress(
  desired: number | null,
  observed: ExecutableObservedDeviceState | undefined,
  command: ExecutionCommandState['target'],
): AxisProgress {
  return progress(desired, observed?.target?.observedValue ?? null, command?.desired === desired);
}

export function resolveDeviceExecutionState(
  intent: ExecutableDeviceIntent,
  observed: ExecutableObservedDeviceState | undefined,
  command: ExecutionCommandState,
  externalOffHeld: boolean,
): DeviceExecutionState {
  const desiredBinary = externalOffHeld ? null : resolveDesiredBinary(intent);
  const desiredStepId = externalOffHeld ? null : resolveDesiredStep(intent);
  const desiredTarget = externalOffHeld ? null : resolveDesiredTarget(intent);
  const observedStepId = observed?.steppedLoad?.reportedStepId ?? null;
  const physicalState = resolvePhysicalState(observed);
  const binaryProgress = resolveBinaryProgress(intent, desiredBinary, observed, command.binary);
  const stepProgress = progress(desiredStepId, observedStepId, command.step.kind === 'pending');
  return {
    available: observed?.available === true && intent.projectionError === undefined,
    physicalState,
    observedStepId,
    desiredBinary, desiredStepId, binaryProgress, stepProgress,
    targetProgress: resolveTargetProgress(desiredTarget, observed, command.target),
    resumeExpected: physicalState === 'off' && resolveResumeExpected(intent, desiredBinary, desiredStepId),
    steppedTransitionPending: hasSteppedCommand(intent) && (binaryProgress === 'pending' || stepProgress === 'pending'),
    externalOffHeld,
  };
}
