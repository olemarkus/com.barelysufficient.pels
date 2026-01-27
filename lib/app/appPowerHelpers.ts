import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { sumControlledUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';
import { aggregateAndPruneHistory } from '../core/powerTracker';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';

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

export function persistPowerTrackerStateForApp(params: {
  homey: Homey.App['homey'];
  powerTracker: PowerTrackerState;
  error: (msg: string, err: Error) => void;
}): void {
  const { homey, powerTracker, error } = params;
  const writeStart = Date.now();
  try {
    homey.settings.set('power_tracker_state', powerTracker);
    addPerfDuration('settings_write_ms', Date.now() - writeStart);
    incPerfCounter('settings_set.power_tracker_state');
  } catch (err) {
    error('Failed to persist power tracker', err as Error);
  }
}

export function prunePowerTrackerHistoryForApp(params: {
  powerTracker: PowerTrackerState;
  logDebug: (msg: string) => void;
  error: (msg: string, err: Error) => void;
}): PowerTrackerState {
  const { powerTracker, logDebug, error } = params;
  logDebug('Pruning power tracker history');
  const pruneStart = Date.now();
  try {
    const pruned = aggregateAndPruneHistory(powerTracker);
    addPerfDuration('power_tracker_prune_ms', Date.now() - pruneStart);
    incPerfCounter('power_tracker_save_total');
    return pruned;
  } catch (err) {
    error('Failed to prune power tracker history', err as Error);
    return powerTracker;
  }
}

export function updateDailyBudgetAndRecordCapForApp(params: {
  powerTracker: PowerTrackerState;
  dailyBudgetService: {
    updateState: (options?: { forcePlanRebuild?: boolean; nowMs?: number }) => void;
    getSnapshot: () => DailyBudgetUiPayload | null;
  };
  options?: { nowMs?: number; forcePlanRebuild?: boolean };
}): PowerTrackerState {
  const { powerTracker, dailyBudgetService, options } = params;
  const updateStart = Date.now();
  dailyBudgetService.updateState(options);
  addPerfDuration('daily_budget_update_ms', Date.now() - updateStart);
  incPerfCounter('daily_budget_update_total');
  return recordDailyBudgetCap({
    powerTracker,
    snapshot: dailyBudgetService.getSnapshot(),
  });
}
