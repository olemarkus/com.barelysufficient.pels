import type { ExecutablePlan, ProjectedExecutablePlanDevice } from '../executor/executablePlan';
import { buildExecutableSteppedLoadDevice } from './planExecutableSteppedLoad';
import type { DevicePlan, DevicePlanDevice } from './planTypes';

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
