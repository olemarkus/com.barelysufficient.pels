import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState, SwapEntry } from './planState';
import { SWAP_TIMEOUT_MS } from './planConstants';

export type SwapState = {
  pendingSwapTargets: Set<string>;
  pendingSwapTimestamps: Map<string, number>;
  swappedOutFor: Map<string, string>;
  lastSwapPlanMeasurementTs: Map<string, number>;
};

export type SwapStateSnapshot = {
  swapByDevice: Record<string, SwapEntry>;
};

export function buildSwapState(state: PlanEngineState): SwapState {
  const pendingSwapTargets = new Set<string>();
  const pendingSwapTimestamps = new Map<string, number>();
  const swappedOutFor = new Map<string, string>();
  const lastSwapPlanMeasurementTs = new Map<string, number>();

  for (const [deviceId, entry] of Object.entries(state.swapByDevice)) {
    if (entry.swappedOutFor !== undefined) {
      swappedOutFor.set(deviceId, entry.swappedOutFor);
    }
    if (entry.pendingTarget) {
      pendingSwapTargets.add(deviceId);
    }
    if (entry.timestamp !== undefined) {
      pendingSwapTimestamps.set(deviceId, entry.timestamp);
    }
    if (entry.lastPlanMeasurementTs !== undefined) {
      lastSwapPlanMeasurementTs.set(deviceId, entry.lastPlanMeasurementTs);
    }
  }

  return {
    pendingSwapTargets,
    pendingSwapTimestamps,
    swappedOutFor,
    lastSwapPlanMeasurementTs,
  };
}

export function exportSwapState(state: SwapState): SwapStateSnapshot {
  const swapByDevice: Record<string, SwapEntry> = {};

  const ensureEntry = (deviceId: string): SwapEntry => {
    const existing = swapByDevice[deviceId];
    if (existing) return existing;
    const entry: SwapEntry = {};
    swapByDevice[deviceId] = entry;
    return entry;
  };

  for (const [deviceId, targetId] of state.swappedOutFor) {
    ensureEntry(deviceId).swappedOutFor = targetId;
  }
  for (const deviceId of state.pendingSwapTargets) {
    ensureEntry(deviceId).pendingTarget = true;
  }
  for (const [deviceId, ts] of state.pendingSwapTimestamps) {
    ensureEntry(deviceId).timestamp = ts;
  }
  for (const [deviceId, ts] of state.lastSwapPlanMeasurementTs) {
    ensureEntry(deviceId).lastPlanMeasurementTs = ts;
  }

  return { swapByDevice };
}

export function cleanupStaleSwaps(
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  log: (...args: unknown[]) => void,
): void {
  const swapCleanupNow = Date.now();
  const pendingSwapTargets = Array.from(swapState.pendingSwapTargets);
  const staleTargetIds: string[] = [];
  for (const swapTargetId of pendingSwapTargets) {
    const swapTime = swapState.pendingSwapTimestamps.get(swapTargetId);
    if (swapTime !== undefined && swapCleanupNow - swapTime > SWAP_TIMEOUT_MS) {
      const swapName = deviceMap.get(swapTargetId)?.name || swapTargetId;
      log(
        `Plan: clearing stale swap for ${swapName} `
        + `(${Math.round((swapCleanupNow - swapTime) / 1000)}s since swap initiated)`,
      );
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
      staleTargetIds.push(swapTargetId);
    }
  }
  if (staleTargetIds.length > 0) {
    const staleSet = new Set(staleTargetIds);
    for (const [deviceId, targetId] of swapState.swappedOutFor) {
      if (staleSet.has(targetId)) {
        swapState.swappedOutFor.delete(deviceId);
      }
    }
  }
}
