import { getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import type { DevicePlanDevice } from '../planTypes';
import type { SwapState } from './state';

export function isSwapTargetComplete(
  device: DevicePlanDevice,
  swapState: SwapState,
): boolean {
  // A binary swap target that is off is not yet complete. A step-only stepper has
  // no binary handle (no `currentOn`) — its completion is decided ENTIRELY on the
  // step axis (the confirmed-step check below), so it must not be short-circuited
  // here just for being non-binary, or its swapped-out source is held until the
  // stale-swap timeout instead of being released the moment the step confirms.
  if (isBinaryPlanDevice(device) && !device.currentOn) return false;
  if (!isSteppedLoadDevice(device)) {
    // Non-stepped: a binary device completes when on; a device with neither a
    // binary handle nor a step has no completion concept.
    return isBinaryPlanDevice(device);
  }

  const requestedStepId = resolveRequestedStepId(device, swapState);
  if (!requestedStepId) return false;

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
