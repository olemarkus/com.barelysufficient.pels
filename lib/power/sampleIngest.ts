import type { PowerTrackerState } from './tracker';
import type { StructuredDebugEmitter } from '../logging/logger';
import { aggregateAndPruneHistory, recordPowerSample as recordPowerSampleCore } from './tracker';
import { resolveUsableCapacityKw } from './capacityModel';
import type { MeasuredPowerObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';

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
  if (plannedKWh === undefined || !Number.isFinite(plannedKWh) || typeof bucketKey !== 'string') {
    return powerTracker;
  }
  const nextCaps = { ...(powerTracker.dailyBudgetCaps || {}), [bucketKey]: plannedKWh };
  return { ...powerTracker, dailyBudgetCaps: nextCaps };
}

const buildMeasuredDevicePowerWById = (params: {
  devices: (TargetDeviceSnapshot & MeasuredPowerObservedProbe)[];
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
    // PRESENCE, and nothing else.
    //
    // The presence question is real and this is the one consumer that needs it:
    // a device with no meter must be EXCLUDED from the per-device buckets, not
    // booked at 0 kW. Numerically the two are identical (`accumulateDevicePower`
    // integrates the previous reading, and 0 W accrues 0 kWh, so the Usage tab's
    // "Other" remainder is the same either way) — but the buckets are also the
    // per-device breakdown's membership list. An unmetered heater booked at 0
    // would render as "used 0.00 kWh", which is a claim about the device;
    // leaving it out keeps its consumption in the honest "Other" remainder.
    // This is why the seam reads the raw cluster rather than `currentDrawKw`,
    // which deliberately collapses "no meter" and "meter reads zero" into 0.
    //
    // The per-capability AGE gate that used to follow is gone (TODO 2026-08-08).
    // Homey reports capabilities ON CHANGE, so an old `lastUpdated` means
    // "nothing has happened", not "the reading was lost" — the gate made the
    // longer a reading stayed stable the less PELS trusted it, and dropped a
    // legitimately-unchanging device out of its own energy bucket for as long as
    // it stayed correct (confirmed on a real thermostat holding a true 0 W for
    // 16 h). Freshness still guards the WHOLE-HOME sample
    // (this module's own `sampleFreshness` gate) and observation trust —
    // those ask "is the pipeline alive", which is a different question from "is
    // this capability value current". Do not conflate them again.
    // Availability IS still consulted, and it is a different question from age.
    // Homey retains the last capability value when a device goes offline, so
    // without this an unavailable device's final positive reading would be
    // integrated into its bucket on every subsequent sample, indefinitely —
    // overstating that device's row and understating the honest "Other"
    // remainder. Age said "nothing has changed"; `available: false` says "the
    // device is gone", and only the second is grounds to stop counting it.
    if (device.available === false) return [];
    if (!hasObservedMeasuredPower(device)) return [];
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
 * unbounded controlled sum (`sumControlledUsage`, the split's own attribution
 * before the bounding step). The floor and the attribution are then the same
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
  sumControlledUsage: SumControlledUsage;
}): number => {
  const { currentPowerW, generationW, devices, sumControlledUsage } = params;
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
  return Math.max(0, sumControlledUsage(devices) * 1000);
};

export type SplitControlledUsage = (params: {
  devices: TargetDeviceSnapshot[];
  totalKw: number;
}) => { controlledKw: number; uncontrolledKw: number };

/**
 * The UNBOUNDED controlled sum — the split's own attribution before the
 * whole-home bounding step. Its one consumer is the export-floor fallback in
 * `resolveGrossConsumptionW`; it used to be expressed as the split called
 * with `totalKw: null`, a flag argument smuggled through a nullable.
 */
export type SumControlledUsage = (devices: TargetDeviceSnapshot[]) => number;

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
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
  splitControlledUsage: SplitControlledUsage;
  sumControlledUsage: SumControlledUsage;
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
    schedulePlanRebuild,
    saveState,
    splitControlledUsage,
    sumControlledUsage,
    sumBudgetExemptUsage,
    updateObjectiveProfiles,
  } = params;
  const hourBudgetKWh = resolveUsableCapacityKw(capacitySettings);
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
    sumControlledUsage,
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
  const currentDevicePowerWById = buildMeasuredDevicePowerWById({ devices: snapshot });
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
    hourBudgetKWh,
    rebuildPlanFromCache: schedulePlanRebuild,
    saveState,
  });
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
