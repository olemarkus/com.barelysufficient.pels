import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import { updateObjectiveProfilesFromSnapshot } from '../core/objectiveProfiles';
import type { PowerTrackerState } from '../core/powerTracker';
import { aggregateAndPruneHistory, recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload, DailyBudgetUpdateStateOptions } from '../dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../logging/logger';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';

export type PowerTrackerPersistReason =
  | 'scheduled'
  | 'hour_rollover'
  | 'prune'
  | 'ui_replace'
  | 'uninit'
  | 'write';

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

const buildFreshMeasuredDevicePowerWById = (params: {
  devices: TargetDeviceSnapshot[];
  nowMs: number;
}): Record<string, number> | undefined => {
  const entries = params.devices.flatMap((device) => {
    const measuredPowerKw = device.measuredPowerKw;
    const observedAtMs = device.measuredPowerObservedAtMs;
    if (
      typeof measuredPowerKw !== 'number'
      || !Number.isFinite(measuredPowerKw)
      || typeof observedAtMs !== 'number'
      || !Number.isFinite(observedAtMs)
      || observedAtMs > params.nowMs
      || params.nowMs - observedAtMs >= POWER_SAMPLE_STALE_THRESHOLD_MS
    ) {
      return [];
    }
    return [[device.id, Math.max(0, measuredPowerKw * 1000)] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export async function recordPowerSampleForApp(params: {
  currentPowerW: number;
  nowMs?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  powerTracker: PowerTrackerState;
  capacityGuard?: CapacityGuard;
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
  objectiveProfileDebugStructured?: StructuredDebugEmitter;
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
    objectiveProfileDebugStructured,
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
  const currentDevicePowerWById = buildFreshMeasuredDevicePowerWById({ devices: snapshot, nowMs });
  const profilingState = updateObjectiveProfilesFromSnapshot({
    state: powerTracker,
    devices: snapshot,
    nowMs,
    debugStructured: objectiveProfileDebugStructured,
  });
  addPerfDuration('power_sample_snapshot_ms', Date.now() - snapshotStart);
  await recordPowerSampleCore({
    state: profilingState,
    currentPowerW,
    controlledPowerW,
    exemptPowerW,
    currentDevicePowerWById,
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
  reason?: PowerTrackerPersistReason;
  error: (msg: string, err: Error) => void;
}): void {
  const { homey, powerTracker, reason, error } = params;
  const writeStart = Date.now();
  try {
    homey.settings.set('power_tracker_state', powerTracker);
    addPerfDuration('settings_write_ms', Date.now() - writeStart);
    incPerfCounter('settings_set.power_tracker_state');
    if (reason) incPerfCounter(`settings_set.power_tracker_state_reason.${reason}_total`);
  } catch (err) {
    error('Failed to persist power tracker', err as Error);
  }
}

export function prunePowerTrackerHistoryForApp(params: {
  powerTracker: PowerTrackerState;
  logDebug: (msg: string) => void;
  error: (msg: string, err: Error) => void;
  // Optional Homey timezone — when present, dailyTotals/hourlyAverages are aggregated
  // by the Homey-local calendar day instead of UTC. Fix for TODO
  // `power-tracker-tz-fix`: in non-UTC zones, UTC-keyed dailyTotals were off by one
  // day for samples that straddled the UTC/local midnight boundary.
  timeZone?: string;
}): PowerTrackerState {
  const { powerTracker, logDebug, error, timeZone } = params;
  logDebug('Pruning power tracker history');
  const pruneStart = Date.now();
  try {
    const pruned = aggregateAndPruneHistory(powerTracker, { timeZone });
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
    updateState: (options?: DailyBudgetUpdateStateOptions) => void;
    getSnapshot: () => DailyBudgetUiPayload | null;
  };
  options?: DailyBudgetUpdateStateOptions;
}): PowerTrackerState {
  const { powerTracker, dailyBudgetService, options } = params;
  dailyBudgetService.updateState(options);
  return recordDailyBudgetCap({
    powerTracker,
    snapshot: dailyBudgetService.getSnapshot(),
  });
}
