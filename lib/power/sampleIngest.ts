import type { PowerTrackerState } from './tracker';
import type { GenerationSegment, ManagedLoadDraw } from './trackerTypes';
import { resolveManagedLoadKey } from './heldReading';
import type { StructuredDebugEmitter } from '../logging/logger';
import { aggregateAndPruneHistory, recordPowerSample as recordPowerSampleCore } from './tracker';
import { resolveUsableCapacityKw } from './capacityModel';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import {
  hasObservedMeasuredPower,
  normalizeMeasuredPowerKw,
} from '../../packages/shared-domain/src/measuredPowerObservedState';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import {
  splitControlledUsageKw,
  sumBudgetExemptMeasuredUsageKw,
  sumControlledUsageKw,
  type UsageDevice,
} from './usageAttribution';

/**
 * Whole-home power sample ingest pipeline.
 *
 * Lives in `lib/power/` per the mandate: this owns the post-arrival flow
 * for a whole-home sample (snapshot of current devices → controlled /
 * uncontrolled / exempt split → objective profile update → tracker
 * record → capacity guard notify).
 *
 * Cross-peer concerns (objective-profile update, daily-budget cap recording) are reached via injected callbacks
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

const NO_LOAD_EVIDENCE: ManagedLoadDraw = { totalW: 0, loadKey: resolveManagedLoadKey([]) };

/**
 * Whether something behind the meter may be covering a load's move and holding
 * the grid reading still: a battery at any time, and PV while it produces. The
 * co-sampled production reading decides that; with none, a PV device in the
 * home may be producing unseen. A grid-tied inverter at night covers nothing,
 * so a PV home is judged like any other then.
 *
 * A battery whose `target_power` Homey never set is in `devices` too: the read
 * contract does not ask a value of a battery or solar class's `target_power`
 * (`deviceReadContract.ts`), where it used to ignore the whole read. Such a
 * home now counts as covered, as intended — the battery covers loads either way.
 */
const mayCoverLoad = (
  devices: readonly DeviceSurfaces[],
  generationW: number | undefined,
): boolean => (
  devices.some((device) => device.deviceClass === 'battery')
  || (generationW === undefined ? devices.some((device) => device.deviceClass === 'solarpanel') : generationW > 0)
);

/**
 * The home's measured load (`ManagedLoadDraw`), UNCLAMPED: the evidence a held
 * whole-home reading is checked against (`lib/power/heldReading.ts`). A device
 * counts, power-limited or not, when its reading is a live figure of its draw
 * (`measuredPowerIsDirectMeasurement`). A rate derived from a cumulative
 * counter does not: it trails by the device app's report interval. A battery
 * or PV inverter is not a load, and never counts. Availability is not
 * asked. Homey keeps an offline device's last value,
 * which cannot move, and dropping the device from the sum would restart the
 * run each time a flaky one blinks. Nothing counts while a battery or a
 * producing PV inverter may be covering the load.
 */
const resolveManagedLoadDraw = (
  devices: readonly DeviceSurfaces[],
  generationW: number | undefined,
): ManagedLoadDraw => {
  if (mayCoverLoad(devices, generationW)) return NO_LOAD_EVIDENCE;
  const measured = devices
    .filter(hasObservedMeasuredPower)
    .filter((device) => device.measuredPowerIsDirectMeasurement && !device.isBatteryOrSolar);
  let totalW = 0;
  for (const device of measured) totalW += device.measuredPowerKw * 1000;
  return { totalW, loadKey: resolveManagedLoadKey(measured.map((device) => device.id)) };
};

const buildMeasuredDevicePowerWById = (params: {
  devices: readonly DeviceSurfaces[];
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
    // This is why the seam reads the observed measurement rather than `currentDrawKw`,
    // which deliberately collapses "no meter" and "meter reads zero" into 0.
    //
    // The per-capability AGE gate that used to follow was removed on 2026-08-08.
    // Homey reports capabilities ON CHANGE, so an old `lastUpdated` means
    // "nothing has happened", not "the reading was lost" — the gate made the
    // longer a reading stayed stable the less PELS trusted it, and dropped a
    // legitimately-unchanging device out of its own energy bucket for as long as
    // it stayed correct (confirmed on a real thermostat holding a true 0 W for
    // 16 h). Freshness still guards the WHOLE-HOME reading (the silence policy
    // ages its evidence stamp, `resolveMeterEvidenceAtMs`) and observation
    // trust — those ask "is the meter alive", which is a different question
    // from "is this capability value current". Do not conflate them again.
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
 * unbounded controlled sum (`sumControlledUsageKw`, the split's own attribution
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
  devices: readonly UsageDevice[];
}): number => {
  const { currentPowerW, generationW, devices } = params;
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
  return Math.max(0, sumControlledUsageKw(devices) * 1000);
};

export type UpdateObjectiveProfiles = (params: {
  state: PowerTrackerState;
  devices: DeviceSurfaces[];
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
  /** Production the readings observed up to this sample; see `RecordPowerSampleParams`. */
  generationSegments: readonly GenerationSegment[];
  nowMs?: number;
  timeZone: string;
  capacitySettings: CapacitySettings;
  /** Inventory metadata joined with accepted Observer state for attribution. */
  getDeviceSurfaces: () => DeviceSurfaces[];
  powerTracker: PowerTrackerState;
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
  updateObjectiveProfiles: UpdateObjectiveProfiles;
}): Promise<void> {
  const snapshotStart = Date.now();
  const {
    currentPowerW,
    generationW,
    nowMs = Date.now(),
    timeZone,
    capacitySettings,
    getDeviceSurfaces,
    powerTracker,
    schedulePlanRebuild,
    saveState,
    updateObjectiveProfiles,
  } = params;
  const hourBudgetKWh = resolveUsableCapacityKw(capacitySettings);
  const devices = getDeviceSurfaces();
  // Observer supplies measured readings; DeviceReads supplies class and
  // controllability metadata. `!== false` preserves the established rule that
  // an unpopulated controllable flag counts as managed usage.
  const usageDevices = devices.map((device) => ({
    ...device,
    currentDrawKw: normalizeMeasuredPowerKw(device.measuredPowerKw) ?? 0,
    countsAsManagedUsage: device.controllable !== false,
  }));
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
    devices: usageDevices,
  });
  const { controlledKw } = devices.length
    ? splitControlledUsageKw({
      devices: usageDevices,
      totalKw: grossConsumptionW / 1000,
    })
    : { controlledKw: null };
  // MEASURED exempt draw: this feeds a persisted kWh integral, so an off exempt
  // device books nothing. The planner's projection (an off device claiming its
  // configured demand) is a control threshold, never energy
  // (`notes/safe-pace-two-constraints.md`).
  const exemptKw = devices.length ? sumBudgetExemptMeasuredUsageKw(usageDevices) : null;
  const controlledPowerW = controlledKw !== null ? Math.max(0, controlledKw * 1000) : undefined;
  const managedDraw = resolveManagedLoadDraw(devices, generationW);
  const exemptPowerW = exemptKw !== null ? Math.max(0, exemptKw * 1000) : undefined;
  const currentDevicePowerWById = buildMeasuredDevicePowerWById({ devices });
  const profilingState = updateObjectiveProfiles({
    state: powerTracker,
    devices,
    nowMs,
  });
  addPerfDuration('power_sample_snapshot_ms', Date.now() - snapshotStart);
  await recordPowerSampleCore({
    state: profilingState,
    currentPowerW,
    grossConsumptionW,
    // Co-sampled gross generation: the tracker's live `lastGenerationW` latch.
    // Generation kWh accrue from the observed stretches beside it.
    generationW,
    generationSegments: params.generationSegments,
    controlledPowerW,
    exemptPowerW,
    currentDevicePowerWById,
    managedDraw,
    nowMs,
    hourBudgetKWh,
    timeZone,
    rebuildPlanFromCache: schedulePlanRebuild,
    saveState,
  });
}

export function prunePowerTrackerHistoryForApp(params: {
  powerTracker: PowerTrackerState;
  debugStructured: StructuredDebugEmitter;
  error: (msg: string, err: Error) => void;
  // Homey's time zone: dailyTotals/hourlyAverages are aggregated by the Homey-local
  // calendar day. (UTC keys put samples straddling local midnight on the wrong day.)
  timeZone: string;
}): PowerTrackerState {
  const { powerTracker, debugStructured, error, timeZone } = params;
  debugStructured({ event: 'power_tracker_history_pruned' });
  const pruneStart = Date.now();
  try {
    const pruned = aggregateAndPruneHistory(powerTracker, timeZone);
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
