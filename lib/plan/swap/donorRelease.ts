import type { DevicePlanDevice } from '../planTypes';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { getSteppedLoadStep } from '../../../packages/shared-domain/src/deviceControlProfiles';

/** Confirm a swap donor's step-down from its report, never its planning fallback. */
export function hasReportedStepAtOrBelow(device: DevicePlanDevice, stepId: string): boolean {
  if (!isSteppedLoadDevice(device)) return false;
  const held = getSteppedLoadStep(device.steppedLoadProfile, stepId);
  const reported = getSteppedLoadStep(device.steppedLoadProfile, device.reportedStepId);
  return held !== null && reported !== null && reported.planningPowerW <= held.planningPowerW;
}
