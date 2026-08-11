import type {
  MetDaySummary,
  WeatherDailyRecord,
  WeatherDaySuppression,
  WeatherHistoryState,
  WeatherMetForecastCache,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { isUnknownRecord } from '../utils/types';
import { isFiniteNumber } from '../utils/appTypeGuards';

/**
 * Normalizers for the persisted weather-history layers `weatherHistory.ts` does
 * not gate with `isPlausibleRecord`: the derived fields (the fit, the budget
 * suggestion, the budget-pressure term, the auto-apply audit), the MET cache, and
 * each record's optional suppression/kWh-split layer. Split out of that hub to
 * keep it under its size budget. Every one of them is strip/default — never
 * reject — so a record's irreplaceable temperature history always survives a
 * malformed extra.
 */

export const isPositiveFinite = (value: unknown): value is number => isFiniteNumber(value) && value > 0;
/** Admits an explicit 0 — for fields where presence itself carries meaning. */
const isNonNegativeFinite = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

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
    recentSuppressionSuspected: false,
    ...raw,
  } as WeatherHistoryState['latestFit'];
}

export function defaultStoredSuggestion(raw: Record<string, unknown>): WeatherHistoryState['latestSuggestion'] {
  return {
    budgetMayBeLimiting: false,
    budgetPressureKwh: 0,
    ...raw,
  } as WeatherHistoryState['latestSuggestion'];
}

/**
 * Budget-pressure term: strip-not-reject, and fully shaped or discarded. A
 * dropped term simply restarts the loop at zero — it re-accumulates from the
 * next suppressed day, which is safer than trusting a half-written value that
 * would be added straight onto a persisted budget.
 */
export function normalizeBudgetPressure(raw: unknown): WeatherHistoryState['budgetPressure'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { kwh, throughDateKey } = raw as Record<string, unknown>;
  if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) return undefined;
  if (typeof throughDateKey !== 'string' || throughDateKey.length === 0) return undefined;
  return { kwh, throughDateKey };
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

/**
 * Strips invalid sub-fields; returns undefined when nothing trustworthy remains.
 *
 * The legacy duration counters drop ZERO as well as invalid: a diagnostics
 * aggregate exists for any shed/activation, so a no-deficit day would otherwise
 * persist an all-zero object on essentially every record.
 *
 * `budgetDeniedKwh`/`budgetDeniedMs` deliberately KEEP a zero: for the day-close
 * damage verdict, presence means the day's midnight was witnessed — a real
 * "watched to the close, nothing denied" — while absence routes
 * `dayWasBudgetDamaged` to the legacy counters. Dropping the zero would erase
 * that distinction on exactly the days it matters.
 */
export function normalizeSuppression(raw: unknown): WeatherDaySuppression | undefined {
  if (!isUnknownRecord(raw)) return undefined;
  const normalized: WeatherDaySuppression = {
    ...(isNonNegativeFinite(raw.budgetDeniedKwh) ? { budgetDeniedKwh: raw.budgetDeniedKwh } : {}),
    ...(isNonNegativeFinite(raw.budgetDeniedMs) ? { budgetDeniedMs: raw.budgetDeniedMs } : {}),
    ...(raw.budgetDeniedUnwitnessed === true ? { budgetDeniedUnwitnessed: true } : {}),
    ...(isPositiveFinite(raw.targetDeficitMs) ? { targetDeficitMs: raw.targetDeficitMs } : {}),
    ...(isPositiveFinite(raw.blockedByHeadroomMs) ? { blockedByHeadroomMs: raw.blockedByHeadroomMs } : {}),
    ...(raw.deadlineMissedToBudget === true ? { deadlineMissedToBudget: true } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Cleans the optional suppression/kwhUncontrolled layer on an already-core-valid
 * record: a malformed value is dropped, the record (and its temperature) kept.
 */
export function sanitizeRecordOptionalFields(record: WeatherDailyRecord): WeatherDailyRecord {
  const suppression = normalizeSuppression(record.suppression);
  const kwhUncontrolled = isFiniteNumber(record.kwhUncontrolled) ? record.kwhUncontrolled : undefined;
  const appliedBudgetKwh = isPositiveFinite(record.appliedBudgetKwh) ? record.appliedBudgetKwh : undefined;
  const {
    suppression: _suppression,
    kwhUncontrolled: _kwhUncontrolled,
    appliedBudgetKwh: _appliedBudgetKwh,
    ...rest
  } = record;
  return {
    ...rest,
    ...(kwhUncontrolled !== undefined ? { kwhUncontrolled } : {}),
    ...(appliedBudgetKwh !== undefined ? { appliedBudgetKwh } : {}),
    ...(suppression !== undefined ? { suppression } : {}),
  };
}
