import type {
  WeatherDailyQuality,
  WeatherDailyRecord,
  WeatherDayAccumulator,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { isUnknownRecord } from '../utils/types';
import { getZonedParts, shiftDateKey } from '../utils/dateUtils';

/** Two years of daily records ≈ 90 KB JSON — well inside the persisted-state budget. */
export const WEATHER_HISTORY_RETENTION_DAYS = 730;
/** Keep in-progress accumulators for at most today + the two preceding days. */
const ACCUMULATOR_RETENTION_DAYS = 2;
/** How many future forecast dateKeys to retain (tomorrow + the day after around midnight). */
const FORECAST_DATEKEY_LIMIT = 2;
/** Physically plausible outdoor range; readings outside are sensor glitches. */
const MIN_PLAUSIBLE_C = -60;
const MAX_PLAUSIBLE_C = 60;

/** Shared by live sampling, backfill parsing, and persistence validation so the range never drifts apart. */
export function isPlausibleOutdoorTemperature(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_PLAUSIBLE_C
    && value <= MAX_PLAUSIBLE_C;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_KEY_PATTERN = /^([01]\d|2[0-3])$/;

const byDateKeyAscending = (a: { dateKey: string }, b: { dateKey: string }): number => (
  a.dateKey < b.dateKey ? -1 : 1
);

export function emptyWeatherHistoryState(): WeatherHistoryState {
  return { records: [] };
}

/** Local hour-of-day key ("00".."23") for an instant in a timezone. */
export function getLocalHourKey(date: Date, timeZone: string): string {
  return String(getZonedParts(date, timeZone).hour).padStart(2, '0');
}

/**
 * Accumulates one live outdoor-temperature sample into the day's running
 * mean/min/max. Samples landing in the same local hour as the previous one
 * (e.g. an app restart re-sampling on boot) are dropped so restart-heavy days
 * do not inflate `tempSampleCount` past the hours actually observed.
 */
export function applyActualSample(
  state: WeatherHistoryState,
  params: { dateKey: string; hourKey: string; temperatureC: number },
): WeatherHistoryState {
  const { dateKey, hourKey, temperatureC } = params;
  const accumulators = state.accumulators ?? {};
  const previous = accumulators[dateKey];
  if (previous?.lastHourKey === hourKey) return state;
  const next: WeatherDayAccumulator = previous
    ? {
      sumC: previous.sumC + temperatureC,
      count: previous.count + 1,
      minC: Math.min(previous.minC, temperatureC),
      maxC: Math.max(previous.maxC, temperatureC),
      lastHourKey: hourKey,
    }
    : {
      sumC: temperatureC, count: 1, minC: temperatureC, maxC: temperatureC, lastHourKey: hourKey,
    };
  return {
    ...state,
    accumulators: { ...accumulators, [dateKey]: next },
  };
}

/**
 * Records one forecast-device reading against the hour it predicts (~24 h
 * ahead). Only near-future dateKeys are retained; sampling across today fills
 * tomorrow's profile one hour at a time.
 */
export function applyForecastSample(
  state: WeatherHistoryState,
  params: { targetDateKey: string; hourKey: string; temperatureC: number; todayKey: string },
): WeatherHistoryState {
  const { targetDateKey, hourKey, temperatureC, todayKey } = params;
  if (targetDateKey <= todayKey) return state;
  const merged = {
    ...(state.forecastHourly ?? {}),
    [targetDateKey]: { ...(state.forecastHourly?.[targetDateKey] ?? {}), [hourKey]: temperatureC },
  };
  const keptKeys = Object.keys(merged)
    .filter((key) => key > todayKey)
    .sort()
    .slice(0, FORECAST_DATEKEY_LIMIT);
  return {
    ...state,
    forecastHourly: Object.fromEntries(keptKeys.map((key) => [key, merged[key]])),
  };
}

/**
 * Finalizes a closed local day: converts its accumulator into a permanent
 * record (joined with the day's kWh totals, snapshotted now because the power
 * tracker prunes its reliability metadata after ~30 days), then prunes
 * accumulators, stale forecast entries, and records beyond retention.
 *
 * A live rollup never overwrites an existing live record, but does replace a
 * backfilled one (live sampling beats reconstruction). Without an accumulator
 * there is nothing to record; pruning still runs. (Retry termination needs no
 * bookkeeping: consuming the accumulator is what makes a rollup one-shot.)
 */
export function rollupDay(
  state: WeatherHistoryState,
  params: {
    dateKey: string;
    dayLengthHours: number;
    kwhTotal?: number;
    kwhControlled?: number;
    unreliablePower: boolean;
  },
): WeatherHistoryState {
  const { dateKey, dayLengthHours, kwhTotal, kwhControlled, unreliablePower } = params;
  const accumulator = (state.accumulators ?? {})[dateKey];

  const records = accumulator
    ? upsertRecord(state.records, buildRollupRecord({
      dateKey, dayLengthHours, kwhTotal, kwhControlled, unreliablePower, accumulator,
    }), { overwriteLive: false })
    : state.records;

  const accumulatorCutoff = shiftDateKey(dateKey, -ACCUMULATOR_RETENTION_DAYS);
  const todayKey = shiftDateKey(dateKey, 1);
  return {
    ...state,
    records: pruneRecords(records, dateKey),
    accumulators: Object.fromEntries(
      Object.entries(state.accumulators ?? {})
        .filter(([key]) => key !== dateKey && key >= accumulatorCutoff),
    ),
    forecastHourly: Object.fromEntries(
      Object.entries(state.forecastHourly ?? {}).filter(([key]) => key >= todayKey),
    ),
  };
}

function buildRollupRecord(params: {
  dateKey: string;
  dayLengthHours: number;
  kwhTotal?: number;
  kwhControlled?: number;
  unreliablePower: boolean;
  accumulator: WeatherDayAccumulator;
}): WeatherDailyRecord {
  const { dateKey, dayLengthHours, kwhTotal, kwhControlled, unreliablePower, accumulator } = params;
  // A fully-observed day has one sample per local hour; allow a 6-hour
  // shortfall (boot gaps, transient device reads) before flagging partial.
  const requiredSamples = Math.max(1, dayLengthHours - 6);
  return {
    dateKey,
    ...(kwhTotal !== undefined ? { kwhTotal } : {}),
    ...(kwhControlled !== undefined ? { kwhControlled } : {}),
    tempMeanC: accumulator.sumC / accumulator.count,
    tempMinC: accumulator.minC,
    tempMaxC: accumulator.maxC,
    tempSampleCount: accumulator.count,
    quality: {
      partialTemp: accumulator.count < requiredSamples,
      missingKwh: kwhTotal === undefined,
      unreliablePower,
      backfilled: false,
    },
  };
}

/**
 * Merges backfilled records (from Homey Insights history) into the store.
 * Live records always win; existing backfilled records are refreshed.
 */
export function upsertBackfillRecords(
  state: WeatherHistoryState,
  records: WeatherDailyRecord[],
): WeatherHistoryState {
  let merged = state.records;
  for (const record of records) {
    merged = upsertRecord(merged, record, { overwriteLive: false });
  }
  const newestKey = merged.length > 0 ? merged[merged.length - 1].dateKey : undefined;
  return {
    ...state,
    records: newestKey ? pruneRecords(merged, newestKey) : merged,
  };
}

/**
 * Merges a late-recovered persisted state with what accumulated in memory
 * while the store was unreadable. The recovered blob is the richer base
 * (potentially years of records); the in-memory state holds only what this
 * process collected since boot, so recovered data wins wherever both exist —
 * except forecast hours (in-memory readings are fresher) and records the
 * recovered blob simply lacks.
 */
export function mergeRecoveredState(
  recovered: WeatherHistoryState,
  inMemory: WeatherHistoryState,
): WeatherHistoryState {
  let records = recovered.records;
  for (const record of inMemory.records) {
    records = upsertRecord(records, record, { overwriteLive: false });
  }
  const forecastKeys = new Set([
    ...Object.keys(recovered.forecastHourly ?? {}),
    ...Object.keys(inMemory.forecastHourly ?? {}),
  ]);
  const forecastHourly = Object.fromEntries(
    [...forecastKeys].sort().map((dateKey) => [dateKey, {
      ...(recovered.forecastHourly?.[dateKey] ?? {}),
      ...(inMemory.forecastHourly?.[dateKey] ?? {}),
    }]),
  );
  return {
    records,
    accumulators: { ...(inMemory.accumulators ?? {}), ...(recovered.accumulators ?? {}) },
    ...(forecastKeys.size > 0 ? { forecastHourly } : {}),
    ...(recovered.backfilledDeviceId ?? inMemory.backfilledDeviceId
      ? { backfilledDeviceId: recovered.backfilledDeviceId ?? inMemory.backfilledDeviceId }
      : {}),
  };
}

/**
 * True when any measurement gap overlaps the [startMs, endMs) window.
 * Near-duplicate of lib/dailyBudget's overlap helper, accepted deliberately:
 * the `no-weather-to-peer` dependency-cruiser rule forbids importing it.
 */
export function periodsOverlapWindow(
  periods: Array<{ start: number; end: number }>,
  startMs: number,
  endMs: number,
): boolean {
  return periods.some((period) => period.end > startMs && period.start < endMs);
}

/**
 * Validates an unknown persisted payload into a typed state, dropping
 * malformed entries. Returns null when the payload is absent or structurally
 * hopeless — the caller treats that as a transient-read signal and engages the
 * persistence grace window rather than overwriting (this store's temperature
 * history cannot be reconstructed once lost).
 */
export function normalizeWeatherHistoryState(raw: unknown): WeatherHistoryState | null {
  if (!isUnknownRecord(raw)) return null;
  if (!Array.isArray(raw.records)) return null;
  const accumulators = isUnknownRecord(raw.accumulators)
    ? normalizeAccumulators(raw.accumulators)
    : {};
  const forecastHourly = isUnknownRecord(raw.forecastHourly)
    ? normalizeForecastHourly(raw.forecastHourly)
    : {};
  const backfilledDeviceId = typeof raw.backfilledDeviceId === 'string' && raw.backfilledDeviceId.length > 0
    ? raw.backfilledDeviceId
    : undefined;
  return {
    records: raw.records.filter(isPlausibleRecord).sort(byDateKeyAscending),
    ...(Object.keys(accumulators).length > 0 ? { accumulators } : {}),
    ...(Object.keys(forecastHourly).length > 0 ? { forecastHourly } : {}),
    ...(backfilledDeviceId !== undefined ? { backfilledDeviceId } : {}),
  };
}

function normalizeAccumulators(raw: Record<string, unknown>): Record<string, WeatherDayAccumulator> {
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, WeatherDayAccumulator] => (
        DATE_KEY_PATTERN.test(entry[0]) && isPlausibleAccumulator(entry[1])
      ),
    ),
  );
}

function normalizeForecastHourly(raw: Record<string, unknown>): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(raw)
      .map(([dateKey, hours]) => (
        DATE_KEY_PATTERN.test(dateKey) && isUnknownRecord(hours)
          ? ([dateKey, normalizeForecastHours(hours)] as const)
          : undefined
      ))
      .filter((entry): entry is readonly [string, Record<string, number>] => (
        entry !== undefined && Object.keys(entry[1]).length > 0
      )),
  );
}

function normalizeForecastHours(raw: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, number] => (
        HOUR_KEY_PATTERN.test(entry[0]) && isPlausibleOutdoorTemperature(entry[1])
      ),
    ),
  );
}

function upsertRecord(
  records: WeatherDailyRecord[],
  record: WeatherDailyRecord,
  options: { overwriteLive: boolean },
): WeatherDailyRecord[] {
  const index = records.findIndex((existing) => existing.dateKey === record.dateKey);
  if (index === -1) {
    return [...records, record].sort(byDateKeyAscending);
  }
  const existing = records[index];
  if (!existing.quality.backfilled && !options.overwriteLive) return records;
  return records.map((entry, position) => (position === index ? record : entry));
}

function pruneRecords(records: WeatherDailyRecord[], newestDateKey: string): WeatherDailyRecord[] {
  const cutoff = shiftDateKey(newestDateKey, -WEATHER_HISTORY_RETENTION_DAYS);
  return records.filter((record) => record.dateKey >= cutoff);
}

// Net-metered homes can legitimately produce negative day totals (PV export),
// and the normalizer must accept anything the rollup writer can persist —
// rejecting a writer-producible value would drop the whole record, losing
// irreplaceable temperature data with it.
const isOptionalFiniteNumber = (value: unknown): boolean => (
  value === undefined || (typeof value === 'number' && Number.isFinite(value))
);

function isPlausibleAccumulator(value: unknown): value is WeatherDayAccumulator {
  if (!isUnknownRecord(value)) return false;
  return typeof value.sumC === 'number' && Number.isFinite(value.sumC)
    && typeof value.count === 'number' && Number.isFinite(value.count) && value.count >= 1
    && isPlausibleOutdoorTemperature(value.minC)
    && isPlausibleOutdoorTemperature(value.maxC);
}

function isPlausibleQuality(value: unknown): value is WeatherDailyQuality {
  if (!isUnknownRecord(value)) return false;
  return typeof value.partialTemp === 'boolean'
    && typeof value.missingKwh === 'boolean'
    && typeof value.unreliablePower === 'boolean'
    && typeof value.backfilled === 'boolean';
}

function isPlausibleRecord(value: unknown): value is WeatherDailyRecord {
  if (!isUnknownRecord(value)) return false;
  return typeof value.dateKey === 'string'
    && DATE_KEY_PATTERN.test(value.dateKey)
    && isPlausibleOutdoorTemperature(value.tempMeanC)
    && isPlausibleOutdoorTemperature(value.tempMinC)
    && isPlausibleOutdoorTemperature(value.tempMaxC)
    && typeof value.tempSampleCount === 'number'
    && Number.isFinite(value.tempSampleCount)
    && value.tempSampleCount >= 1
    && isOptionalFiniteNumber(value.kwhTotal)
    && isOptionalFiniteNumber(value.kwhControlled)
    && isPlausibleQuality(value.quality);
}
