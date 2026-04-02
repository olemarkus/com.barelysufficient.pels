import type { DevicePlanDevice } from './planTypes';
import type { RestoreTiming } from './planRestoreTiming';
import type { SwapState } from './planSwapState';
import { getInactiveReason, getSteppedRestoreCandidates } from './planRestoreDevices';
import { resolveCapacityRestoreBlockReason } from './planRestoreGate';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';

export function setRestorePlanDevice(
  deviceMap: Map<string, DevicePlanDevice>,
  id: string,
  updates: Partial<DevicePlanDevice>,
): void {
  const current = deviceMap.get(id);
  if (!current) return;
  deviceMap.set(id, { ...current, ...updates });
}

export function markSteppedDevicesStayAtCurrentLevel(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: Pick<RestoreTiming,
  | 'activeOvershoot'
  | 'inCooldown'
  | 'inRestoreCooldown'
  | 'restoreCooldownSeconds'
  | 'shedCooldownRemainingSec'
  | 'restoreCooldownRemainingSec'>;
  logDebug: (...args: unknown[]) => void;
}): void {
  const {
    deviceMap,
    timing,
    logDebug,
  } = params;
  const reason = resolveCapacityRestoreBlockReason({ timing });
  if (!reason) return;

  const steppedDevices = getSteppedRestoreCandidates(Array.from(deviceMap.values()));
  for (const dev of steppedDevices) {
    setRestorePlanDevice(deviceMap, dev.id, { reason });
    logDebug(`Plan: blocking stepped restore of ${dev.name} - ${reason}`);
  }
}

export function hasOtherDevicesWithUnconfirmedRecovery(
  deviceMap: Map<string, DevicePlanDevice>,
  deviceId: string,
): boolean {
  for (const device of deviceMap.values()) {
    if (device.id === deviceId) continue;
    if (device.controllable === false) continue;
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
    if (device.controllable === false) continue;
    if (getInactiveReason(device)) continue;
    if (isDeviceBlockingSteppedRestore(device, lastDeviceShedMs)) return true;
  }
  return false;
}

export function shouldBlockRestoreForSwap(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  logDebug: (...args: unknown[]) => void,
): boolean {
  const swappedFor = swapState.swappedOutFor.get(dev.id);
  if (!swappedFor) return false;
  const higherPriDev = deviceMap.get(swappedFor);
  if (higherPriDev && higherPriDev.currentState === 'off') {
    setRestorePlanDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: `swap pending (${higherPriDev.name})`,
    });
    logDebug(`Plan: blocking restore of ${dev.name} - was swapped out for ${higherPriDev.name} which is still off`);
    return true;
  }
  swapState.swappedOutFor.delete(dev.id);
  swapState.pendingSwapTargets.delete(swappedFor);
  swapState.pendingSwapTimestamps.delete(swappedFor);
  logDebug(`Plan: ${dev.name} can now be considered for restore - ${higherPriDev?.name ?? swappedFor} is restored`);
  return false;
}

export function shouldBlockRestoreForPendingSwap(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  logDebug: (...args: unknown[]) => void,
): boolean {
  if (swapState.pendingSwapTargets.size === 0 || swapState.pendingSwapTargets.has(dev.id)) return false;
  const devPriority = dev.priority ?? 100;
  for (const swapTargetId of swapState.pendingSwapTargets) {
    if (swapTargetId === dev.id) continue;
    const swapTargetDev = deviceMap.get(swapTargetId);
    if (!swapTargetDev) {
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
      continue;
    }
    const swapTargetPriority = swapTargetDev.priority ?? 100;
    if (swapTargetPriority <= devPriority && swapTargetDev.currentState === 'off') {
      setRestorePlanDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: `swap pending (${swapTargetDev.name})`,
      });
      logDebug(
        `Plan: blocking restore of ${dev.name} (p${devPriority}) - `
        + `swap target ${swapTargetDev.name} (p${swapTargetPriority}) should restore first`,
      );
      return true;
    }
    if (swapTargetDev.currentState === 'on') {
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
    }
  }
  return false;
}

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
  if (device.plannedState === 'shed') return true;
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
