import { parseInsightsTimestamp } from './insightsTimestamp';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';

/**
 * The configured Main meter supplies historical whole-home kWh. Its Insights
 * counters can recover days even when the tracker has no history to compare.
 * Homey Energy reports can instead mix individually metered devices into a
 * partial total, so those reports are not a backfill source.
 */
const CANDIDATE_CAPABILITIES = ['meter_power.imported', 'meter_power'] as const;
/**
 * Stitched broadest-first; `lastYear` is the previous CALENDAR year and
 * `thisYear` covers Jan 1 → now, so together they reach back a full year+
 * at 6-hour step. Finer recent windows sharpen the day boundaries.
 */
const FULL_RESOLUTIONS = ['lastYear', 'thisYear', 'last3Months', 'last31Days'] as const;
type YearWindow = 'lastYear' | 'thisYear';
const HOUR_MS = 60 * 60 * 1000;
const MAX_USABLE_STEP_MS = 6 * HOUR_MS;
/**
 * A 6-hour UTC grid puts the nearest sample at most 3 h from any local
 * midnight; beyond that the boundary is a guess, not a measurement.
 */
const BOUNDARY_TOLERANCE_MS = 3.5 * HOUR_MS;
const MIN_COMPARISON_DAYS = 14;
const RATIO_MIN = 0.9;
const RATIO_MAX = 1.1;
// Quartiles expose intermittent differences a median can hide. Partial tracker
// days tend to skew the ratio high, so the upper bound is more generous.
const RATIO_Q25_MIN = 0.8;
const RATIO_Q75_MAX = 1.25;
/** A lived-in home plausibly uses (0, 1000) kWh on a real day. */
const MAX_PLAUSIBLE_DAY_KWH = 1000;
const MAX_PLAUSIBLE_COUNTER_KWH = 10_000_000;

type TrackerComparison =
  | { trackerComparison: 'insufficient_overlap' }
  | { trackerComparison: 'matches' | 'differs'; overlapDays: number; medianRatio: number };

export type MeterKwhBackfillOutcome =
  | {
    outcome: 'resolved';
    deviceId: string;
    capability: string;
    dailyKwh: Record<string, number>;
    comparison: TrackerComparison;
    /** Only a complete read with usable days can settle the backfill. */
    complete: boolean;
  }
  | { outcome: 'no_candidates' | 'no_usable_history' | 'unreadable_history' };

export type MeterKwhBackfillDeps = {
  /** Read-only GET against the Homey Web API (path without leading slash). */
  fetchFromHomeyApi: (path: string) => Promise<unknown>;
  /** Daily tracker totals for diagnostic comparison when the two series overlap. */
  getDailyKwh: (dateKey: string) => { total?: number };
  /** Main's resolved meter identity is the authority for the Insights read. */
  restrictToDeviceId: string;
  timeZone: string;
  nowMs: number;
};

export async function resolveMeterDailyKwh(deps: MeterKwhBackfillDeps): Promise<MeterKwhBackfillOutcome> {
  const devices = await deps.fetchFromHomeyApi('manager/devices/device');
  const meter = selectMeter(devices, deps.restrictToDeviceId);
  if (meter === undefined) return { outcome: 'no_candidates' };
  const todayKey = getDateKeyInTimeZone(new Date(deps.nowMs), deps.timeZone);
  const { collection, complete } = await collectMeterPoints(meter, deps.fetchFromHomeyApi, todayKey, deps.timeZone);
  const dailyKwh = dailyKwhFromCounterPoints(collection, deps.timeZone, todayKey);
  if (Object.keys(dailyKwh).length === 0) {
    return { outcome: complete ? 'no_usable_history' : 'unreadable_history' };
  }
  return {
    outcome: 'resolved',
    deviceId: meter.deviceId,
    capability: meter.capability,
    dailyKwh,
    comparison: compareWithTracker(dailyKwh, deps.getDailyKwh),
    complete,
  };
}

type MeterCandidate = { deviceId: string; capability: string; exportedCapability?: string };

/** The cumulative meter capability a device exposes (import side), or undefined if none. */
export function meterCapabilityOf(capabilities: readonly string[]): string | undefined {
  return CANDIDATE_CAPABILITIES.find((candidate) => capabilities.includes(candidate));
}

/**
 * Daily kWh from ONE device's cumulative meter across the full resolution
 * stitch — the per-device primitive the controlled-split backfill sums over.
 * `complete` is false if any window failed to read (the caller must not latch
 * a one-shot marker on a partial device).
 */
export async function fetchDeviceDailyKwh(params: {
  deviceId: string;
  capability: string;
  fetchFromHomeyApi: (path: string) => Promise<unknown>;
  timeZone: string;
  nowMs: number;
}): Promise<{ dailyKwh: Record<string, number>; complete: boolean }> {
  const todayKey = getDateKeyInTimeZone(new Date(params.nowMs), params.timeZone);
  const { collection, complete } = await collectMeterPoints(
    { deviceId: params.deviceId, capability: params.capability }, params.fetchFromHomeyApi, todayKey, params.timeZone,
  );
  return { dailyKwh: dailyKwhFromCounterPoints(collection, params.timeZone, todayKey), complete };
}

/**
 * Imported and (when the device meters both directions) exported cumulative
 * counters. The tracker integrates NET power on a HAN home, so an
 * import-only diff would over-attribute consumption on PV-export days — the
 * winter overlap would validate while the admitted summer history is wrong.
 * Net = imported − exported keeps both seasons on the tracker's metric.
 */
type CounterCollection = { imported: Map<number, number>; exported?: Map<number, number> };

function selectMeter(devices: unknown, deviceId: string): MeterCandidate | undefined {
  if (!isUnknownRecord(devices) || Object.keys(devices).length === 0) {
    throw new Error('Unreadable Homey device list');
  }
  const listed = Object.values(devices);
  const meter = listed.find((device) => isUnknownRecord(device) && device.id === deviceId);
  if (!isUnknownRecord(meter)) {
    if (listed.some((device) => !isUnknownRecord(device) || typeof device.id !== 'string' || device.id === '')) {
      throw new Error('Unreadable Homey device list');
    }
    return undefined;
  }
  const capabilities = meter.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every((capability) => typeof capability === 'string')) {
    throw new Error('Unreadable selected meter capabilities');
  }
  const capability = meterCapabilityOf(capabilities);
  if (capability === undefined) return undefined;
  return capabilities.includes('meter_power.exported')
    ? { deviceId, capability, exportedCapability: 'meter_power.exported' }
    : { deviceId, capability };
}

async function collectMeterPoints(
  meter: MeterCandidate,
  fetchFromHomeyApi: MeterKwhBackfillDeps['fetchFromHomeyApi'],
  todayKey: string,
  timeZone: string,
): Promise<{ collection: CounterCollection; complete: boolean }> {
  const imported = await collectCounterPoints(meter.deviceId, meter.capability, fetchFromHomeyApi, todayKey, timeZone);
  if (meter.exportedCapability === undefined) {
    return { collection: { imported: imported.points }, complete: imported.complete };
  }
  const exported = await collectCounterPoints(
    meter.deviceId, meter.exportedCapability, fetchFromHomeyApi, todayKey, timeZone,
  );
  // A conclusively empty export history makes gross import the net total.
  // Keep an unreadable export series in the collection so it cannot fall back to gross.
  const collection = exported.complete && exported.points.size === 0
    ? { imported: imported.points }
    : { imported: imported.points, exported: exported.points };
  return { collection, complete: imported.complete && exported.complete };
}

async function collectCounterPoints(
  deviceId: string,
  capability: string,
  fetchFromHomeyApi: MeterKwhBackfillDeps['fetchFromHomeyApi'],
  todayKey: string,
  timeZone: string,
): Promise<{ points: Map<number, number>; complete: boolean }> {
  const points = new Map<number, number>();
  const emptyYearWindows = new Set<YearWindow>();
  let complete = true;
  for (const resolution of FULL_RESOLUTIONS) {
    try {
      const response = await fetchFromHomeyApi(entryPath(deviceId, capability, resolution));
      const result = ingestCounterResponse(response, points);
      if (result === 'unreadable') complete = false;
      if (result === 'empty' && (resolution === 'lastYear' || resolution === 'thisYear')) {
        emptyYearWindows.add(resolution);
      }
    } catch {
      complete = false;
    }
  }
  // A finer view can prove that an ostensibly empty calendar window was unread.
  const contradicted = [...emptyYearWindows].some((window) => hasPointsInCalendarYear(
    points, Number(todayKey.slice(0, 4)) - (window === 'lastYear' ? 1 : 0), timeZone,
  ));
  return { points, complete: complete && !contradicted };
}

function hasPointsInCalendarYear(points: Map<number, number>, year: number, timeZone: string): boolean {
  const start = getDateKeyStartMs(`${year}-01-01`, timeZone);
  const end = getDateKeyStartMs(`${year + 1}-01-01`, timeZone);
  // A bucket near midnight can be labeled on the other side of the year.
  return [...points.keys()].some((timestamp) => (
    timestamp >= start + MAX_USABLE_STEP_MS && timestamp < end - MAX_USABLE_STEP_MS
  ));
}

function entryPath(deviceId: string, capability: string, resolution: string): string {
  const ownerUri = `homey:device:${deviceId}`;
  return `manager/insights/log/${ownerUri}/${ownerUri}:${capability}/entry?resolution=${resolution}`;
}

function compareWithTracker(
  dailyKwh: Record<string, number>,
  getDailyKwh: MeterKwhBackfillDeps['getDailyKwh'],
): TrackerComparison {
  const ratios = Object.entries(dailyKwh).flatMap(([dateKey, meterKwh]) => {
    const trackerKwh = getDailyKwh(dateKey).total;
    if (trackerKwh === undefined || trackerKwh <= 0) return [];
    return [meterKwh / trackerKwh];
  });
  if (ratios.length < MIN_COMPARISON_DAYS) return { trackerComparison: 'insufficient_overlap' };
  const sorted = [...ratios].sort((a, b) => a - b);
  const medianRatio = quantileSorted(sorted, 0.5);
  const centered = medianRatio >= RATIO_MIN && medianRatio <= RATIO_MAX;
  const tight = quantileSorted(sorted, 0.25) >= RATIO_Q25_MIN && quantileSorted(sorted, 0.75) <= RATIO_Q75_MAX;
  return { trackerComparison: centered && tight ? 'matches' : 'differs', overlapDays: ratios.length, medianRatio };
}

/**
 * Counter diffs between the samples nearest each local midnight. The 6-hour
 * grid smears each boundary by up to ~3 h (DST transition days shift their
 * two boundaries by an extra hour relative to each other), but the same
 * shifted boundary ends one day and starts the next, so the diffs partition
 * the counter exactly — no energy is double-counted or lost between adjacent
 * days, and a robust fit absorbs the two ±4% days a year just as it absorbs
 * skipping DST day-length normalization. Negative diffs (meter swap /
 * counter reset, or a true net-export day) and implausible magnitudes drop
 * that day only. Exported for direct timezone/DST tests.
 */
export function dailyKwhFromCounterPoints(
  collection: CounterCollection,
  timeZone: string,
  todayKey: string,
): Record<string, number> {
  if (collection.imported.size === 0) return {};
  const imported = [...collection.imported.entries()].sort((a, b) => a[0] - b[0]);
  const importedTs = imported.map(([timestampMs]) => timestampMs);
  const exported = collection.exported === undefined
    ? undefined
    : [...collection.exported.entries()].sort((a, b) => a[0] - b[0]);
  const exportedTs = exported?.map(([timestampMs]) => timestampMs);
  const netAtBoundary = (boundaryMs: number): number | undefined => {
    const importedKwh = counterAtBoundary(imported, importedTs, boundaryMs);
    if (importedKwh === undefined) return undefined;
    if (exported === undefined || exportedTs === undefined) return importedKwh;
    const exportedKwh = counterAtBoundary(exported, exportedTs, boundaryMs);
    // The export counter must vouch for the same boundary, or the day's net
    // would silently degrade to gross import.
    return exportedKwh === undefined ? undefined : importedKwh - exportedKwh;
  };
  const firstTs = importedTs[0];
  const lastTs = importedTs.at(-1);
  // The counter map is non-empty above; with no first/last sample there is no
  // span to walk, which is the same answer as an empty collection.
  if (firstTs === undefined || lastTs === undefined) return {};
  const firstKey = getDateKeyInTimeZone(new Date(firstTs), timeZone);
  const lastBoundaryKey = shiftDateKey(
    getDateKeyInTimeZone(new Date(lastTs), timeZone),
    1,
  );
  const dailyKwh = new Map<string, number>();
  let previous: { dateKey: string; counterKwh: number } | undefined;
  for (let dateKey = firstKey; dateKey <= lastBoundaryKey; dateKey = shiftDateKey(dateKey, 1)) {
    const counterKwh = netAtBoundary(getDateKeyStartMs(dateKey, timeZone));
    if (counterKwh !== undefined && previous !== undefined) {
      const dayKwh = counterKwh - previous.counterKwh;
      if (previous.dateKey < todayKey && dayKwh > 0 && dayKwh <= MAX_PLAUSIBLE_DAY_KWH) {
        dailyKwh.set(previous.dateKey, dayKwh);
      }
    }
    previous = counterKwh === undefined ? undefined : { dateKey, counterKwh };
  }
  return Object.fromEntries(dailyKwh);
}

/** Counter value at the sample nearest the boundary, when one is close enough to trust. */
function counterAtBoundary(
  samples: Array<[number, number]>,
  timestamps: number[],
  boundaryMs: number,
): number | undefined {
  // Empty list must short-circuit: indexing past it would make the distance
  // check NaN, which compares false and would dereference a missing sample.
  if (timestamps.length === 0) return undefined;
  const index = nearestIndex(timestamps, boundaryMs);
  const nearestMs = timestamps[index];
  const sample = samples[index];
  if (nearestMs === undefined || sample === undefined) return undefined;
  if (Math.abs(nearestMs - boundaryMs) > BOUNDARY_TOLERANCE_MS) return undefined;
  return sample[1];
}

function nearestIndex(sortedTimestamps: number[], targetMs: number): number {
  let low = 0;
  let high = sortedTimestamps.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const midMs = sortedTimestamps[mid];
    if (midMs === undefined) break;
    if (midMs < targetMs) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return 0;
  const beforeMs = sortedTimestamps[low - 1];
  const atMs = sortedTimestamps[low];
  // Both sit inside the searched range; with either missing there is no closer
  // neighbour to prefer, so the landed index stands.
  if (beforeMs === undefined || atMs === undefined) return low;
  return targetMs - beforeMs <= atMs - targetMs ? low - 1 : low;
}

/** An empty log is affirmative; an unreadable log cannot settle a backfill. */
function ingestCounterResponse(
  response: unknown,
  points: Map<number, number>,
): 'read' | 'empty' | 'unreadable' {
  if (!isUnknownRecord(response)) return 'unreadable';
  const step = response.step;
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0 || step > MAX_USABLE_STEP_MS) return 'unreadable';
  if (!Array.isArray(response.values)) return 'unreadable';
  let read = false;
  let malformed = false;
  for (const entry of response.values) {
    const bucket = parseCounterBucket(entry);
    if (bucket === undefined) {
      malformed = true;
      continue;
    }
    if (bucket.value === null) continue;
    read = true;
    if (bucket.value >= 0 && bucket.value <= MAX_PLAUSIBLE_COUNTER_KWH) {
      points.set(bucket.timestampMs, bucket.value);
    }
  }
  // Keep valid points for a partial recovery. Finite out-of-range samples
  // are readable data and are excluded without forcing the window to retry.
  if (malformed) return 'unreadable';
  return read ? 'read' : 'empty';
}

function parseCounterBucket(entry: unknown): { timestampMs: number; value: number | null } | undefined {
  if (!isUnknownRecord(entry)) return undefined;
  const value = entry.v;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
  const timestampMs = parseInsightsTimestamp(entry.t);
  if (timestampMs === undefined) return undefined;
  return { timestampMs, value };
}

/** Linear-interpolated quantile over an ascending-sorted sample. */
export function quantileSorted(sorted: number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower];
  const high = sorted[upper];
  // Callers only quantile a sample they have already sized; an empty one has no
  // quantile, and NaN is what the arithmetic below would produce for it anyway.
  if (low === undefined || high === undefined) return Number.NaN;
  if (lower === upper) return low;
  const weight = position - lower;
  return low * (1 - weight) + high * weight;
}
