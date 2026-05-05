import type { Logger as PinoLogger } from '../../logging/logger';
import { SWAP_TIMEOUT_MS } from '../planConstants';
import type { DevicePlanDevice } from '../planTypes';
import { isSwapTargetComplete } from './completion';
import type { SwapRequestedTarget, SwapState } from './state';

export function markSwapTargetPending(
  swapState: SwapState,
  deviceId: string,
  timestamp = Date.now(),
): void {
  swapState.pendingSwapTargets.add(deviceId);
  swapState.pendingSwapTimestamps.set(deviceId, timestamp);
}

export function markDeviceSwappedOutFor(
  swapState: SwapState,
  deviceId: string,
  targetDeviceId: string,
): void {
  swapState.swappedOutFor.set(deviceId, targetDeviceId);
}

export function recordSwapPlanMeasurement(
  swapState: SwapState,
  deviceId: string,
  measurementTs: number | null,
): void {
  if (measurementTs !== null) {
    swapState.lastSwapPlanMeasurementTs.set(deviceId, measurementTs);
  }
}

export function recordRequestedTarget(
  swapState: SwapState,
  deviceId: string,
  requestedTarget: SwapRequestedTarget | undefined,
): void {
  if (!requestedTarget?.targetStepId && !requestedTarget?.desiredStepId) {
    swapState.requestedTargetByDevice.delete(deviceId);
    return;
  }
  swapState.requestedTargetByDevice.set(deviceId, requestedTarget);
}

export function clearSwapTarget(swapState: SwapState, targetDeviceId: string): void {
  swapState.pendingSwapTargets.delete(targetDeviceId);
  swapState.pendingSwapTimestamps.delete(targetDeviceId);
  swapState.lastSwapPlanMeasurementTs.delete(targetDeviceId);
  swapState.requestedTargetByDevice.delete(targetDeviceId);
}

export function clearSwapTargetPreservingMeasurement(swapState: SwapState, targetDeviceId: string): void {
  swapState.pendingSwapTargets.delete(targetDeviceId);
  swapState.pendingSwapTimestamps.delete(targetDeviceId);
  swapState.requestedTargetByDevice.delete(targetDeviceId);
}

export function clearDirectSwap(swapState: SwapState, deviceId: string): void {
  swapState.swappedOutFor.delete(deviceId);
}

export function clearMissingSwapTarget(swapState: SwapState, targetDeviceId: string): void {
  clearSwapTarget(swapState, targetDeviceId);
  clearDirectSwapsForTarget(swapState, targetDeviceId);
}

export function cleanupStaleSwaps(
  swapState: SwapState,
  structuredLog: PinoLogger | undefined,
): void {
  const swapCleanupNow = Date.now();
  const staleTargetIds = new Set<string>();
  for (const swapTargetId of swapState.pendingSwapTargets) {
    const swapTime = swapState.pendingSwapTimestamps.get(swapTargetId);
    if (swapTime !== undefined && swapCleanupNow - swapTime > SWAP_TIMEOUT_MS) {
      structuredLog?.info({
        event: 'swap_stale_cleared',
        deviceId: swapTargetId,
        ageMs: swapCleanupNow - swapTime,
      });
      staleTargetIds.add(swapTargetId);
    }
  }
  for (const staleTargetId of staleTargetIds) {
    clearSwapTargetPreservingMeasurement(swapState, staleTargetId);
  }
  clearDirectSwapsForTargets(swapState, staleTargetIds);
}

export function cleanupCompletedSwaps(
  swapState: SwapState,
  deviceMap: ReadonlyMap<string, DevicePlanDevice>,
): void {
  const completedTargetIds = new Set<string>();
  const missingTargetIds = new Set<string>();
  for (const swapTargetId of swapState.pendingSwapTargets) {
    const swapTarget = deviceMap.get(swapTargetId);
    if (!swapTarget) {
      missingTargetIds.add(swapTargetId);
    } else if (isSwapTargetComplete(swapTarget, swapState)) {
      completedTargetIds.add(swapTargetId);
    }
  }
  for (const missingTargetId of missingTargetIds) {
    clearSwapTarget(swapState, missingTargetId);
  }
  for (const completedTargetId of completedTargetIds) {
    clearSwapTargetPreservingMeasurement(swapState, completedTargetId);
  }
  clearDirectSwapsForTargets(swapState, missingTargetIds);
  clearDirectSwapsForTargets(swapState, completedTargetIds);
}

export function shouldKeepSwapTargetPending(params: {
  swapState: SwapState;
  deviceId: string;
  measurementTs: number | null;
}): boolean {
  const { swapState, deviceId, measurementTs } = params;
  if (!swapState.pendingSwapTargets.has(deviceId)) return false;
  const lastPlanMeasurementTs = swapState.lastSwapPlanMeasurementTs.get(deviceId);
  if (measurementTs === null) return true;
  if (lastPlanMeasurementTs === undefined) return true;
  return measurementTs <= lastPlanMeasurementTs;
}

export function shouldDeferSwapAdmissionForMeasurement(params: {
  swapState: SwapState;
  deviceId: string;
  measurementTs: number | null;
}): boolean {
  const { swapState, deviceId, measurementTs } = params;
  if (swapState.pendingSwapTargets.has(deviceId)) return false;
  const lastPlanMeasurementTs = swapState.lastSwapPlanMeasurementTs.get(deviceId);
  if (lastPlanMeasurementTs === undefined) return false;
  return measurementTs === null || measurementTs <= lastPlanMeasurementTs;
}

export function buildRequestedTargetFromDeviceUpdate(
  admittedDeviceUpdate: Partial<DevicePlanDevice> | undefined,
): SwapRequestedTarget | undefined {
  if (!admittedDeviceUpdate) return undefined;
  return {
    targetStepId: admittedDeviceUpdate.targetStepId,
    desiredStepId: admittedDeviceUpdate.desiredStepId,
  };
}

function clearDirectSwapsForTarget(swapState: SwapState, targetDeviceId: string): void {
  clearDirectSwapsForTargets(swapState, new Set([targetDeviceId]));
}

function clearDirectSwapsForTargets(swapState: SwapState, targetDeviceIds: ReadonlySet<string>): void {
  if (targetDeviceIds.size === 0) return;
  for (const [deviceId, targetId] of swapState.swappedOutFor) {
    if (targetDeviceIds.has(targetId)) {
      clearDirectSwap(swapState, deviceId);
    }
  }
}
