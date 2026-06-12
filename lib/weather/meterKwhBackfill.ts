import { isUnknownRecord } from '../utils/types';
import { getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey } from '../utils/dateUtils';

/**
 * One-shot reconstruction of historical daily whole-home kWh from a cumulative
 * energy-meter device's Insights log (`meter_power.imported` / `meter_power`),
 * validated against the power tracker before a single day is trusted.
 *
 * Why not the Homey Energy monthly reports: their `consumedPeriod` is the sum
 * of individually-metered devices, NOT the home total, on any Homey without a
 * home meter configured in Homey Energy (`importedPeriod` null is the tell).
 * On the first production install that subset ran at ~0.42× of the tracker's
 * whole-home measurement and silently flattened the energy-signature fit.
 * A historical source is only admissible when its daily values match what the
 * tracker measured on the days both cover — that overlap check is the gate,
 * regardless of which source the kWh comes from.
 *
 * Candidate meters are auto-detected (no setting): every device exposing a
 * cumulative meter capability is probed with a recent Insights window, its
 * local-midnight counter diffs are compared with the tracker's daily totals,
 * and the best candidate whose median ratio sits in [0.9, 1.1] over ≥ 14
 * overlap days wins. Device-level meters (thermostats, EV chargers) fail the
 * gate by an order of magnitude, so being liberal in discovery is safe. On a
 * fresh install the tracker has fewer than 14 days for a while — the caller
 * retries every start until the overlap exists, then latches its done-marker.
 */

const CANDIDATE_CAPABILITIES = ['meter_power.imported', 'meter_power'] as const;
const PROBE_RESOLUTION = 'last3Months';
/**
 * Stitched broadest-first; `lastYear` is the previous CALENDAR year and
 * `thisYear` covers Jan 1 → now, so together they reach back a full year+
 * at 6-hour step. Finer recent windows sharpen the day boundaries.
 */
const FULL_RESOLUTIONS = ['lastYear', 'thisYear', 'last3Months', 'last31Days'] as const;
const HOUR_MS = 60 * 60 * 1000;
const MAX_USABLE_STEP_MS = 6 * HOUR_MS;
/**
 * A 6-hour UTC grid puts the nearest sample at most 3 h from any local
 * midnight; beyond that the boundary is a guess, not a measurement.
 */
const BOUNDARY_TOLERANCE_MS = 3.5 * HOUR_MS;
const MIN_OVERLAP_DAYS = 14;
const RATIO_MIN = 0.9;
const RATIO_MAX = 1.1;
/**
 * The median alone has a blind spot: a meter that misses an intermittent
 * large load (EV on its own feed) matches on quiet days and reads ~0.5 on
 * charge days — median still ≈ 1. The quartiles catch that bimodal shape.
 * Asymmetric upper bound: partial tracker days (install day, outages) skew
 * ratios HIGH, and they are artifacts of the comparison, not the meter.
 */
const RATIO_Q25_MIN = 0.8;
const RATIO_Q75_MAX = 1.25;
/** A lived-in home plausibly uses (0, 1000) kWh on a real day. */
const MAX_PLAUSIBLE_DAY_KWH = 1000;
const MAX_PLAUSIBLE_COUNTER_KWH = 10_000_000;

export type MeterKwhBackfillOutcome =
  | {
    outcome: 'resolved';
    deviceId: string;
    capability: string;
    dailyKwh: Record<string, number>;
    overlapDays: number;
    medianRatio: number;
    /**
     * True only when every resolution window was fetched without error. The
     * caller must not latch its one-shot done-marker on a partial run — e.g.
     * `lastYear` (the deepest window) failing while the recent windows
     * succeed would otherwise permanently forfeit a year of history.
     */
    complete: boolean;
  }
  | { outcome: 'no_candidates' }
  | {
    outcome: 'no_comparable_source';
    candidatesChecked: number;
    /**
     * Candidates whose probe fetch failed outright. When > 0 the verdict
     * rests on unread evidence — the caller must not take destructive
     * action (e.g. purging legacy kWh) on the strength of it.
     */
    probeFailures: number;
  };

export type MeterKwhBackfillDeps = {
  /** Read-only GET against the Homey Web API (path without leading slash). */
  fetchFromHomeyApi: (path: string) => Promise<unknown>;
  /** Flat daily totals from the power tracker — the comparison ground truth. */
  getDailyKwh: (dateKey: string) => { total?: number; controlled?: number };
  timeZone: string;
  nowMs: number;
};

export async function resolveMeterDailyKwh(deps: MeterKwhBackfillDeps): Promise<MeterKwhBackfillOutcome> {
  const devices = await deps.fetchFromHomeyApi('manager/devices/device');
  const candidates = listMeterCandidates(devices);
  if (candidates.length === 0) return { outcome: 'no_candidates' };
  const todayKey = getDateKeyInTimeZone(new Date(deps.nowMs), deps.timeZone);
  const probe = await probeCandidates(candidates, todayKey, deps);
  if (!probe.best) {
    return { outcome: 'no_comparable_source', candidatesChecked: candidates.length, probeFailures: probe.failures };
  }
  const best = probe.best;

  const { collection, failures: failureCount } = await collectCandidatePoints(best, FULL_RESOLUTIONS, deps);
  const dailyKwh = dailyKwhFromCounterPoints(collection, deps.timeZone, todayKey);
  // Re-validated on the full span: the deep windows must agree with the
  // tracker as well as the probe window did. Counted as a probe failure for
  // the caller: a winner whose full history disagrees is unread-evidence
  // territory, not a conclusive no-source verdict.
  const validation = validateAgainstTracker(dailyKwh, deps.getDailyKwh);
  if (!validation.passed) {
    return {
      outcome: 'no_comparable_source',
      candidatesChecked: candidates.length,
      probeFailures: probe.failures + 1,
    };
  }
  return {
    outcome: 'resolved',
    deviceId: best.deviceId,
    capability: best.capability,
    dailyKwh,
    overlapDays: validation.overlapDays,
    medianRatio: validation.medianRatio,
    // A failed candidate probe also blocks the latch: the winner of an
    // election some candidates could not enter must stand for re-election.
    complete: failureCount === 0 && probe.failures === 0,
  };
}

type MeterCandidate = { deviceId: string; capability: string; exportedCapability?: string };

/**
 * Imported and (when the device meters both directions) exported cumulative
 * counters. The tracker integrates NET power on a HAN home, so an
 * import-only diff would over-attribute consumption on PV-export days — the
 * winter overlap would validate while the admitted summer history is wrong.
 * Net = imported − exported keeps both seasons on the tracker's metric.
 */
type CounterCollection = { imported: Map<number, number>; exported?: Map<number, number> };

type CandidateValidation = { passed: boolean; overlapDays: number; medianRatio: number };

function listMeterCandidates(devicesResponse: unknown): MeterCandidate[] {
  if (!isUnknownRecord(devicesResponse)) return [];
  return Object.values(devicesResponse).flatMap((device) => {
    if (!isUnknownRecord(device)) return [];
    const deviceId = device.id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return [];
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    const capability = CANDIDATE_CAPABILITIES.find((candidate) => capabilities.includes(candidate));
    if (capability === undefined) return [];
    // Any device that ALSO meters export is bidirectional gear — net it,
    // whether its import counter is `.imported` or generic `meter_power`.
    const exportedCapability = capabilities.includes('meter_power.exported')
      ? 'meter_power.exported'
      : undefined;
    return [{ deviceId, capability, ...(exportedCapability === undefined ? {} : { exportedCapability }) }];
  });
}

async function collectCandidatePoints(
  candidate: MeterCandidate,
  resolutions: readonly string[],
  deps: MeterKwhBackfillDeps,
): Promise<{ collection: CounterCollection; failures: number }> {
  const imported = new Map<number, number>();
  const exported = candidate.exportedCapability === undefined ? undefined : new Map<number, number>();
  const fetchWindows = async (capability: string, points: Map<number, number>): Promise<number> => {
    let windowFailures = 0;
    for (const resolution of resolutions) {
      try {
        // A malformed or too-coarse 200 is a failure (the window's data was
        // not readable), unlike a well-formed empty window (a young meter
        // simply has no older history — failing that would retry forever).
        const path = entryPath(candidate.deviceId, capability, resolution);
        if (!ingestCounterResponse(await deps.fetchFromHomeyApi(path), points)) {
          windowFailures += 1;
        }
      } catch {
        windowFailures += 1;
      }
    }
    return windowFailures;
  };
  const importedFailures = await fetchWindows(candidate.capability, imported);
  const exportedFailures = exported === undefined || candidate.exportedCapability === undefined
    ? 0
    : await fetchWindows(candidate.exportedCapability, exported);
  // A conclusively EMPTY export log (every export window read fine, zero
  // samples) means the device never recorded export — net equals gross
  // import, so the import counter stands alone even when an IMPORT window
  // failed (those days simply stay unfilled). An empty map left by failed
  // export reads is kept instead: netting against it yields no days, so
  // nothing wrong is written.
  const exportedConclusiveEmpty = exported !== undefined && exported.size === 0 && exportedFailures === 0;
  return {
    collection: { imported, ...(exported === undefined || exportedConclusiveEmpty ? {} : { exported }) },
    failures: importedFailures + exportedFailures,
  };
}

async function probeCandidates(
  candidates: MeterCandidate[],
  todayKey: string,
  deps: MeterKwhBackfillDeps,
): Promise<{ best: MeterCandidate | undefined; failures: number }> {
  let best: { candidate: MeterCandidate; validation: CandidateValidation } | undefined;
  let failures = 0;
  for (const candidate of candidates) {
    const probe = await collectCandidatePoints(candidate, [PROBE_RESOLUTION], deps);
    if (probe.failures > 0) {
      failures += 1;
      continue;
    }
    const dailyKwh = dailyKwhFromCounterPoints(probe.collection, deps.timeZone, todayKey);
    const validation = validateAgainstTracker(dailyKwh, deps.getDailyKwh);
    if (!validation.passed) continue;
    if (!best || isBetterValidation(validation, best.validation)) best = { candidate, validation };
  }
  return { best: best?.candidate, failures };
}

function isBetterValidation(next: CandidateValidation, current: CandidateValidation): boolean {
  if (next.overlapDays !== current.overlapDays) return next.overlapDays > current.overlapDays;
  return Math.abs(next.medianRatio - 1) < Math.abs(current.medianRatio - 1);
}

function entryPath(deviceId: string, capability: string, resolution: string): string {
  const ownerUri = `homey:device:${deviceId}`;
  return `manager/insights/log/${ownerUri}/${ownerUri}:${capability}/entry?resolution=${resolution}`;
}

function validateAgainstTracker(
  dailyKwh: Record<string, number>,
  getDailyKwh: MeterKwhBackfillDeps['getDailyKwh'],
): CandidateValidation {
  const ratios = Object.entries(dailyKwh).flatMap(([dateKey, meterKwh]) => {
    const trackerKwh = getDailyKwh(dateKey).total;
    if (trackerKwh === undefined || trackerKwh <= 0) return [];
    return [meterKwh / trackerKwh];
  });
  if (ratios.length < MIN_OVERLAP_DAYS) return { passed: false, overlapDays: ratios.length, medianRatio: 0 };
  const sorted = [...ratios].sort((a, b) => a - b);
  const medianRatio = quantileSorted(sorted, 0.5);
  const centered = medianRatio >= RATIO_MIN && medianRatio <= RATIO_MAX;
  const tight = quantileSorted(sorted, 0.25) >= RATIO_Q25_MIN && quantileSorted(sorted, 0.75) <= RATIO_Q75_MAX;
  return { passed: centered && tight, overlapDays: ratios.length, medianRatio };
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
  const firstKey = getDateKeyInTimeZone(new Date(importedTs[0]), timeZone);
  const lastBoundaryKey = shiftDateKey(
    getDateKeyInTimeZone(new Date(importedTs[importedTs.length - 1]), timeZone),
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
  if (Math.abs(timestamps[index] - boundaryMs) > BOUNDARY_TOLERANCE_MS) return undefined;
  return samples[index][1];
}

function nearestIndex(sortedTimestamps: number[], targetMs: number): number {
  let low = 0;
  let high = sortedTimestamps.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedTimestamps[mid] < targetMs) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return 0;
  return targetMs - sortedTimestamps[low - 1] <= sortedTimestamps[low] - targetMs ? low - 1 : low;
}

/**
 * False when the response is malformed or too coarse to use — the window's
 * data exists but was not readable, which must count as a fetch failure. A
 * well-formed response with an empty `values` array returns true: a young
 * meter legitimately has no older history, and that is a final answer.
 */
function ingestCounterResponse(response: unknown, points: Map<number, number>): boolean {
  if (!isUnknownRecord(response)) return false;
  const step = response.step;
  if (typeof step !== 'number' || step <= 0 || step > MAX_USABLE_STEP_MS) return false;
  if (!Array.isArray(response.values)) return false;
  for (const entry of response.values) {
    const point = parseCounterPoint(entry);
    if (point) points.set(point.timestampMs, point.counterKwh);
  }
  return true;
}

function parseCounterPoint(entry: unknown): { timestampMs: number; counterKwh: number } | undefined {
  if (!isUnknownRecord(entry)) return undefined;
  const value = entry.v;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_PLAUSIBLE_COUNTER_KWH) return undefined;
  const timestampMs = parseEntryTimestamp(entry.t);
  if (timestampMs === undefined) return undefined;
  return { timestampMs, counterKwh: value };
}

function parseEntryTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Linear-interpolated quantile over an ascending-sorted sample. */
function quantileSorted(sorted: number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
