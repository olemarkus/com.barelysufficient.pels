import type Homey from 'homey';
import type CapacityGuard from './capacityGuard';
import type { PowerTrackerState } from './tracker';
import type { StructuredDebugEmitter } from '../logging/logger';
import { aggregateAndPruneHistory, recordPowerSample as recordPowerSampleCore } from './tracker';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';

/**
 * Whole-home power sample ingest pipeline.
 *
 * Lives in `lib/power/` per the mandate: this owns the post-arrival flow
 * for a whole-home sample (snapshot of current devices → controlled /
 * uncontrolled / exempt split → objective profile update → tracker
 * record → capacity guard notify).
 *
 * Cross-peer concerns (objective-profile update, controlled/uncontrolled
 * split, daily-budget cap recording) are reached via injected callbacks
 * so this file does not import from `lib/objectives/`, `lib/plan/`, or
 * `lib/dailyBudget/` (per the no-power-to-peer rule in dep-cruiser).
 */

export type PowerTrackerPersistReason =
  | 'scheduled'
  | 'hour_rollover'
  | 'prune'
  | 'ui_replace'
  | 'uninit'
  | 'write';

/** Narrow shape of the daily-budget snapshot needed for cap recording. */
export type DailyBudgetCapSnapshot = {
  todayKey: string;
  days: Record<string, {
    budget: { enabled: boolean };
    buckets: { plannedKWh: number[]; startUtc: string[] };
    currentBucketIndex: number;
  } | undefined>;
} | null;

export function recordDailyBudgetCap(params: {
  powerTracker: PowerTrackerState;
  snapshot: DailyBudgetCapSnapshot;
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

export type SplitControlledUsage = (params: {
  devices: TargetDeviceSnapshot[];
  totalKw: number | null;
}) => { controlledKw: number | null; uncontrolledKw: number | null };

export type SumBudgetExemptUsage = (devices: TargetDeviceSnapshot[]) => number | null;

export type UpdateObjectiveProfiles = (params: {
  state: PowerTrackerState;
  devices: TargetDeviceSnapshot[];
  nowMs: number;
}) => PowerTrackerState;

export async function recordPowerSampleForApp(params: {
  currentPowerW: number;
  nowMs?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  powerTracker: PowerTrackerState;
  capacityGuard?: CapacityGuard;
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
  splitControlledUsage: SplitControlledUsage;
  sumBudgetExemptUsage: SumBudgetExemptUsage;
  updateObjectiveProfiles: UpdateObjectiveProfiles;
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
    splitControlledUsage,
    sumBudgetExemptUsage,
    updateObjectiveProfiles,
  } = params;
  const hourBudgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const snapshot = getLatestTargetSnapshot();
  const { controlledKw } = snapshot.length
    ? splitControlledUsage({
      devices: snapshot,
      totalKw: currentPowerW / 1000,
    })
    : { controlledKw: null };
  const exemptKw = snapshot.length ? sumBudgetExemptUsage(snapshot) : null;
  const controlledPowerW = controlledKw !== null ? Math.max(0, controlledKw * 1000) : undefined;
  const exemptPowerW = exemptKw !== null ? Math.max(0, exemptKw * 1000) : undefined;
  const currentDevicePowerWById = buildFreshMeasuredDevicePowerWById({ devices: snapshot, nowMs });
  const profilingState = updateObjectiveProfiles({
    state: powerTracker,
    devices: snapshot,
    nowMs,
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
  debugStructured: StructuredDebugEmitter;
  error: (msg: string, err: Error) => void;
  // Optional Homey timezone — when present, dailyTotals/hourlyAverages are aggregated
  // by the Homey-local calendar day instead of UTC. Fix for TODO
  // `power-tracker-tz-fix`: in non-UTC zones, UTC-keyed dailyTotals were off by one
  // day for samples that straddled the UTC/local midnight boundary.
  timeZone?: string;
}): PowerTrackerState {
  const { powerTracker, debugStructured, error, timeZone } = params;
  debugStructured({ event: 'power_tracker_history_pruned' });
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

export function updateDailyBudgetAndRecordCapForApp<TOptions>(params: {
  powerTracker: PowerTrackerState;
  dailyBudgetService: {
    updateState: (options?: TOptions) => void;
    getSnapshot: () => DailyBudgetCapSnapshot;
  };
  options?: TOptions;
}): PowerTrackerState {
  const { powerTracker, dailyBudgetService, options } = params;
  dailyBudgetService.updateState(options);
  return recordDailyBudgetCap({
    powerTracker,
    snapshot: dailyBudgetService.getSnapshot(),
  });
}
