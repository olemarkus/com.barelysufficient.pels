import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import { isUnknownRecord } from '../utils/types';
import { getDateKeyInTimeZone } from '../utils/dateUtils';
import { isPlausibleOutdoorTemperature } from './weatherHistory';

/**
 * One-shot reconstruction of historical daily outdoor temperatures from the
 * selected device's Homey Insights log, joined with the power tracker's daily
 * kWh totals. This is what removes the feature's cold start: a year of
 * (usage, temperature) pairs exists the moment a device is picked.
 *
 * Endpoint quirk (verified): entries live at
 * `manager/insights/log/{ownerUri}/{FULL log id}/entry?resolution=R` — the
 * second path segment is the full `homey:device:<id>:measure_temperature` id,
 * not the bare capability. `lastYear` returns the previous calendar year at
 * 6-hour step; `thisYear` covers Jan 1 → now, and `last3Months`/`last31Days`
 * sharpen the recent window. Windows overlap, so points are deduped by
 * timestamp before grouping into local days.
 */

/**
 * Bumped whenever BACKFILL_RESOLUTIONS widens, so installs that completed an
 * older stitch re-run once and pick up the windows it lacked. Version 2 added
 * `thisYear`: without it, the current calendar year up to ~3 months ago was a
 * permanent gap (e.g. January–February temps missing on a June install).
 */
export const TEMP_BACKFILL_VERSION = 2;

/** Resolutions to stitch, broadest first. Coarser-than-6h responses are skipped. */
const BACKFILL_RESOLUTIONS = ['lastYear', 'thisYear', 'last3Months', 'last31Days'] as const;
const MAX_USABLE_STEP_MS = 6 * 60 * 60 * 1000;
/** ≥3 of the 4 daily 6-hour points must exist for a trustworthy daily mean. */
const MIN_POINTS_PER_DAY = 3;

export type InsightsBackfillDeps = {
  deviceId: string;
  /** Read-only GET against the Homey Web API (path without leading slash). */
  fetchInsights: (path: string) => Promise<unknown>;
  getDailyKwh: (dateKey: string) => { total?: number; controlled?: number };
  timeZone: string;
  nowMs: number;
};

export type InsightsBackfillResult = {
  records: WeatherDailyRecord[];
  /**
   * True only when every resolution window was fetched without error. The
   * caller must not set its one-shot done-marker on a partial run — e.g.
   * `lastYear` (the deepest window) failing while `last31Days` succeeds would
   * otherwise permanently forfeit a year of reconstructable history.
   */
  complete: boolean;
};

export async function fetchBackfillDailyRecords(deps: InsightsBackfillDeps): Promise<InsightsBackfillResult> {
  const { deviceId, fetchInsights, getDailyKwh, timeZone, nowMs } = deps;
  const ownerUri = `homey:device:${deviceId}`;
  const basePath = `manager/insights/log/${ownerUri}/${ownerUri}:measure_temperature/entry`;
  const { points, complete } = await collectTemperaturePoints(basePath, fetchInsights);
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const byDay = groupPointsByLocalDay(points, timeZone, todayKey);
  const records = [...byDay.entries()]
    .filter(([, temps]) => temps.length >= MIN_POINTS_PER_DAY)
    .map(([dateKey, temps]) => buildBackfillRecord(dateKey, temps, getDailyKwh(dateKey)))
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  return { records, complete };
}

/** Fetches all resolutions, deduping points by timestamp. Throws only when nothing was readable. */
async function collectTemperaturePoints(
  basePath: string,
  fetchInsights: (path: string) => Promise<unknown>,
): Promise<{ points: Map<number, number>; complete: boolean }> {
  const points = new Map<number, number>();
  let firstError: unknown;
  let failureCount = 0;
  for (const resolution of BACKFILL_RESOLUTIONS) {
    try {
      // A malformed/too-coarse 200 counts as a failure (the window existed
      // but was unreadable); a well-formed empty window is a final answer.
      if (!ingestEntryResponse(await fetchInsights(`${basePath}?resolution=${resolution}`), points)) {
        failureCount += 1;
      }
    } catch (error) {
      if (firstError === undefined) firstError = error;
      failureCount += 1;
    }
  }
  if (points.size === 0 && failureCount > 0) {
    throw firstError ?? new Error('insights response unusable');
  }
  return { points, complete: failureCount === 0 };
}

function groupPointsByLocalDay(
  points: Map<number, number>,
  timeZone: string,
  todayKey: string,
): Map<string, number[]> {
  const byDay = new Map<string, number[]>();
  for (const [timestampMs, temperatureC] of points) {
    const dateKey = getDateKeyInTimeZone(new Date(timestampMs), timeZone);
    if (dateKey >= todayKey) continue;
    byDay.set(dateKey, [...(byDay.get(dateKey) ?? []), temperatureC]);
  }
  return byDay;
}

function buildBackfillRecord(
  dateKey: string,
  temps: number[],
  kwh: { total?: number; controlled?: number },
): WeatherDailyRecord {
  return {
    dateKey,
    ...(kwh.total !== undefined ? { kwhTotal: kwh.total } : {}),
    ...(kwh.controlled !== undefined ? { kwhControlled: kwh.controlled } : {}),
    tempMeanC: temps.reduce((sum, value) => sum + value, 0) / temps.length,
    tempMinC: Math.min(...temps),
    tempMaxC: Math.max(...temps),
    tempSampleCount: temps.length,
    quality: {
      partialTemp: false,
      missingKwh: kwh.total === undefined,
      // Unknown for old days — the tracker prunes gap metadata after ~30
      // days. The `backfilled` flag already marks these as reconstructed.
      unreliablePower: false,
      backfilled: true,
    },
  };
}

/** False when the response is malformed or too coarse to use (counts as a fetch failure). */
function ingestEntryResponse(response: unknown, points: Map<number, number>): boolean {
  if (!isUnknownRecord(response)) return false;
  const step = response.step;
  if (typeof step !== 'number' || step <= 0 || step > MAX_USABLE_STEP_MS) return false;
  if (!Array.isArray(response.values)) return false;
  for (const entry of response.values) {
    const point = parseEntryPoint(entry);
    if (point) points.set(point.timestampMs, point.temperatureC);
  }
  return true;
}

function parseEntryPoint(entry: unknown): { timestampMs: number; temperatureC: number } | undefined {
  if (!isUnknownRecord(entry)) return undefined;
  const value = entry.v;
  if (!isPlausibleOutdoorTemperature(value)) return undefined;
  const timestampMs = parseEntryTimestamp(entry.t);
  if (timestampMs === undefined) return undefined;
  return { timestampMs, temperatureC: value };
}

function parseEntryTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
