import type { DevicePlanDevice } from './planTypes';
import type { RestoreTiming } from './planRestoreTiming';
import type { SwapState } from './planSwapState';
import type { PlanEngineState } from './planState';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getInactiveReason, getSteppedRestoreCandidates } from './planRestoreDevices';
import { resolveCapacityRestoreBlockReason } from './planRestoreTiming';
import {
  getSteppedLoadNextRestoreStep,
  isSteppedLoadDevice,
  resolveSteppedLoadRestoreDeltaKw,
} from './planSteppedLoad';
import { getSteppedLoadLowestActiveStep, getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { getActivationPenaltyLevel, getActivationRestoreBlockRemainingMs } from './planActivationBackoff';
import { computeRestoreBufferKw } from './planRestoreSwap';
import { RESTORE_ADMISSION_FLOOR_KW } from './planConstants';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
  type RestoreAdmissionMetrics,
} from './planRestoreAdmission';

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
  | 'inStartupStabilization'
  | 'restoreCooldownSeconds'
  | 'shedCooldownRemainingSec'
  | 'restoreCooldownRemainingSec'
  | 'startupStabilizationRemainingSec'>;
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

/**
 * Returns true if this device should be held back from restoring because a swap is still
 * in progress. Checks both whether this device was explicitly swapped out for a specific
 * higher-priority target (`swappedOutFor`), and whether any other higher-priority target
 * in `pendingSwapTargets` is still off. Also cleans up stale swap state.
 */
export function isBlockedBySwapState(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  logDebug: (...args: unknown[]) => void,
): boolean {
  if (isBlockedByDirectSwap(dev, deviceMap, swapState, logDebug)) return true;
  return isBlockedByPendingSwapTarget(dev, deviceMap, swapState, logDebug);
}

function isBlockedByDirectSwap(
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

function isBlockedByPendingSwapTarget(
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

export function blockRestoreForRecentActivationSetback(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  deviceId: string;
  deviceName: string | undefined;
  state: PlanEngineState;
  logDebug: (...args: unknown[]) => void;
  stepped: boolean;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    deviceMap,
    deviceId,
    deviceName,
    state,
    logDebug,
    stepped,
    debugStructured,
  } = params;
  const remainingMs = getActivationRestoreBlockRemainingMs({ state, deviceId });
  if (remainingMs === null) return false;
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const reason = `activation backoff (${remainingSeconds}s remaining)`;
  if (stepped) {
    setRestorePlanDevice(deviceMap, deviceId, { reason });
  } else {
    setRestorePlanDevice(deviceMap, deviceId, {
      plannedState: 'shed',
      reason,
    });
  }
  debugStructured?.({
    event: 'restore_blocked_setback',
    deviceId,
    deviceName,
    penaltyLevel: getActivationPenaltyLevel(state, deviceId),
    remainingMs,
    stepped,
  });
  logDebug(`Plan: blocking ${stepped ? 'stepped ' : ''}restore of ${deviceName} - ${reason}`);
  return true;
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

export function planRestoreForSteppedDevice(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  timing: Pick<RestoreTiming,
  | 'activeOvershoot'
  | 'inCooldown'
  | 'inRestoreCooldown'
  | 'inStartupStabilization'
  | 'restoreCooldownSeconds'
  | 'shedCooldownRemainingSec'
  | 'restoreCooldownRemainingSec'
  | 'startupStabilizationRemainingSec'>;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  logDebug: (...args: unknown[]) => void;
  debugStructured?: StructuredDebugEmitter;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, timing, availableHeadroom, restoredOneThisCycle, logDebug, debugStructured } = params;

  // Clear shed-invariant suppression tracking when no devices are shed, even if an earlier gate
  // returns first. Without this, tracking can survive into a new shed episode and suppress the
  // first restore_stepped_rejected log of that episode.
  if (countShedDevices(deviceMap, dev.id) === 0) {
    delete state.steppedRestoreRejectedByDevice[dev.id];
  }

  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  const gateReason = resolveCapacityRestoreBlockReason({ timing, restoredOneThisCycle });
  if (gateReason) {
    setRestorePlanDevice(deviceMap, dev.id, { reason: gateReason });
    logDebug(`Plan: blocking stepped restore of ${dev.name} - ${gateReason}`);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const waitingReason = resolveCapacityRestoreBlockReason({
    timing,
    waitingForOtherRecovery: hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.lastDeviceShedMs),
  });
  if (waitingReason) {
    setRestorePlanDevice(deviceMap, dev.id, { reason: waitingReason });
    logDebug(`Plan: blocking stepped restore of ${dev.name} - ${waitingReason}`);
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (blockRestoreForRecentActivationSetback({
    deviceMap, deviceId: dev.id, deviceName: dev.name, state, logDebug, stepped: true, debugStructured,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const nextStep = getSteppedLoadNextRestoreStep(dev);
  if (!nextStep || !dev.selectedStepId) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const lowestNonZeroStep = dev.steppedLoadProfile
    ? getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)
    : null;

  if (blockSteppedRestoreForShedInvariant({
    dev, deviceMap, state, nextStep, lowestNonZeroStep, phase, logDebug, debugStructured,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }
  delete state.steppedRestoreRejectedByDevice[dev.id];

  const deltaKw = resolveSteppedLoadRestoreDeltaKw({
    device: dev, fromStepId: dev.selectedStepId, toStepId: nextStep.id,
  });
  if (deltaKw <= 0) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  return admitSteppedRestore({
    dev, deviceMap, state, phase, nextStep, lowestNonZeroStep, deltaKw, availableHeadroom, debugStructured,
  });
}

function admitSteppedRestore(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  phase: 'startup' | 'runtime';
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
  deltaKw: number;
  availableHeadroom: number;
  debugStructured?: StructuredDebugEmitter;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, phase, nextStep, lowestNonZeroStep,
    deltaKw, availableHeadroom, debugStructured } = params;
  const restoreBuffer = computeRestoreBufferKw(deltaKw);
  const needed = deltaKw + restoreBuffer;
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: needed });
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (admission.postReserveMarginKw < RESTORE_ADMISSION_FLOOR_KW) {
    return rejectSteppedRestoreForInsufficientHeadroom({
      dev, deviceMap, phase, nextStep, lowestNonZeroStep, shedDeviceCount,
      admission, availableHeadroom, needed, debugStructured,
    });
  }
  setRestorePlanDevice(deviceMap, dev.id, {
    desiredStepId: nextStep.id,
    reason: `restore ${dev.selectedStepId} -> ${nextStep.id} (need ${needed.toFixed(2)}kW)`,
  });
  debugStructured?.({
    event: 'restore_stepped_admitted',
    deviceId: dev.id,
    deviceName: dev.name,
    phase,
    currentStepId: dev.selectedStepId,
    toStepId: nextStep.id,
    lowestNonZeroStepId: lowestNonZeroStep?.id,
    blockedByShedInvariant: false,
    shedDeviceCount,
    deltaKw,
    neededKw: needed,
    availableKw: availableHeadroom,
    ...buildRestoreAdmissionLogFields(admission),
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
    decision: 'admitted',
  });
  return { availableHeadroom: availableHeadroom - needed, restoredOneThisCycle: true };
}

function countShedDevices(deviceMap: Map<string, DevicePlanDevice>, excludeId: string): number {
  let count = 0;
  for (const device of deviceMap.values()) {
    if (device.id === excludeId) continue;
    if (device.controllable === false) continue;
    if (device.plannedState === 'shed') count += 1;
  }
  return count;
}

function blockSteppedRestoreForShedInvariant(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
  phase: 'startup' | 'runtime';
  logDebug: (...args: unknown[]) => void;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const { dev, deviceMap, state, nextStep, lowestNonZeroStep, phase, logDebug, debugStructured } = params;
  if (!lowestNonZeroStep || nextStep.planningPowerW <= lowestNonZeroStep.planningPowerW) return false;
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (shedDeviceCount === 0) return false;
  const reason = `shed invariant: ${dev.selectedStepId ?? 'unknown'} -> ${nextStep.id} blocked `
    + `(${shedDeviceCount} device(s) shed, max step: ${lowestNonZeroStep.id})`;
  setRestorePlanDevice(deviceMap, dev.id, { reason });

  const prev = state.steppedRestoreRejectedByDevice[dev.id];
  const unchanged = prev !== undefined
    && prev.requestedStepId === nextStep.id
    && prev.lowestNonZeroStepId === lowestNonZeroStep.id
    && prev.shedDeviceCount === shedDeviceCount;
  if (!unchanged) {
    logDebug(`Plan: blocking stepped restore of ${dev.name} - ${reason}`);
    debugStructured?.({
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      allowedMaxStepId: lowestNonZeroStep.id,
      blockedByShedInvariant: true,
      shedDeviceCount,
      decision: 'rejected',
      rejectionReason: 'shed_invariant',
    });
    state.steppedRestoreRejectedByDevice[dev.id] = {
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      shedDeviceCount,
    };
  }
  return true;
}

function rejectSteppedRestoreForInsufficientHeadroom(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  phase: 'startup' | 'runtime';
  nextStep: { id: string };
  lowestNonZeroStep: { id: string } | null;
  shedDeviceCount: number;
  admission: RestoreAdmissionMetrics;
  availableHeadroom: number;
  needed: number;
  debugStructured?: StructuredDebugEmitter;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, phase, nextStep, lowestNonZeroStep, shedDeviceCount,
    admission, availableHeadroom, needed, debugStructured } = params;
  const requiredKwWithFloor = admission.requiredKw + RESTORE_ADMISSION_FLOOR_KW;
  setRestorePlanDevice(deviceMap, dev.id, {
    reason: `insufficient headroom (need ${requiredKwWithFloor.toFixed(2)}kW, `
      + `headroom ${availableHeadroom.toFixed(2)}kW)`,
  });
  debugStructured?.({
    event: 'restore_stepped_rejected',
    deviceId: dev.id,
    deviceName: dev.name,
    phase,
    currentStepId: dev.selectedStepId,
    requestedStepId: nextStep.id,
    lowestNonZeroStepId: lowestNonZeroStep?.id,
    blockedByShedInvariant: false,
    shedDeviceCount,
    neededKw: needed,
    availableKw: availableHeadroom,
    ...buildRestoreAdmissionLogFields(admission),
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
    decision: 'rejected',
    rejectionReason: 'insufficient_headroom',
  });
  return { availableHeadroom, restoredOneThisCycle: false };
}
