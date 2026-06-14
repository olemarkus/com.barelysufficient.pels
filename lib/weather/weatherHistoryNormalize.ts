import type {
  MetDaySummary,
  WeatherHistoryState,
  WeatherMetForecastCache,
} from '../../packages/contracts/src/weatherAdvisorTypes';

/**
 * Normalizers for the persisted "derived" weather-history fields (the fit, the
 * budget suggestion, and the auto-apply audit). Split out of `weatherHistory.ts`
 * to keep that module under its size budget. All three are strip/default — never
 * reject — so a record's irreplaceable temperature history always survives.
 */

/**
 * A stored fit predating the suppression fields must still satisfy the contract
 * (the readout serves it verbatim before the first recompute). Real values win;
 * a missing field defaults to "no suppression" — exactly true of a fit computed
 * before the feature existed.
 */
export function defaultStoredFit(raw: Record<string, unknown>): WeatherHistoryState['latestFit'] {
  return {
    suppressedDaysExcluded: 0,
    suppressionFilterRelaxed: false,
    recentColdSuppressionSuspected: false,
    ...raw,
  } as WeatherHistoryState['latestFit'];
}

export function defaultStoredSuggestion(raw: Record<string, unknown>): WeatherHistoryState['latestSuggestion'] {
  return { budgetMayBeLimiting: false, ...raw } as WeatherHistoryState['latestSuggestion'];
}

/**
 * Auto-apply audit: strip-not-reject. A malformed value is dropped (the record's
 * irreplaceable history must survive), so it must be fully shaped —
 * `{ dateKey, kwh, appliedAtMs }` — or it's discarded.
 */
export function normalizeLastAutoApply(raw: unknown): WeatherHistoryState['lastAutoApply'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { dateKey, kwh, appliedAtMs } = raw as Record<string, unknown>;
  if (typeof dateKey !== 'string' || typeof kwh !== 'number' || typeof appliedAtMs !== 'number') return undefined;
  if (!Number.isFinite(kwh) || !Number.isFinite(appliedAtMs)) return undefined;
  return { dateKey, kwh, appliedAtMs };
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalFinite = (value: unknown): number | undefined => (finiteNumber(value) ? value : undefined);
const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * One persisted MET day: strip-not-reject. The mandatory mean/min/max + dateKey
 * must be present and finite (else the day is useless and dropped), while the
 * optional evening/display fields are individually stripped if malformed.
 * `hourCount`/`fullDayCoverage` default for a day persisted before they existed.
 */
function normalizeMetDay(raw: unknown): MetDaySummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const blob = raw as Record<string, unknown>;
  if (typeof blob.dateKey !== 'string') return undefined;
  if (!finiteNumber(blob.meanTempC) || !finiteNumber(blob.minTempC) || !finiteNumber(blob.maxTempC)) return undefined;
  const eveningMinTempC = optionalFinite(blob.eveningMinTempC);
  const eveningMeanTempC = optionalFinite(blob.eveningMeanTempC);
  const symbolCode = optionalString(blob.symbolCode);
  const precipMmTotal = optionalFinite(blob.precipMmTotal);
  return {
    dateKey: blob.dateKey,
    meanTempC: blob.meanTempC,
    minTempC: blob.minTempC,
    maxTempC: blob.maxTempC,
    hourCount: optionalFinite(blob.hourCount) ?? 0,
    fullDayCoverage: blob.fullDayCoverage === true,
    ...(eveningMinTempC !== undefined ? { eveningMinTempC } : {}),
    ...(eveningMeanTempC !== undefined ? { eveningMeanTempC } : {}),
    ...(symbolCode !== undefined ? { symbolCode } : {}),
    ...(precipMmTotal !== undefined ? { precipMmTotal } : {}),
  };
}

/**
 * Cached MET forecast: strip-not-reject, per-day. Each `byDay` entry is
 * normalized independently and a malformed day is dropped; the whole cache is
 * dropped only when no usable day survives (then the suggestion falls back to
 * persistence). `fetchedAtMs` must be finite; the caching validators are
 * individually stripped if malformed. Keyed by each day's own `dateKey` so a
 * stray key/dateKey mismatch can never mis-route a lookup.
 */
export function normalizeMetForecast(raw: unknown): WeatherMetForecastCache | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const blob = raw as Record<string, unknown>;
  if (!finiteNumber(blob.fetchedAtMs)) return undefined;
  if (typeof blob.byDay !== 'object' || blob.byDay === null) return undefined;
  const byDay: Record<string, MetDaySummary> = Object.fromEntries(
    Object.values(blob.byDay as Record<string, unknown>).flatMap((value) => {
      const day = normalizeMetDay(value);
      return day ? [[day.dateKey, day] as const] : [];
    }),
  );
  if (Object.keys(byDay).length === 0) return undefined;
  const expires = optionalString(blob.expires);
  const lastModified = optionalString(blob.lastModified);
  return {
    byDay,
    fetchedAtMs: blob.fetchedAtMs,
    ...(expires !== undefined ? { expires } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
}
