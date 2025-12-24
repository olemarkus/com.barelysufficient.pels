import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { SWAP_TIMEOUT_MS } from './planConstants';

export type SwapState = {
  pendingSwapTargets: Set<string>;
  pendingSwapTimestamps: Map<string, number>;
  swappedOutFor: Map<string, string>;
  lastSwapPlanMeasurementTs: Map<string, number>;
};

export type SwapStateSnapshot = {
  pendingSwapTargets: Set<string>;
  pendingSwapTimestamps: Record<string, number>;
  swappedOutFor: Record<string, string>;
  lastSwapPlanMeasurementTs: Record<string, number>;
};

export function buildSwapState(state: PlanEngineState): SwapState {
  return {
    pendingSwapTargets: new Set(state.pendingSwapTargets),
    pendingSwapTimestamps: new Map(Object.entries(state.pendingSwapTimestamps).map(([id, ts]) => [id, ts])),
    swappedOutFor: new Map(Object.entries(state.swappedOutFor)),
    lastSwapPlanMeasurementTs: new Map(Object.entries(state.lastSwapPlanMeasurementTs).map(([id, ts]) => [id, ts])),
  };
}

export function exportSwapState(state: SwapState): SwapStateSnapshot {
  return {
    pendingSwapTargets: new Set(state.pendingSwapTargets),
    pendingSwapTimestamps: Object.fromEntries(state.pendingSwapTimestamps),
    swappedOutFor: Object.fromEntries(state.swappedOutFor),
    lastSwapPlanMeasurementTs: Object.fromEntries(state.lastSwapPlanMeasurementTs),
  };
}

export function cleanupStaleSwaps(
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  log: (...args: unknown[]) => void,
): void {
  const swapCleanupNow = Date.now();
  for (const swapTargetId of [...swapState.pendingSwapTargets]) {
    const swapTime = swapState.pendingSwapTimestamps.get(swapTargetId);
    if (swapTime && swapCleanupNow - swapTime > SWAP_TIMEOUT_MS) {
      const swapName = deviceMap.get(swapTargetId)?.name || swapTargetId;
      log(`Plan: clearing stale swap for ${swapName} (${Math.round((swapCleanupNow - swapTime) / 1000)}s since swap initiated)`);
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
      for (const [deviceId, targetId] of swapState.swappedOutFor.entries()) {
        if (targetId === swapTargetId) {
          swapState.swappedOutFor.delete(deviceId);
        }
      }
    }
  }
}
