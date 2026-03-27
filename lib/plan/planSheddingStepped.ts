import type { PlanEngineState } from './planState';
import type { PlanInputDevice, ShedAction } from './planTypes';
import { getSteppedLoadLowestActiveStep } from '../utils/deviceControlProfiles';
import { isSteppedLoadDevice, getSteppedLoadShedTargetStep } from './planSteppedLoad';

export function resolveSteppedShedTargetStep(params: {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
  effectiveCurrentStepId?: string;
}) {
  const { device, devices, state, shedBehaviorAction, effectiveCurrentStepId } = params;
  const forceLowestActiveStep = shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== device.id && isNonSteppedDeviceRecovering(candidate, state));
  if (forceLowestActiveStep) {
    if (!isSteppedLoadDevice(device) || !device.steppedLoadProfile) return null;
    return getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  }
  return getSteppedLoadShedTargetStep({
    device,
    shedAction: shedBehaviorAction === 'set_step' ? 'set_step' : 'turn_off',
    currentDesiredStepId: effectiveCurrentStepId,
  });
}

function isNonSteppedDeviceRecovering(
  candidate: PlanInputDevice,
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>,
): boolean {
  if (candidate.controllable === false || isSteppedLoadDevice(candidate) || candidate.currentOn !== false) {
    return false;
  }
  if (state.swapByDevice[candidate.id]?.swappedOutFor || state.swapByDevice[candidate.id]?.pendingTarget) {
    return true;
  }
  const lastShedMs = state.lastDeviceShedMs[candidate.id];
  if (lastShedMs == null) return false;
  const lastRestoreMs = state.lastDeviceRestoreMs[candidate.id];
  return lastRestoreMs == null || lastRestoreMs < lastShedMs;
}
