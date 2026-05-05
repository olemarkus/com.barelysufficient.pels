import type { PlanEngineState, SwapEntry } from '../planState';

export type SwapRequestedTarget = {
  targetStepId?: string;
  desiredStepId?: string;
};

export type SwapState = {
  pendingSwapTargets: Set<string>;
  pendingSwapTimestamps: Map<string, number>;
  swappedOutFor: Map<string, string>;
  lastSwapPlanMeasurementTs: Map<string, number>;
  requestedTargetByDevice: Map<string, SwapRequestedTarget>;
};

export type SwapStateSnapshot = {
  swapByDevice: Record<string, SwapEntry>;
};

export function buildSwapState(state: PlanEngineState): SwapState {
  const pendingSwapTargets = new Set<string>();
  const pendingSwapTimestamps = new Map<string, number>();
  const swappedOutFor = new Map<string, string>();
  const lastSwapPlanMeasurementTs = new Map<string, number>();
  const requestedTargetByDevice = new Map<string, SwapRequestedTarget>();

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
    if (entry.requestedTargetStepId !== undefined || entry.requestedDesiredStepId !== undefined) {
      requestedTargetByDevice.set(deviceId, {
        targetStepId: entry.requestedTargetStepId,
        desiredStepId: entry.requestedDesiredStepId,
      });
    }
  }

  return {
    pendingSwapTargets,
    pendingSwapTimestamps,
    swappedOutFor,
    lastSwapPlanMeasurementTs,
    requestedTargetByDevice,
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
  for (const [deviceId, requestedTarget] of state.requestedTargetByDevice) {
    const entry = ensureEntry(deviceId);
    if (requestedTarget.targetStepId !== undefined) {
      entry.requestedTargetStepId = requestedTarget.targetStepId;
    }
    if (requestedTarget.desiredStepId !== undefined) {
      entry.requestedDesiredStepId = requestedTarget.desiredStepId;
    }
  }

  return { swapByDevice };
}
