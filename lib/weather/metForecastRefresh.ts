import type {
  MetDaySummary,
  WeatherHistoryState,
  WeatherMetForecastCache,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import type { MetDaySummaryWithCoverage, MetForecastFetchResult } from './metForecast';

/**
 * Pure decision/transform helpers for the collector's MET forecast refresh,
 * split out of `weatherCollector.ts` to keep it under its size budget. The
 * collector owns the I/O (the injected fetch) and single-flighting; this module
 * owns the cache-freshness gate and the fallback-chain reduction so both are
 * independently testable and the transient-read discipline lives in one place.
 */

/**
 * The cache covers both days the consumers need (today for auto-apply, tomorrow
 * for the readout card) when `byDay` carries an entry for each. A day rollover
 * drops a needed day even if `Expires` is still future, so this is checked
 * independently of Expires below.
 */
function coversNeededDays(
  cached: WeatherHistoryState['metForecast'],
  todayKey: string,
  tomorrowKey: string,
): boolean {
  return cached?.byDay?.[todayKey] !== undefined && cached.byDay[tomorrowKey] !== undefined;
}

/**
 * A cached summary is fresh (no refetch due, ≤ hourly per MET ToS) only when its
 * `Expires` is still in the future AND `byDay` still covers BOTH the current
 * local today and tomorrow. The day check is independent of Expires: a response
 * fetched shortly before midnight can carry an Expires that outlives midnight,
 * but once the day rolls a needed day is missing from `byDay` — without forcing a
 * refetch the rollup recompute would have no MET for the new tomorrow and fall
 * back to recent_days.
 */
function isMetCacheFresh(
  cached: WeatherHistoryState['metForecast'],
  nowMs: number,
  todayKey: string,
  tomorrowKey: string,
): boolean {
  if (!cached?.expires) return false;
  if (!coversNeededDays(cached, todayKey, tomorrowKey)) return false;
  const expiresMs = Date.parse(cached.expires);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

/** Drop the fetch-time-only `eveningHourCount` so the persisted day matches the MetDaySummary contract. */
function toPersistedDay(day: MetDaySummaryWithCoverage): MetDaySummary {
  const { eveningHourCount: _eveningHourCount, ...persisted } = day;
  return persisted;
}

/** Structured fields for the per-day MET refresh log (the day means, not the full summaries). */
export function metRefreshedLogFields(cache: WeatherMetForecastCache): Record<string, unknown> {
  return {
    event: 'weather_met_forecast_refreshed',
    days: Object.keys(cache.byDay).sort(),
    meanByDay: Object.fromEntries(Object.entries(cache.byDay).map(([k, day]) => [k, day.meanTempC])),
  };
}

/** Pure: reduce a successful MET fetch to the persisted cache shape (per-day map). */
function buildMetForecastCache(
  result: Extract<MetForecastFetchResult, { outcome: 'ok' }>,
  fetchedAtMs: number,
): WeatherMetForecastCache {
  const byDay: Record<string, MetDaySummary> = Object.fromEntries(
    Object.entries(result.days.byDay).map(([dateKey, day]) => [dateKey, toPersistedDay(day)]),
  );
  return {
    byDay,
    fetchedAtMs,
    ...(result.expires !== undefined ? { expires: result.expires } : {}),
    ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
  };
}

/**
 * Merge a 304's refreshed caching validators onto the existing cache without
 * touching the temperature data: the summary is confirmed unchanged, but the
 * server handed back a new `Expires`/`Last-Modified`, so advancing them (and the
 * fetch timestamp) restores "poll only when Expires lapses" instead of
 * re-issuing a conditional request on every scheduler tick. Returns the prior
 * cache unchanged when the 304 carried no new validators.
 */
function mergeNotModifiedValidators(
  cache: WeatherMetForecastCache,
  result: Extract<MetForecastFetchResult, { outcome: 'not_modified' }>,
  fetchedAtMs: number,
): WeatherMetForecastCache {
  if (result.expires === undefined && result.lastModified === undefined) return cache;
  return {
    ...cache,
    fetchedAtMs,
    ...(result.expires !== undefined ? { expires: result.expires } : {}),
    ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
  };
}

/**
 * What the collector should do with a MET fetch result, per the documented
 * fallback chain:
 * - `ok` → store the fresh cache (markDirty) + emit the refreshed log.
 * - `not_modified` (304) → the temperature data is current; refresh only the
 *   cached caching validators (Expires/Last-Modified) so a lapsed Expires stops
 *   re-triggering a conditional request every tick. No-op when no prior cache.
 * - `failed` / `no_location` → keep the prior cached value (NEVER clear it —
 *   transient-read discipline) and warn once.
 */
type MetRefreshAction =
  // `log` distinguishes a fresh summary (emit `weather_met_forecast_refreshed`)
  // from a 304 validators-only merge (persist the advanced Expires, but the
  // temperature data is unchanged so a "refreshed" log line would be misleading).
  | { kind: 'store'; cache: WeatherMetForecastCache; log: boolean }
  | { kind: 'keep' }
  | { kind: 'unavailable'; outcome: 'failed' | 'no_location' };

function decideMetRefreshAction(
  result: MetForecastFetchResult,
  cached: WeatherHistoryState['metForecast'],
  fetchedAtMs: number,
): MetRefreshAction {
  if (result.outcome === 'ok') return { kind: 'store', cache: buildMetForecastCache(result, fetchedAtMs), log: true };
  if (result.outcome === 'not_modified') {
    if (!cached) return { kind: 'keep' };
    const merged = mergeNotModifiedValidators(cached, result, fetchedAtMs);
    return merged === cached ? { kind: 'keep' } : { kind: 'store', cache: merged, log: false };
  }
  return { kind: 'unavailable', outcome: result.outcome };
}

/**
 * Collaborator the collector exposes so this module owns the whole refresh
 * dance (cache-gate → fetch → fallback chain) while the collector keeps the I/O
 * and its own state. Returns nothing; effects flow through the port.
 */
export type MetRefreshPort = {
  /** Injected fetch; absent ⇒ the MET source is off (refresh is skipped). */
  fetchForecast?: (opts: { ifModifiedSince?: string }) => Promise<MetForecastFetchResult>;
  getCache: () => WeatherHistoryState['metForecast'];
  getNowMs: () => number;
  /** Current local today dateKey (collector resolves it from nowMs + the hub timezone). */
  getTodayKey: () => string;
  /**
   * Current local tomorrow dateKey. A cache whose `byDay` no longer covers both
   * today and tomorrow is stale even if its Expires is still in the future (e.g.
   * fetched just before midnight, then the day rolled).
   */
  getTomorrowKey: () => string;
  /** False ⇒ the run was stopped or superseded mid-fetch; the result is discarded. */
  isStillCurrent: () => boolean;
  storeCache: (cache: WeatherMetForecastCache) => void;
  logRefreshed: (cache: WeatherMetForecastCache) => void;
  warnUnavailable: (outcome: 'failed' | 'no_location') => void;
};

/**
 * Runs one MET refresh through the documented fallback chain: skip while the
 * cached Expires is in the future AND `byDay` covers today+tomorrow; otherwise
 * fetch and store fresh (+log) on ok; merge the refreshed validators (no log) on
 * 304; warn-and-keep on failed/no_location (never clear — transient-read
 * discipline). The caller single-flights this (so the periodic timer and
 * rollup-path call cannot overlap).
 *
 * Conditional-request rule: send `If-Modified-Since` (the cached Last-Modified)
 * ONLY when the cache already covers BOTH needed days — i.e. we're refetching
 * purely for content-freshness past Expires, where a 304 legitimately keeps the
 * data and just advances the validators. When the cache is MISSING a needed day
 * (a day rollover), OMIT it to force a full 200 with a body: a 304 returns no
 * body and could not rebuild `byDay` for the newly-needed day.
 */
export async function runMetForecastRefresh(port: MetRefreshPort): Promise<void> {
  if (!port.fetchForecast) return;
  const cached = port.getCache();
  const todayKey = port.getTodayKey();
  const tomorrowKey = port.getTomorrowKey();
  if (isMetCacheFresh(cached, port.getNowMs(), todayKey, tomorrowKey)) return;
  // Conditional only when both needed days are present; a missing day forces a 200.
  const conditional = coversNeededDays(cached, todayKey, tomorrowKey) ? cached?.lastModified : undefined;
  const result = await port.fetchForecast(conditional !== undefined ? { ifModifiedSince: conditional } : {});
  if (!port.isStillCurrent()) return;
  const action = decideMetRefreshAction(result, cached, port.getNowMs());
  if (action.kind === 'store') {
    port.storeCache(action.cache);
    if (action.log) port.logRefreshed(action.cache);
  } else if (action.kind === 'unavailable') {
    port.warnUnavailable(action.outcome);
  }
}
