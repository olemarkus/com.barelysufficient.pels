import type { HomeyRuntime } from '../ports/homeyRuntime';
import type CapacityGuard from './capacityGuard';
import type { PowerTrackerState } from './tracker';
import type { StructuredDebugEmitter } from '../logging/logger';
import { aggregateAndPruneHistory, recordPowerSample as recordPowerSampleCore } from './tracker';
import type { MeasuredPowerObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { POWER_TRACKER_STATE } from '../utils/settingsKeys';
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
  devices: (TargetDeviceSnapshot & MeasuredPowerObservedProbe)[];
  nowMs: number;
}): Record<string, number> | undefined => {
  const entries = params.devices.flatMap((device) => {
    // A solar device is a PRODUCER: its `measure_power` is POSITIVE when generating, so
    // recording it here (where every value is `Math.max(0, …)` floored and folded into
    // the per-device CONSUMPTION buckets) would show PV production as device usage.
    // Exclude observe-only PV producers entirely — production is tracked separately as
    // the `solar_production_observed` telemetry, never as a consumed/background load.
    //
    // ONLY solar is excluded, NOT a battery: a battery's positive `measure_power` is a
    // real CHARGE DRAW — the home genuinely consumes that power off the grid (the grid
    // meter rises), so attributing it to the battery's per-device bucket is physically
    // accurate household/background load. Excluding it would leave an attribution gap
    // (home consumed it, no device credited). PV's positive `measure_power` is the
    // opposite — generation, not draw — so the asymmetry is correct.
    if (device.deviceClass === 'solarpanel') return [];
    // `hasObservedMeasuredPower` proves `measuredPowerKw` is finite (producer
    // invariant); the cluster guard does NOT prove `measuredPowerObservedAtMs`,
    // so this staleness-sensitive consumer still checks the observation time
    // independently (the timestamp is optional on the narrowed shape).
    if (!hasObservedMeasuredPower(device)) return [];
    const observedAtMs = device.measuredPowerObservedAtMs;
    if (
      typeof observedAtMs !== 'number'
      || !Number.isFinite(observedAtMs)
      || observedAtMs > params.nowMs
      || params.nowMs - observedAtMs >= POWER_SAMPLE_STALE_THRESHOLD_MS
    ) {
      return [];
    }
    return [[device.id, Math.max(0, device.measuredPowerKw * 1000)] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/**
 * Whole-home actual consumption for the managed/background split.
 *
 * `net + generation` is authoritative wherever a production reading is
 * co-sampled — which, since the flow source gained its production companion
 * poll, is any home with a PV device on EITHER power source. Where one is NOT
 * (no generator, or its reading has gone stale), a negative net cannot be
 * resolved to gross at all: the solar covering the load is
 * invisible, and `max(0, net)` asserts the home consumed NOTHING. That is not a
 * conservative floor, it is a false statement: `resolveControlledSample` bounds
 * the split by gross, so managed load reads 0 kW and the controlled/uncontrolled
 * buckets accrue nothing for every exporting sample, while the devices are
 * demonstrably drawing.
 *
 * So on a negative net with no production term, floor at the split's OWN
 * unbounded controlled sum (`splitControlledUsage` with a null total, which
 * skips the bounding step). The floor and the attribution are then the same
 * quantity by construction — every watt of the floor is a watt the split
 * assigns to a controllable device, and background stays 0 because it is
 * genuinely unobservable without a production reading.
 *
 * Flooring at raw measured DEVICE draw instead would leak across devices: that
 * set includes non-controllable ones (a home battery charging is real draw but
 * `controllable: false`), while the controlled sum they would inflate is
 * computed over controllable devices only. A home exporting 1 kW with a battery
 * drawing a measured 2 kW would then report 2 kW of *heater* usage and 0
 * background — the battery's watts attributed to the wrong device.
 *
 * Whether gross should floor at the controlled sum ALWAYS (not just during
 * export) is a separate question this deliberately does not answer.
 */
const resolveGrossConsumptionW = (params: {
  currentPowerW: number;
  generationW?: number;
  devices: TargetDeviceSnapshot[];
  splitControlledUsage: SplitControlledUsage;
}): number => {
  const { currentPowerW, generationW, devices, splitControlledUsage } = params;
  const grossFromReadings = currentPowerW + Math.max(0, generationW ?? 0);
  // Gate the fallback on the RESOLVED value, not on whether a generation term
  // was supplied. A solar home now carries generation on every sample including
  // `0` (night, heavy cloud), and `0` is `!== undefined` — so a presence check
  // would send an exporting home straight back to the "consumed nothing" answer
  // this fallback exists to prevent, on the very source that just gained
  // production. Exporting under zero reported production is real (a battery
  // discharging to grid after dark, a second inverter Homey cannot see).
  if (grossFromReadings > 0 || currentPowerW >= 0) return Math.max(0, grossFromReadings);
  if (devices.length === 0) return 0;
  const { controlledKw } = splitControlledUsage({ devices, totalKw: null });
  return controlledKw !== null ? Math.max(0, controlledKw * 1000) : 0;
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
  /**
   * Gross PV generation (W) co-temporal with `currentPowerW`, or undefined when
   * no generation signal is present. `currentPowerW` is NET grid power (already
   * reduced by self-consumed solar), so the authoritative whole-home *actual
   * consumption* is `net + generation`. This is the single place the gross-up is
   * derived (`grossConsumptionW`), and it feeds ONLY the managed/unmanaged split
   * attribution — never the hard-cap import path or the billed-kWh total bucket,
   * which both stay on the net `currentPowerW` (the "split by purpose" rule).
   */
  generationW?: number;
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
    generationW,
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
  // Authoritative whole-home actual consumption = net grid import + gross
  // generation. With no generation signal this is exactly `currentPowerW`, so
  // non-solar homes are byte-for-byte unchanged. The split below measures
  // against gross so a managed device whose draw is partly solar-fed is not
  // clamped down to the (smaller) net total; the cap path keeps `currentPowerW`.
  // Floored at 0: actual consumption can't be negative, so a noisy net+generation
  // (e.g. a transient export sample exceeding the reported generation) clamps to 0.
  const grossConsumptionW = resolveGrossConsumptionW({
    currentPowerW,
    generationW,
    devices: snapshot,
    splitControlledUsage,
  });
  const { controlledKw } = snapshot.length
    ? splitControlledUsage({
      devices: snapshot,
      totalKw: grossConsumptionW / 1000,
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
    grossConsumptionW,
    // Co-sampled gross generation: feeds the sparse solar accounting families
    // (generationBuckets accrual + lastGenerationW latch) in the tracker.
    generationW,
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
  homey: HomeyRuntime;
  powerTracker: PowerTrackerState;
  reason?: PowerTrackerPersistReason;
  error: (msg: string, err: Error) => void;
}): void {
  const { homey, powerTracker, reason, error } = params;
  const writeStart = Date.now();
  try {
    homey.settings.set(POWER_TRACKER_STATE, powerTracker);
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
