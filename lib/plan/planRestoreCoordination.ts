import type { DevicePlanDevice } from './planTypes';
import { getInactiveReason, isRestoreLiveEligibleDevice } from './planRestoreDevices';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';

function isTargetRestorePending(device: DevicePlanDevice): boolean {
  return device.shedAction === 'set_temperature'
    && typeof device.plannedTarget === 'number'
    && device.currentTarget !== device.plannedTarget
    && device.pendingTargetCommand?.status === 'waiting_confirmation'
    && device.pendingTargetCommand?.desired === device.plannedTarget;
}

function isSteppedRestorePending(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device) || !device.steppedLoadProfile) return false;
  if (device.stepCommandPending !== true) return false;
  if (!device.selectedStepId || !device.desiredStepId || device.desiredStepId === device.selectedStepId) {
    return false;
  }
  const selectedStep = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  const desiredStep = getSteppedLoadStep(device.steppedLoadProfile, device.desiredStepId);
  if (!selectedStep || !desiredStep) return false;
  return desiredStep.planningPowerW > selectedStep.planningPowerW;
}

function isDeviceBlockingSteppedRestore(
  device: DevicePlanDevice,
  lastDeviceShedMs: Record<string, number>,
): boolean {
  if (device.observationStale === true) return false;
  if (!lastDeviceShedMs[device.id] || device.plannedState !== 'keep') return false;
  return device.currentState === 'off'
    || device.currentState === 'unknown'
    || isTargetRestorePending(device)
    || isSteppedRestorePending(device)
    || device.binaryCommandPending === true;
}

function isDeviceUnconfirmedRecoveryInFlight(device: DevicePlanDevice): boolean {
  if (device.observationStale === true) return false;
  if (device.plannedState !== 'keep') return false;
  return device.binaryCommandPending === true
    || isTargetRestorePending(device)
    || isSteppedRestorePending(device);
}

export function hasOtherDevicesWithUnconfirmedRecovery(
  deviceMap: Map<string, DevicePlanDevice>,
  deviceId: string,
): boolean {
  for (const device of deviceMap.values()) {
    if (device.id === deviceId) continue;
    if (!isRestoreLiveEligibleDevice(device)) continue;
    if (getInactiveReason(device)) continue;
    if (isDeviceUnconfirmedRecoveryInFlight(device)) return true;
  }
  return false;
}

export function hasOtherDevicesBlockingSteppedRestore(
  deviceMap: Map<string, DevicePlanDevice>,
  steppedDeviceId: string,
  lastDeviceShedMs: Record<string, number>,
): boolean {
  for (const device of deviceMap.values()) {
    if (device.id === steppedDeviceId) continue;
    if (!isRestoreLiveEligibleDevice(device)) continue;
    if (getInactiveReason(device)) continue;
    if (isDeviceBlockingSteppedRestore(device, lastDeviceShedMs)) return true;
  }
  return false;
}

export function countShedDevices(
  deviceMap: Map<string, DevicePlanDevice>,
  excludeId: string,
): number {
  let count = 0;
  for (const device of deviceMap.values()) {
    if (device.id === excludeId) continue;
    if (device.controllable === false) continue;
    if (device.plannedState === 'shed') count += 1;
  }
  return count;
}
