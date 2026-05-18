import type { PlanEngineState } from './planState';
import type { PlanInputDevice, ShedAction } from './planTypes';
import { isObservedOff } from '../observer/observedState';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedLoadPlanningKw,
  resolveSteppedUnknownCurrentMeasuredShedding,
} from './planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';

export function resolveSteppedLoadDirectShedStepId(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: PlanEngineState;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  shouldShed: boolean;
  currentDesiredStepId?: string;
}): string | undefined {
  const {
    dev, devices, state, shedBehavior, shouldShed, currentDesiredStepId,
  } = params;
  if (!shouldShed || !isSteppedLoadDevice(dev)) return undefined;
  if (shedBehavior.action === 'turn_off') {
    const profile = dev.steppedLoadProfile;
    if (!profile) return undefined;
    return (getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile))?.id;
  }
  if (shedBehavior.action !== 'set_step') return undefined;
  if (shouldForceLowestActiveStep({ dev, devices, state, shedBehaviorAction: shedBehavior.action })) {
    return dev.steppedLoadProfile ? getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)?.id : undefined;
  }
  const targetStep = getSteppedLoadShedTargetStep({
    device: dev,
    shedAction: 'set_step',
    currentDesiredStepId,
  });
  return targetStep?.id
    ?? resolveSteppedUnknownCurrentMeasuredShedding({ device: dev, shedAction: 'set_step' })?.targetStep.id;
}

export function resolveSteppedShedCurrentDesiredStepId(dev: PlanInputDevice): string | undefined {
  if (!isSteppedLoadDevice(dev) || !dev.stepCommandPending || !dev.desiredStepId || !dev.selectedStepId) {
    return dev.selectedStepId;
  }
  const desiredKw = resolveSteppedLoadPlanningKw(dev, dev.desiredStepId);
  const selectedKw = resolveSteppedLoadPlanningKw(dev, dev.selectedStepId);
  return desiredKw < selectedKw ? dev.desiredStepId : dev.selectedStepId;
}

function shouldForceLowestActiveStep(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
}): boolean {
  const { dev, devices, state, shedBehaviorAction } = params;
  return shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== dev.id && isNonSteppedDeviceRecovering(candidate, state));
}

function isNonSteppedDeviceRecovering(
  candidate: PlanInputDevice,
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>,
): boolean {
  const observedOff = isObservedOff(candidate);
  if (candidate.controllable === false || isSteppedLoadDevice(candidate) || !observedOff) {
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
