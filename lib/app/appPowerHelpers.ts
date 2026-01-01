import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { sumControlledUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';

export type PowerSampleRebuildState = {
  lastMs: number;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

export function recordDailyBudgetCap(params: {
  powerTracker: PowerTrackerState;
  snapshot: DailyBudgetUiPayload | null;
}): PowerTrackerState {
  const { powerTracker, snapshot } = params;
  if (!snapshot?.budget.enabled) return powerTracker;
  const planned = snapshot.buckets.plannedKWh;
  const startUtc = snapshot.buckets.startUtc;
  const index = snapshot.currentBucketIndex;
  if (!Array.isArray(planned) || !Array.isArray(startUtc)) return powerTracker;
  if (index < 0 || index >= planned.length || index >= startUtc.length) return powerTracker;
  const plannedKWh = planned[index];
  const bucketKey = startUtc[index];
  if (!Number.isFinite(plannedKWh) || typeof bucketKey !== 'string') return powerTracker;
  const nextCaps = { ...(powerTracker.dailyBudgetCaps || {}), [bucketKey]: plannedKWh };
  return { ...powerTracker, dailyBudgetCaps: nextCaps };
}

export function schedulePlanRebuildFromPowerSample(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  minIntervalMs: number;
  rebuildPlanFromCache: () => Promise<void>;
  logError: (error: Error) => void;
}): Promise<void> {
  const { getState, setState, minIntervalMs, rebuildPlanFromCache, logError } = params;
  const state = getState();
  const now = Date.now();
  const elapsedMs = now - state.lastMs;
  if (elapsedMs >= minIntervalMs) {
    setState({ ...state, lastMs: now });
    return rebuildPlanFromCache();
  }
  if (!state.pending) {
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    const pending = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        setState({ ...getState(), timer: undefined, lastMs: Date.now() });
        rebuildPlanFromCache()
          .catch((error) => {
            logError(error as Error);
          })
          .finally(() => {
            setState({ ...getState(), pending: undefined });
            resolve();
          });
      }, waitMs);
      setState({ ...getState(), timer });
    });
    setState({ ...getState(), pending });
    return pending;
  }
  return getState().pending ?? Promise.resolve();
}

export async function recordPowerSampleForApp(params: {
  currentPowerW: number;
  nowMs?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  powerTracker: PowerTrackerState;
  capacityGuard?: CapacityGuard;
  homey: Homey.App['homey'];
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
}): Promise<void> {
  const {
    currentPowerW,
    nowMs = Date.now(),
    capacitySettings,
    getLatestTargetSnapshot,
    powerTracker,
    capacityGuard,
    homey,
    schedulePlanRebuild,
    saveState,
  } = params;
  const hourBudgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const snapshot = getLatestTargetSnapshot();
  const totalKw = snapshot.length ? sumControlledUsageKw(snapshot) : null;
  const controlledPowerW = totalKw !== null ? Math.max(0, totalKw * 1000) : undefined;
  await recordPowerSampleCore({
    state: powerTracker,
    currentPowerW,
    controlledPowerW,
    nowMs,
    capacityGuard,
    hourBudgetKWh,
    rebuildPlanFromCache: schedulePlanRebuild,
    saveState,
    homey,
  });
}
