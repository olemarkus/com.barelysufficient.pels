import type { DevicePlan, DevicePlanDevice } from '../plan/planTypes';
import type { ExecutablePlan, ProjectedExecutablePlanDevice } from './executablePlan';
import { buildExecutableSteppedLoadDevice } from './executableSteppedLoadProjection';

export function buildExecutablePlan(plan: DevicePlan): ExecutablePlan<DevicePlanDevice> {
  return {
    devices: plan.devices.map((planDevice) => ({
      planDevice,
    })),
  };
}

export function buildExecutablePlanDevice(
  planDevice: DevicePlanDevice,
): ProjectedExecutablePlanDevice<DevicePlanDevice> {
  return {
    planDevice,
    steppedLoad: buildExecutableSteppedLoadDevice(planDevice),
  };
}
