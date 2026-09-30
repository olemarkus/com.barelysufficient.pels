import type { DevicePlan } from '../plan/planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';

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
