import type { DevicePlan, PlanInputDevice } from './planTypes';

export function buildLiveStatePlan(plan: DevicePlan, liveDevices: PlanInputDevice[]): DevicePlan {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  return {
    ...plan,
    devices: plan.devices.map((device) => {
      const live = liveById.get(device.id);
      if (!live) return device;
      return {
        ...device,
        currentState: resolveCurrentStateFromPlanInput(live.currentOn, live.hasBinaryControl),
        currentTarget: Array.isArray(live.targets) && live.targets.length > 0 ? live.targets[0].value ?? null : null,
        currentTemperature: live.currentTemperature,
        powerKw: live.powerKw,
        expectedPowerKw: live.expectedPowerKw,
        expectedPowerSource: live.expectedPowerSource,
        measuredPowerKw: live.measuredPowerKw,
        controlCapabilityId: live.controlCapabilityId,
        evChargingState: live.evChargingState,
        available: live.available,
        zone: live.zone ?? device.zone,
        controllable: live.controllable ?? device.controllable,
      };
    }),
  };
}

export function hasPlanExecutionDrift(previousPlan: DevicePlan, livePlan: DevicePlan): boolean {
  if (previousPlan.devices.length !== livePlan.devices.length) return true;
  for (let index = 0; index < previousPlan.devices.length; index += 1) {
    const previous = previousPlan.devices[index];
    const live = livePlan.devices[index];
    if (previous.id !== live.id) return true;
    if (previous.currentState !== live.currentState) return true;
    if (previous.currentTarget !== live.currentTarget) return true;
  }
  return false;
}

export function canRefreshPlanSnapshotFromLiveState(
  basePlan: DevicePlan,
  livePlan: DevicePlan,
): boolean {
  if (!hasPlanExecutionDrift(basePlan, livePlan)) return false;
  if (basePlan.devices.length !== livePlan.devices.length) return false;

  for (let index = 0; index < basePlan.devices.length; index += 1) {
    const baseDevice = basePlan.devices[index];
    const liveDevice = livePlan.devices[index];
    if (!liveDevice || baseDevice.id !== liveDevice.id) return false;
    if (!hasSettledPostActuationState(baseDevice, liveDevice)) return false;
  }
  return true;
}
export function hasPlanExecutionDriftForDevice(
  previousPlan: DevicePlan,
  liveDevices: PlanInputDevice[],
  deviceId: string,
): boolean {
  const previous = previousPlan.devices.find((device) => device.id === deviceId);
  if (!previous) return false;

  const live = liveDevices.find((device) => device.id === deviceId);
  if (!live) return false;

  const liveCurrentState = resolveCurrentStateFromPlanInput(live.currentOn, live.hasBinaryControl);
  const liveCurrentTarget = Array.isArray(live.targets) && live.targets.length > 0
    ? live.targets[0].value ?? null
    : null;

  return previous.currentState !== liveCurrentState || previous.currentTarget !== liveCurrentTarget;
}

function resolveCurrentStateFromPlanInput(currentOn?: boolean, hasBinaryControl?: boolean): string {
  if (typeof currentOn === 'boolean') return currentOn ? 'on' : 'off';
  if (hasBinaryControl === false) return 'not_applicable';
  return 'unknown';
}

function hasSettledPostActuationState(
  baseDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (baseDevice.available === false || liveDevice.available === false) return true;
  if (requiresBinaryRestore(baseDevice) && liveDevice.currentState !== 'on') return false;
  if (requiresBinaryShed(baseDevice) && liveDevice.currentState !== 'off') return false;
  if (requiresTargetUpdate(baseDevice) && liveDevice.currentTarget !== baseDevice.plannedTarget) return false;
  return true;
}

function requiresBinaryRestore(device: DevicePlan['devices'][number]): boolean {
  return device.controllable !== false
    && device.plannedState === 'keep'
    && device.currentState === 'off';
}

function requiresBinaryShed(device: DevicePlan['devices'][number]): boolean {
  return device.plannedState === 'shed'
    && device.currentState !== 'off'
    && device.shedAction !== 'set_temperature';
}

function requiresTargetUpdate(device: DevicePlan['devices'][number]): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  return typeof device.plannedTarget === 'number' && device.plannedTarget !== device.currentTarget;
}
