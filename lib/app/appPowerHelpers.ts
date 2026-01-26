import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { sumControlledUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';

export type PowerSampleRebuildState = {
  lastMs: number;
  lastPowerW?: number;
  pendingPowerW?: number;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

export function recordDailyBudgetCap(params: {
  powerTracker: PowerTrackerState;
  snapshot: DailyBudgetUiPayload | null;
}): PowerTrackerState {
  const { powerTracker, snapshot } = params;
  const today = snapshot?.days?.[snapshot.todayKey] ?? null;
  if (!today?.budget.enabled) return powerTracker;
  const planned = today.buckets.plannedKWh;
  const startUtc = today.buckets.startUtc;
  const index = today.currentBucketIndex;
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
  minPowerDeltaW: number;
  maxIntervalMs: number;
  currentPowerW: number;
  rebuildPlanFromCache: () => Promise<void>;
  logError: (error: Error) => void;
}): Promise<void> {
  const {
    getState,
    setState,
    minIntervalMs,
    minPowerDeltaW,
    maxIntervalMs,
    currentPowerW,
    rebuildPlanFromCache,
    logError,
  } = params;
  const state = getState();
  const now = Date.now();
  const elapsedMs = now - state.lastMs;
  const lastPowerW = state.lastPowerW;
  const deltaW = typeof lastPowerW === 'number' ? Math.abs(currentPowerW - lastPowerW) : null;
  const shouldRebuild = deltaW === null || deltaW >= minPowerDeltaW || elapsedMs >= maxIntervalMs;
  if (!shouldRebuild) {
    return Promise.resolve();
  }
  if (elapsedMs >= minIntervalMs) {
    setState({
      ...state,
      lastMs: now,
      lastPowerW: currentPowerW,
      pendingPowerW: undefined,
    });
    return rebuildPlanFromCache();
  }
  if (!state.pending) {
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    const pending = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const latest = getState();
        setState({
          ...latest,
          timer: undefined,
          lastMs: Date.now(),
          lastPowerW: typeof latest.pendingPowerW === 'number' ? latest.pendingPowerW : currentPowerW,
          pendingPowerW: undefined,
        });
        rebuildPlanFromCache()
          .catch((error) => {
            logError(error as Error);
          })
          .finally(() => {
            setState({ ...getState(), pending: undefined });
            resolve();
          });
      }, waitMs);
      setState({ ...getState(), timer, pendingPowerW: currentPowerW });
    });
    setState({ ...getState(), pending });
    return pending;
  }
  setState({ ...getState(), pendingPowerW: currentPowerW });
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
