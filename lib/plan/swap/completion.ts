import { getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import { resolveEffectiveCurrentOn } from '../planCurrentState';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import type { DevicePlanDevice } from '../planTypes';
import type { SwapState } from './state';

export function isSwapTargetComplete(
  device: DevicePlanDevice,
  swapState: SwapState,
): boolean {
  if (resolveEffectiveCurrentOn(device) !== true) return false;
  if (!isSteppedLoadDevice(device)) return true;

  const requestedStepId = resolveRequestedStepId(device, swapState);
  if (!requestedStepId || !device.steppedLoadProfile) return false;

  const requestedStep = getSteppedLoadStep(device.steppedLoadProfile, requestedStepId);
  const currentStep = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  if (!requestedStep || !currentStep) return false;

  return currentStep.planningPowerW >= requestedStep.planningPowerW;
}

function resolveRequestedStepId(
  device: DevicePlanDevice,
  swapState: SwapState,
): string | undefined {
  const requestedTarget = swapState.requestedTargetByDevice.get(device.id);
  return requestedTarget?.targetStepId
    ?? requestedTarget?.desiredStepId
    ?? device.targetStepId
    ?? device.desiredStepId;
}
