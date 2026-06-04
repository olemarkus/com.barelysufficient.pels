import type { PlanEngineState } from './planState';
import type { PlanInputDevice, ShedAction } from './planTypes';
import { isNonSteppedDeviceRecovering } from './planShedRecovery';
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
    return (getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile))?.id;
  }
  if (shedBehavior.action !== 'set_step') return undefined;
  if (shouldForceLowestActiveStep({ dev, devices, state, shedBehaviorAction: shedBehavior.action })) {
    return getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)?.id;
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
  state: Pick<PlanEngineState, 'shedDecidedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
}): boolean {
  const { dev, devices, state, shedBehaviorAction } = params;
  return shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== dev.id && isNonSteppedDeviceRecovering(candidate, state));
}
