import type { DevicePlan } from './planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';

/**
 * The step the latest plan wants a stepped device on, as a rung of the ladder the
 * caller holds. The plan's own decision, read for the executor's feedback
 * lifecycle through a setup-wired port so lib/executor imports no planner type.
 */
export function resolveLatestPlanDesiredStepId(
  plan: DevicePlan | null | undefined,
  deviceId: string,
  profile: SteppedLoadProfile,
): string | undefined {
  const plannedDevice = plan?.devices.find((device) => device.id === deviceId);
  return getSteppedLoadStep(
    profile,
    plannedDevice?.targetStepId ?? plannedDevice?.desiredStepId,
  )?.id;
}
