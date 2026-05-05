import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { aggregateAndPruneHistory, recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';

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

export async function recordPowerSampleForApp(params: {
  currentPowerW: number;
  nowMs?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  powerTracker: PowerTrackerState;
  capacityGuard?: CapacityGuard;
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
}): Promise<void> {
  const snapshotStart = Date.now();
  const {
    currentPowerW,
    nowMs = Date.now(),
    capacitySettings,
    getLatestTargetSnapshot,
    powerTracker,
    capacityGuard,
    schedulePlanRebuild,
    saveState,
  } = params;
  const hourBudgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const snapshot = getLatestTargetSnapshot();
  const { controlledKw } = snapshot.length
    ? splitControlledUsageKw({
      devices: snapshot,
      totalKw: currentPowerW / 1000,
    })
    : { controlledKw: null };
  const exemptKw = snapshot.length ? sumBudgetExemptLiveUsageKw(snapshot) : null;
  const controlledPowerW = controlledKw !== null ? Math.max(0, controlledKw * 1000) : undefined;
  const exemptPowerW = exemptKw !== null ? Math.max(0, exemptKw * 1000) : undefined;
  addPerfDuration('power_sample_snapshot_ms', Date.now() - snapshotStart);
  await recordPowerSampleCore({
    state: powerTracker,
    currentPowerW,
    controlledPowerW,
    exemptPowerW,
    nowMs,
    capacityGuard,
    hourBudgetKWh,
    rebuildPlanFromCache: schedulePlanRebuild,
    saveState,
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
  dailyBudgetService.updateState(options);
  return recordDailyBudgetCap({
    powerTracker,
    snapshot: dailyBudgetService.getSnapshot(),
  });
}
