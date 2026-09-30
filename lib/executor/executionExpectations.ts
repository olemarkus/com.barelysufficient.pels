import { isBinaryDrivenIntent } from './executableDesiredState';
import { hasBinaryCommand } from './executablePlan';
import type { ExecutableDeviceIntent, ExecutableSteppedLoadIntent } from './executablePlan';
import type { DriftCommandRead } from './driftObservedDevice';
import { isSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';

type BinaryState = 'on' | 'off';

export function resolveExpectedBinaryStateForIntent(intent: ExecutableDeviceIntent): BinaryState | undefined {
  if (!hasBinaryCommand(intent)) return undefined;
  // The managed -> unmanaged release is opportunistic: it undoes a prior shed
  // rather than demanding a state, so it sets no drift expectation.
  if (intent.binary.desiredOn) return intent.binary.source === 'controlled' ? 'on' : undefined;
  return 'off';
}

export function resolveExpectedBinaryStateForSteppedIntent(
  intent: ExecutableSteppedLoadIntent,
): BinaryState | undefined {
  const shedTarget = intent.plannedShedTarget;
  // A shed that ends at a step decides the binary axis through that step: off
  // only if the step itself is the off step.
  if (shedTarget?.kind === 'step') {
    if (!shedTarget.stepId) return undefined;
    return isSteppedLoadOffStep(intent.steppedLoadProfile, shedTarget.stepId) ? 'off' : 'on';
  }
  if (isBinaryDrivenIntent(intent)) return intent.desiredOn ? 'on' : 'off';
  // Neither a binary drive nor a shed target defines the axis, so this cycle
  // demands nothing of it. Answering 'on' here would invent an expectation the
  // plan never made and drive a restore off it.
  return undefined;
}

export function isPendingBinaryCommandMatchingExpected(
  pending: DriftCommandRead['binary'],
  expectedBinaryState: BinaryState,
): boolean {
  if (pending.kind !== 'pending') return false;
  if (pending.desired === 'unknown') return false;
  return (pending.desired ? 'on' : 'off') === expectedBinaryState;
}

