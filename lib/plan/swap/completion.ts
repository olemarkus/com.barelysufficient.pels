import { getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import { isObservedOn } from '../../observer/observedState';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import type { DevicePlanDevice } from '../planTypes';
import type { SwapState } from './state';

export function isSwapTargetComplete(
  device: DevicePlanDevice,
  swapState: SwapState,
): boolean {
  if (!isObservedOn(device)) return false;
  if (!isSteppedLoadDevice(device)) return true;

  const requestedStepId = resolveRequestedStepId(device, swapState);
  if (!requestedStepId || !device.steppedLoadProfile) return false;

  const requestedStep = getSteppedLoadStep(device.steppedLoadProfile, requestedStepId);
  // Decide completion from CONFIRMED evidence (reportedStepId), not the planner-effective
  // selectedStepId — the latter can be an observer-resolved planning fallback that has not yet
  // materialized on the device. A null/unknown reportedStepId yields a null step here, so we
  // treat the swap as NOT complete and keep the lower-priority source shed until the target's
  // step is actually confirmed.
  const reportedStep = getSteppedLoadStep(device.steppedLoadProfile, device.reportedStepId);
  if (!requestedStep || !reportedStep) return false;

  return reportedStep.planningPowerW >= requestedStep.planningPowerW;
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
