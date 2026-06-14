import type { MetDaySummary } from '../../packages/contracts/src/weatherAdvisorTypes';
import { getDateKeyInTimeZone, getZonedParts, shiftDateKey } from '../utils/dateUtils';

/**
 * Direct MET Norway Locationforecast 2.0 (compact) forecast source for the
 * weather-insight budget. Replaces the user-configured "+24h forecast device":
 * MET returns a COMPLETE forward hourly profile for the hub's lat/lon at any time
 * of day, so the forecast no longer has to be reconstructed from 24 sliding +24h
 * device snapshots (which only completed across the prior day and produced a
 * moving, season-blind "tomorrow").
 *
 * OWNERSHIP / INVARIANTS:
 * - `summarizeMetForecastDays` is the pure, testable core: it buckets the UTC
 *   timeseries to the hub-LOCAL days (DST-correct) and reduces each to the
 *   aggregates the budget needs. It returns a PER-DAY map covering BOTH the
 *   current local day (the just-started/actionable day at the 00:05 rollup, read
 *   by auto-apply) AND tomorrow (read by the forward-looking readout card) — both
 *   are within MET's hourly horizon, so the two consumers each read the day they
 *   need rather than sharing a single "tomorrow" summary (which would apply the
 *   wrong day's forecast at the midnight rollup — see the per-day-cache plan).
 * - The ONLY value that enters the kWh prediction is `meanTempC` — a SIMPLE
 *   per-hour arithmetic mean. This is byte-for-byte the estimator the energy
 *   signature fit was trained on (`WeatherDailyRecord.tempMeanC =
 *   accumulator.sumC/count`). DO NOT weight, integrate, or feed heating-degree-
 *   HOURS to the mean-trained slope — Jensen convexity would over-budget swingy
 *   days. (That realignment is the deferred Phase 2; see
 *   `~/.claude/plans/weather-met-forecast.md`.)
 * - min/max + the evening window are DISPLAY/VERDICT context only; the
 *   cold-evening flag is resolved downstream where the fit's balance point lives.
 * - `symbolCode`/`precip` are display-only; never fed to the fit.
 *
 * MET ToS (enforced by the caller wiring `fetchMetForecast`): a real identifying
 * User-Agent is mandatory, data is CC-BY 4.0 (attribution required), and the
 * caller must honor Expires/If-Modified-Since caching and back off on 429/403.
 */

/** Local wall-clock hours [from, to] (inclusive) defining "evening". */
const EVENING_FROM_HOUR = 17;
const EVENING_TO_HOUR = 23;
/** A day bucket with at least this many hourly entries is treated as complete. */
const FULL_DAY_MIN_HOURS = 20;

/** A per-day summary plus the fetch-time-only evening-coverage count (not persisted). */
export type MetDaySummaryWithCoverage = MetDaySummary & {
  /** Hourly entries that fell in this day's evening window. */
  eveningHourCount: number;
};

/** Per-LOCAL-day forecast summaries covering the current local day AND tomorrow. */
export type MetForecastDays = {
  byDay: Record<string, MetDaySummaryWithCoverage>;
};

type ParsedEntry = { timeMs: number; tempC: number; localHour: number; symbolCode?: string; precipMm?: number };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

/** Nested record accessor: returns the value at `key` only when it is itself a record. */
const recordAt = (obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined => {
  const value = obj?.[key];
  return isRecord(value) ? value : undefined;
};

const finiteOrUndefined = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

/** Defensively reduce one MET compact entry to a typed, local-hour-stamped point, or null. */
function parseEntry(item: unknown, timeZone: string): ParsedEntry | null {
  if (!isRecord(item) || typeof item.time !== 'string') return null;
  const timeMs = Date.parse(item.time);
  if (!Number.isFinite(timeMs)) return null;
  const data = recordAt(item, 'data');
  const tempC = finiteOrUndefined(recordAt(recordAt(data, 'instant'), 'details')?.air_temperature);
  if (tempC === undefined) return null;
  const next1h = recordAt(data, 'next_1_hours');
  const symbolCode = recordAt(next1h, 'summary')?.symbol_code;
  return {
    timeMs,
    tempC,
    localHour: getZonedParts(new Date(timeMs), timeZone).hour,
    symbolCode: typeof symbolCode === 'string' ? symbolCode : undefined,
    precipMm: finiteOrUndefined(recordAt(next1h, 'details')?.precipitation_amount),
  };
}

/** Defensively walk the MET compact envelope into typed hourly entries (local-hour stamped). */
function parseTimeseries(raw: unknown, timeZone: string): ParsedEntry[] {
  const properties = recordAt(isRecord(raw) ? raw : undefined, 'properties');
  if (!properties || !Array.isArray(properties.timeseries)) return [];
  return properties.timeseries.flatMap((item) => {
    const parsed = parseEntry(item, timeZone);
    return parsed ? [parsed] : [];
  });
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Reduce one local day's hourly entries to its summary (SIMPLE per-hour mean — the invariant). */
function summarizeDay(dateKey: string, entries: ParsedEntry[]): MetDaySummaryWithCoverage {
  const temps = entries.map((entry) => entry.tempC);
  const evening = entries.filter((entry) => (
    entry.localHour >= EVENING_FROM_HOUR && entry.localHour <= EVENING_TO_HOUR
  ));
  const eveningTemps = evening.map((entry) => entry.tempC);
  // A representative glyph for the day: the entry nearest local noon.
  const midday = entries.reduce((best, entry) => (
    Math.abs(entry.localHour - 12) < Math.abs(best.localHour - 12) ? entry : best
  ));
  const precipValues = entries.map((entry) => entry.precipMm).filter((value): value is number => value !== undefined);

  return {
    dateKey,
    meanTempC: mean(temps),
    minTempC: Math.min(...temps),
    maxTempC: Math.max(...temps),
    eveningMeanTempC: eveningTemps.length > 0 ? mean(eveningTemps) : undefined,
    eveningMinTempC: eveningTemps.length > 0 ? Math.min(...eveningTemps) : undefined,
    hourCount: entries.length,
    eveningHourCount: evening.length,
    // True full-day coverage requires the day's FIRST local hour (midnight) to be
    // present — not merely a high count. MET forecasts from "now" forward, so an
    // early-morning boot (e.g. 03:00) yields ~21 hours that miss the cold pre-dawn
    // hours; counting alone would wrongly mark that a full day and bias the
    // active-day budget. Requiring hour 0 is DST-safe (every local day has a
    // midnight) and only the at/near-midnight fetch (or tomorrow) qualifies.
    fullDayCoverage: entries.some((entry) => entry.localHour === 0) && entries.length >= FULL_DAY_MIN_HOURS,
    symbolCode: midday.symbolCode,
    precipMmTotal: precipValues.length > 0 ? precipValues.reduce((sum, value) => sum + value, 0) : undefined,
  };
}

/**
 * Reduce a MET compact response to a PER-LOCAL-DAY summary map for the current
 * local day AND tomorrow (both inside MET's hourly horizon), or null when the
 * response is unusable / carries no hourly data for EITHER day (caller then falls
 * back to persistence). Each consumer reads the day it needs: the midnight
 * auto-apply path reads the just-started day (`todayKey`), the readout card reads
 * tomorrow. Pure — no I/O, no clock except the injected `nowMs`.
 */
export function summarizeMetForecastDays(
  raw: unknown,
  opts: { timeZone: string; nowMs: number },
): MetForecastDays | null {
  const series = parseTimeseries(raw, opts.timeZone);
  if (series.length === 0) return null;
  const todayKey = getDateKeyInTimeZone(new Date(opts.nowMs), opts.timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const byDay = Object.fromEntries(
    [todayKey, tomorrowKey].flatMap((dateKey) => {
      const entries = series.filter((entry) => (
        getDateKeyInTimeZone(new Date(entry.timeMs), opts.timeZone) === dateKey
      ));
      return entries.length > 0 ? [[dateKey, summarizeDay(dateKey, entries)] as const] : [];
    }),
  );
  return Object.keys(byDay).length > 0 ? { byDay } : null;
}

/** Coordinates rounded to MET's recommended 4 decimals (they reject/penalize over-precise lat/lon). */
export function buildMetForecastUrl(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(4);
  const lon = longitude.toFixed(4);
  return `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
}

/**
 * Hard ceiling on a single MET fetch. A hung socket must never freeze the
 * collector's midnight rollup loop (the rollup awaits this in a `.finally` that
 * then finalizes yesterday's accumulator and reschedules the timer), so the
 * fetch is bounded by an AbortController and a timed-out request is mapped to
 * `failed` (prior cache kept — transient-read discipline).
 */
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

export type MetForecastFetchDeps = {
  latitude: number;
  longitude: number;
  timeZone: string;
  nowMs: number;
  /** Mandatory MET User-Agent: "<app-id>/<version> (<contact>)". */
  userAgent: string;
  /** Injected HTTP boundary (the real `fetch`); kept injectable so the parser stays unit-testable. */
  fetchImpl?: typeof fetch;
  /** Conditional-request validator from a prior response (ETag/Last-Modified) → enables 304 reuse. */
  ifModifiedSince?: string;
  /** Abort the request after this many ms (default 8000) so a hung socket can't stall the rollup loop. */
  timeoutMs?: number;
  errorLog?: (...args: unknown[]) => void;
};

export type MetForecastFetchResult =
  | { outcome: 'ok'; days: MetForecastDays; expires?: string; lastModified?: string }
  // 304 carries the refreshed caching validators so the cache's Expires/Last-
  // Modified advance even when the temperature data is unchanged — otherwise a
  // lapsed Expires would force a conditional request on every scheduler tick.
  | { outcome: 'not_modified'; expires?: string; lastModified?: string }
  | { outcome: 'no_location' }
  | { outcome: 'failed' };

/**
 * Fetch + summarize the MET forecast into a per-local-day map (today + tomorrow).
 * Returns a discriminated outcome so the caller drives the fallback chain
 * (cache → persistence) and never deletes persisted state on a transient miss.
 * Skips entirely (and says so) when the hub has no usable location — never
 * requests lat/lon 0,0.
 */
const hasUsableLocation = (latitude: number, longitude: number): boolean => (
  Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0)
);

/** The subset of an HTTP `Response` this module reads (status + caching validators + body). */
type MetResponseLike = {
  status: number;
  ok: boolean;
  statusText: string;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

const readValidators = (response: MetResponseLike): { expires?: string; lastModified?: string } => ({
  expires: response.headers.get('expires') ?? undefined,
  lastModified: response.headers.get('last-modified') ?? undefined,
});

/** Map a fetched MET response to an outcome (304 → not_modified, !ok → failed, parse → ok/failed). */
async function interpretMetResponse(
  response: MetResponseLike,
  deps: MetForecastFetchDeps,
): Promise<MetForecastFetchResult> {
  if (response.status === 304) return { outcome: 'not_modified', ...readValidators(response) };
  if (!response.ok) {
    deps.errorLog?.(`MET forecast: ${response.status} ${response.statusText}`);
    return { outcome: 'failed' };
  }
  const days = summarizeMetForecastDays(await response.json(), { timeZone: deps.timeZone, nowMs: deps.nowMs });
  if (!days) {
    deps.errorLog?.('MET forecast: response carried no usable hourly data for today or tomorrow');
    return { outcome: 'failed' };
  }
  return { outcome: 'ok', days, ...readValidators(response) };
}

export async function fetchMetForecast(deps: MetForecastFetchDeps): Promise<MetForecastFetchResult> {
  if (!hasUsableLocation(deps.latitude, deps.longitude)) return { outcome: 'no_location' };
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(buildMetForecastUrl(deps.latitude, deps.longitude), {
      headers: {
        Accept: 'application/json',
        'User-Agent': deps.userAgent,
        ...(deps.ifModifiedSince ? { 'If-Modified-Since': deps.ifModifiedSince } : {}),
      },
      signal: controller.signal,
    });
    return await interpretMetResponse(response as MetResponseLike, deps);
  } catch (error) {
    // An AbortError (timeout) lands here too — treated as a transient failure so
    // the caller keeps the prior cache and never clears it.
    deps.errorLog?.('MET forecast: fetch failed', error);
    return { outcome: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
