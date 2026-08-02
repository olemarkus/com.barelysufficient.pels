import type {
  WeatherDailyQuality,
  WeatherDailyRecord,
  WeatherDayAccumulator,
  WeatherDaySuppression,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { isUnknownRecord } from '../utils/types';
import { getZonedParts, shiftDateKey } from '../utils/dateUtils';
import {
  defaultStoredFit,
  defaultStoredSuggestion,
  isPositiveFinite,
  normalizeBudgetPressure,
  normalizeLastAutoApply,
  normalizeMetForecast,
  normalizeSuppression,
  sanitizeRecordOptionalFields,
} from './weatherHistoryNormalize';
import { normalizeMeterScopeMarkers } from './weatherMeterScope';

/** Two years of daily records ≈ 90 KB JSON — well inside the persisted-state budget. */
export const WEATHER_HISTORY_RETENTION_DAYS = 730;
/** Bump only if a contaminated-kWh class is ever discovered again. */
export const KWH_PURGE_VERSION = 1;
/** Bump to re-run the controlled/uncontrolled split backfill over historical records. */
export const CONTROLLED_BACKFILL_VERSION = 2;
/** Keep in-progress accumulators for at most today + the two preceding days. */
const ACCUMULATOR_RETENTION_DAYS = 2;
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
 * Finalizes a closed local day: converts its accumulator into a permanent
 * record (joined with the day's kWh totals, snapshotted now because the power
 * tracker prunes its reliability metadata after ~30 days), then prunes
 * accumulators and records beyond retention.
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
    kwhUncontrolled?: number;
    unreliablePower: boolean;
    suppression?: WeatherDaySuppression;
    appliedBudgetKwh?: number;
  },
): WeatherHistoryState {
  const {
    dateKey, dayLengthHours, kwhTotal, kwhControlled, kwhUncontrolled, unreliablePower, suppression,
    appliedBudgetKwh,
  } = params;
  const accumulator = (state.accumulators ?? {})[dateKey];

  const records = accumulator
    ? upsertRecord(state.records, buildRollupRecord({
      dateKey, dayLengthHours, kwhTotal, kwhControlled, kwhUncontrolled, unreliablePower, suppression,
      appliedBudgetKwh, accumulator,
    }), { overwriteLive: false })
    : state.records;

  const accumulatorCutoff = shiftDateKey(dateKey, -ACCUMULATOR_RETENTION_DAYS);
  return {
    ...state,
    records: pruneRecords(records, dateKey),
    accumulators: Object.fromEntries(
      Object.entries(state.accumulators ?? {})
        .filter(([key]) => key !== dateKey && key >= accumulatorCutoff),
    ),
  };
}

function buildRollupRecord(params: {
  dateKey: string;
  dayLengthHours: number;
  kwhTotal?: number;
  kwhControlled?: number;
  kwhUncontrolled?: number;
  unreliablePower: boolean;
  suppression?: WeatherDaySuppression;
  appliedBudgetKwh?: number;
  accumulator: WeatherDayAccumulator;
}): WeatherDailyRecord {
  const {
    dateKey, dayLengthHours, kwhTotal, kwhControlled, kwhUncontrolled, unreliablePower, suppression,
    appliedBudgetKwh, accumulator,
  } = params;
  // A fully-observed day has one sample per local hour; allow a 6-hour
  // shortfall (boot gaps, transient device reads) before flagging partial.
  const requiredSamples = Math.max(1, dayLengthHours - 6);
  const cleanSuppression = normalizeSuppression(suppression);
  return {
    dateKey,
    ...(kwhTotal !== undefined ? { kwhTotal } : {}),
    ...(kwhControlled !== undefined ? { kwhControlled } : {}),
    ...(kwhUncontrolled !== undefined ? { kwhUncontrolled } : {}),
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
    ...(isPositiveFinite(appliedBudgetKwh) ? { appliedBudgetKwh } : {}),
    ...(cleanSuppression !== undefined ? { suppression: cleanSuppression } : {}),
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
 * Forgets every field derived under one specific whole-home metering
 * arrangement, keeping everything scope-independent (temperature history and
 * its markers, suppression evidence, the MET cache). Dropped:
 * - the meter-kWh markers, so the meter pass re-runs and re-elects a source
 *   under the new arrangement;
 * - `kwhPurgeVersion`, so that re-run runs with `allowStrip` re-armed and may
 *   purge kWh values the new arrangement does not vouch for — without this the
 *   re-run only fills and the old scope's wrong values survive;
 * - `controlledBackfillVersion` (uncontrolled = total − controlled, so the
 *   split must re-resolve against the re-resolved totals);
 * - the fit/suggestion, which were learned from the old-scope kWh layer;
 * - EVERY retained record's kWh layer (total, controlled/uncontrolled split,
 *   `quality.kwhBackfilled` provenance — the day flips back to `missingKwh`).
 *   Those values were measured under the OLD arrangement: keeping them would
 *   let the next refit reproduce the old-scope signature immediately (the fit
 *   was just cleared, so it recomputes from whatever records still carry kWh),
 *   and a surviving `kwhBackfilled` flag would let the re-armed reconcile
 *   treat an old-meter fill as already validated where the new meter lacks
 *   history for the day. After the strip, only the re-run itself can re-vouch
 *   a day — from the NEW meter's Insights, or from the power tracker on full
 *   days after the new arrangement took effect;
 * - the scope stamp and tracker epoch — the caller stamps both for the new
 *   arrangement in the same transition (`WeatherCollector.reconcileMeterScope`).
 */
export function stripMeterScopeDerivedState(state: WeatherHistoryState): WeatherHistoryState {
  const {
    meterKwhBackfillDone: _done,
    meterKwhDeviceId: _meter,
    kwhPurgeVersion: _purge,
    controlledBackfillVersion: _split,
    latestFit: _fit,
    latestSuggestion: _suggestion,
    // The budget-pressure term is a function of `kwhTotal − appliedBudgetKwh`,
    // so it is scope-derived exactly like the fit and must go with it. Keeping
    // it would let a term accumulated under the OLD metering arrangement keep
    // raising the budget on top of a fit rebuilt from nothing, and it would take
    // a week of leak to clear.
    budgetPressure: _pressure,
    meterScopeSignature: _scope,
    meterScopeSinceDateKey: _scopeSince,
    ...kept
  } = state;
  return { ...kept, records: kept.records.map(stripRecordKwhEvidence) };
}

/**
 * The per-record arm of the scope strip: removes the day's kWh evidence and
 * its meter-fill provenance, leaving a `missingKwh` record whose temperature
 * fields, quality flags, and suppression evidence are untouched. Records that
 * carry no kWh evidence are returned by reference so an all-clean record set
 * costs nothing.
 */
function stripRecordKwhEvidence(record: WeatherDailyRecord): WeatherDailyRecord {
  const hasKwhEvidence = record.kwhTotal !== undefined
    || record.kwhControlled !== undefined
    || record.kwhUncontrolled !== undefined
    || record.quality.kwhBackfilled === true;
  if (!hasKwhEvidence) return record;
  const {
    kwhTotal: _total, kwhControlled: _controlled, kwhUncontrolled: _uncontrolled, ...rest
  } = record;
  const { kwhBackfilled: _flag, ...quality } = record.quality;
  return { ...rest, quality: { ...quality, missingKwh: true } };
}

/**
 * Merges a late-recovered persisted state with what accumulated in memory
 * while the store was unreadable. The recovered blob is the richer base
 * (potentially years of records); the in-memory state holds only what this
 * process collected since boot, so recovered data wins wherever both exist —
 * except the cached MET forecast and the derived fit/suggestion, where
 * in-memory is the fresher computation, and records the recovered blob lacks.
 */
export function mergeRecoveredState(
  recovered: WeatherHistoryState,
  inMemory: WeatherHistoryState,
): WeatherHistoryState {
  let records = recovered.records;
  for (const record of inMemory.records) {
    records = upsertRecord(records, record, { overwriteLive: false });
  }
  // In-memory forecast/fit/suggestion are the fresher computation; fall back to
  // the recovered blob's when this process has not refreshed one yet.
  const metForecast = inMemory.metForecast ?? recovered.metForecast;
  const latestFit = inMemory.latestFit ?? recovered.latestFit;
  const latestSuggestion = inMemory.latestSuggestion ?? recovered.latestSuggestion;
  // Live audit wins, falling back to recovered.
  const lastAutoApply = inMemory.lastAutoApply ?? recovered.lastAutoApply;
  // The pressure term is an ACCUMULATOR, not a recomputation, so "live wins"
  // would be wrong here: this function only runs after a failed boot read, which
  // means the in-memory state started EMPTY and its term is a restart-from-zero
  // produced by a single fold. Select by how many closed days each has folded.
  const budgetPressure = [inMemory.budgetPressure, recovered.budgetPressure]
    .filter((term) => term !== undefined)
    // Later `throughDateKey` wins; on a TIE the larger term wins. The tie is the
    // case that matters: both sides folded the same days, but the in-memory one
    // restarted from zero after the failed read, so an arbitrary pick would
    // discard the recovered evidence this selection exists to keep.
    .sort((a, b) => {
      if (a.throughDateKey !== b.throughDateKey) return a.throughDateKey < b.throughDateKey ? 1 : -1;
      return b.kwh - a.kwh;
    })[0];
  return {
    records,
    accumulators: { ...(inMemory.accumulators ?? {}), ...(recovered.accumulators ?? {}) },
    ...(metForecast ? { metForecast } : {}),
    ...mergeBackfillMarkers(recovered, inMemory),
    ...(latestFit ? { latestFit } : {}),
    ...(latestSuggestion ? { latestSuggestion } : {}),
    ...(lastAutoApply ? { lastAutoApply } : {}),
    ...(budgetPressure ? { budgetPressure } : {}),
  };
}

function mergeBackfillMarkers(
  recovered: WeatherHistoryState,
  inMemory: WeatherHistoryState,
): Pick<
  WeatherHistoryState,
  'backfilledDeviceId' | 'backfillVersion' | 'meterKwhBackfillDone' | 'meterKwhDeviceId'
  | 'kwhPurgeVersion' | 'controlledBackfillVersion' | 'meterScopeSignature' | 'meterScopeSinceDateKey'
  > {
  // Temperature marker: prefer the recovered pair; the version describes the
  // same completed run as its deviceId, so they must travel together.
  const tempSource = recovered.backfilledDeviceId !== undefined ? recovered : inMemory;
  // Meter markers and the purge/split/scope stamps: recovered-only. An
  // in-memory completion was computed while the store was unreadable, against
  // a record set the recovered blob may extend by months — carrying it over
  // would latch those days unfilled (or unpurged) forever; dropping it costs
  // one idempotent re-run next start. The scope stamp travels with the meter
  // markers it vouches for; the caller re-reconciles it against the live
  // arrangement right after the merge.
  return {
    ...(tempSource.backfilledDeviceId !== undefined ? { backfilledDeviceId: tempSource.backfilledDeviceId } : {}),
    ...(tempSource.backfilledDeviceId !== undefined && tempSource.backfillVersion !== undefined
      ? { backfillVersion: tempSource.backfillVersion }
      : {}),
    ...(recovered.meterKwhBackfillDone === true ? { meterKwhBackfillDone: true } : {}),
    ...(recovered.meterKwhDeviceId !== undefined ? { meterKwhDeviceId: recovered.meterKwhDeviceId } : {}),
    ...(recovered.kwhPurgeVersion !== undefined ? { kwhPurgeVersion: recovered.kwhPurgeVersion } : {}),
    ...(recovered.controlledBackfillVersion !== undefined
      ? { controlledBackfillVersion: recovered.controlledBackfillVersion }
      : {}),
    ...(recovered.meterScopeSignature !== undefined
      ? {
        meterScopeSignature: recovered.meterScopeSignature,
        ...(recovered.meterScopeSinceDateKey !== undefined
          ? { meterScopeSinceDateKey: recovered.meterScopeSinceDateKey }
          : {}),
      }
      : {}),
  };
}

/**
 * Rebuilds every record's kWh layer from the two admissible sources, in trust
 * order: the power tracker (the budget's own metric — always wins where it
 * holds a real total for the day) and the validated meter-Insights backfill.
 * Trust rules, in decreasing protection:
 * - A live-rollup day-close snapshot is never overwritten or stripped: the
 *   tracker legitimately forgets old days while the snapshot stays correct.
 * - A meter fill (`quality.kwhBackfilled`) was validated against the tracker
 *   when written, so it is refreshed where the current map covers the day
 *   and KEPT where it does not — history ages out of the Insights windows,
 *   and a bad read must never be able to destroy it.
 * - Unflagged kWh riding a reconstructed record (`quality.backfilled`) is
 *   the unvalidated legacy class (the retired Energy-report source is all it
 *   ever was — see `meterKwhBackfill.ts`): overwritten where the meter
 *   covers it, stripped back to `missingKwh` where it does not. The strip is
 *   a ONE-SHOT migration (`KWH_PURGE_VERSION` stamped by the caller after a
 *   conclusive run): the legacy class cannot regrow once the retired code is
 *   gone, while tracker-joined backfill kWh shares its unflagged signature —
 *   a recurring strip would erase those legitimate values one by one as the
 *   tracker's retention passes them. `allowStrip` additionally requires a
 *   `complete` fetch, so a partially readable Insights day can fill but
 *   never delete.
 */
export function reconcileKwhSources(
  state: WeatherHistoryState,
  params: {
    getDailyKwh: (dateKey: string) => { total?: number; controlled?: number; uncontrolled?: number };
    meterDailyKwh: Record<string, number>;
    allowStrip: boolean;
  },
): { state: WeatherHistoryState; filledFromMeter: number; strippedDays: number; changedDays: number } {
  let filledFromMeter = 0;
  let strippedDays = 0;
  let changedDays = 0;
  const records = state.records.map((record) => {
    const next = reconcileRecordKwh(record, params);
    if (next === record) return record;
    changedDays += 1;
    if (next.quality.kwhBackfilled === true) filledFromMeter += 1;
    if (next.quality.missingKwh && !record.quality.missingKwh) strippedDays += 1;
    return next;
  });
  if (changedDays === 0) return { state, filledFromMeter, strippedDays, changedDays };
  return { state: { ...state, records }, filledFromMeter, strippedDays, changedDays };
}

function reconcileRecordKwh(
  record: WeatherDailyRecord,
  params: {
    getDailyKwh: (dateKey: string) => { total?: number; controlled?: number; uncontrolled?: number };
    meterDailyKwh: Record<string, number>;
    allowStrip: boolean;
  },
): WeatherDailyRecord {
  const tracker = params.getDailyKwh(record.dateKey);
  // A zero total is "no real measurement" (install day, tracker reset), not
  // an authoritative day — it must not overwrite a meter-sourced value.
  if (tracker.total !== undefined && tracker.total > 0) {
    const next = trackerWinRecord(record, tracker);
    return recordKwhEquals(record, next) ? record : next;
  }
  const meterValidated = record.quality.kwhBackfilled === true;
  const meterKwh = params.meterDailyKwh[record.dateKey];
  if (meterKwh !== undefined && (record.kwhTotal === undefined || meterValidated || record.quality.backfilled)) {
    // The meter is whole-home with no managed/background split — a stale
    // controlled/uncontrolled split paired with a fresh total is incoherent.
    const { kwhControlled: _droppedControlled, kwhUncontrolled: _droppedUncontrolled, ...rest } = record;
    const next: WeatherDailyRecord = {
      ...rest,
      kwhTotal: meterKwh,
      quality: { ...record.quality, missingKwh: false, kwhBackfilled: true },
    };
    return recordKwhEquals(record, next) ? record : next;
  }
  const legacyUnvalidated = !meterValidated && record.quality.backfilled && record.kwhTotal !== undefined;
  if (params.allowStrip && legacyUnvalidated && meterKwh === undefined) {
    const {
      kwhTotal: _droppedTotal, kwhControlled: _droppedControlled, kwhUncontrolled: _droppedUncontrolled, ...rest
    } = record;
    const { kwhBackfilled: _droppedFlag, ...quality } = record.quality;
    return { ...rest, quality: { ...quality, missingKwh: true } };
  }
  return record;
}

/** The tracker holds a real total — adopt it and refresh the controlled/uncontrolled split from it. */
function trackerWinRecord(
  record: WeatherDailyRecord,
  tracker: { total?: number; controlled?: number; uncontrolled?: number },
): WeatherDailyRecord {
  const { kwhBackfilled: _droppedFlag, ...quality } = record.quality;
  // Drop BOTH stale split fields: this branch refreshes the split from the
  // tracker, so a previous controlled/uncontrolled value must not survive next
  // to the fresh total when the tracker can't supply that side for the day.
  const { kwhControlled: _droppedControlled, kwhUncontrolled: _droppedUncontrolled, ...recordRest } = record;
  return {
    ...recordRest,
    kwhTotal: tracker.total,
    ...(tracker.controlled !== undefined ? { kwhControlled: tracker.controlled } : {}),
    ...(tracker.uncontrolled !== undefined ? { kwhUncontrolled: tracker.uncontrolled } : {}),
    quality: { ...quality, missingKwh: false },
  };
}

function recordKwhEquals(before: WeatherDailyRecord, after: WeatherDailyRecord): boolean {
  return before.kwhTotal === after.kwhTotal
    && before.kwhControlled === after.kwhControlled
    && before.kwhUncontrolled === after.kwhUncontrolled
    && before.quality.missingKwh === after.quality.missingKwh
    && before.quality.kwhBackfilled === after.quality.kwhBackfilled;
}

/**
 * Completes the controlled/uncontrolled split on RECONSTRUCTED days (a
 * backfilled record carrying a whole-home `kwhTotal`). Two cases, by where the
 * day's `kwhControlled` came from:
 *
 * - **Tracker-join day** (`kwhControlled` present, NOT a whole-home meter fill):
 *   the temperature backfill already joined the tracker's own controlled total,
 *   which is authoritative and consistent with live days. Keep it untouched and
 *   only derive the missing `kwhUncontrolled = total − controlled`. Needs no
 *   managed-meter sum.
 * - **Meter-filled / controlled-less day** (`quality.kwhBackfilled`, or no
 *   controlled at all): the controlled-split backfill owns it — write BOTH from
 *   the validated managed-meter sum, clamped into [0, total]. Refresh, not
 *   fill-once, so a later COMPLETE run corrects an earlier PARTIAL run that
 *   missed a device window (the caller stamps its marker only on complete).
 *
 * Unchanged values are left untouched so a re-run is a no-op; live-rollup
 * records (`quality.backfilled === false`) are never touched. The meter-sum
 * split is APPROXIMATE — good for the uncontrolled-vs-temp slope, not per-day
 * claims: a managed device with no cumulative meter leaves its share in
 * uncontrolled, a per-day gap in one device's meter undercounts that day, and
 * the sum uses today's managed set across all days (a managed-set change after
 * latching is not retroactive). The median validation bounds the systematic
 * level, not these per-day effects.
 */
export function applyControlledBackfill(
  state: WeatherHistoryState,
  controlledDailyKwh: Record<string, number>,
): { state: WeatherHistoryState; patchedDays: number } {
  let patchedDays = 0;
  const records = state.records.map((record) => {
    if (record.kwhTotal === undefined || record.quality.backfilled !== true) return record;
    const next = controlledBackfillRecord(record, record.kwhTotal, controlledDailyKwh[record.dateKey]);
    if (next === record) return record;
    patchedDays += 1;
    return next;
  });
  if (patchedDays === 0) return { state, patchedDays };
  return { state: { ...state, records }, patchedDays };
}

function controlledBackfillRecord(
  record: WeatherDailyRecord,
  total: number,
  meterControlled: number | undefined,
): WeatherDailyRecord {
  // Tracker-join day: keep the authoritative controlled, just derive uncontrolled.
  if (record.kwhControlled !== undefined && record.quality.kwhBackfilled !== true) {
    const uncontrolled = Math.max(0, total - record.kwhControlled);
    return record.kwhUncontrolled === uncontrolled ? record : { ...record, kwhUncontrolled: uncontrolled };
  }
  // Meter-filled / controlled-less day: write both from the validated meter sum.
  if (meterControlled === undefined) return record;
  const controlled = Math.max(0, meterControlled);
  const uncontrolled = Math.max(0, total - controlled);
  if (record.kwhControlled === controlled && record.kwhUncontrolled === uncontrolled) return record;
  return { ...record, kwhControlled: controlled, kwhUncontrolled: uncontrolled };
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
export function normalizeWeatherHistoryState(raw: unknown, currentDateKey?: string): WeatherHistoryState | null {
  if (!isUnknownRecord(raw)) return null;
  if (!Array.isArray(raw.records)) return null;
  const accumulators = isUnknownRecord(raw.accumulators)
    ? normalizeAccumulators(raw.accumulators)
    : {};
  const forecastHourly = isUnknownRecord(raw.forecastHourly)
    ? normalizeForecastHourly(raw.forecastHourly)
    : {};
  const lastAutoApply = normalizeLastAutoApply(raw.lastAutoApply);
  const budgetPressure = normalizeBudgetPressure(raw.budgetPressure);
  const metForecast = normalizeMetForecast(raw.metForecast);
  return {
    // Core fields gate via isPlausibleRecord (reject-and-drop); the optional
    // suppression/kwhUncontrolled layer is sanitized strip-not-reject so a
    // malformed extra never costs the record its irreplaceable temperature.
    records: raw.records.filter(isPlausibleRecord).map(sanitizeRecordOptionalFields).sort(byDateKeyAscending),
    ...(Object.keys(accumulators).length > 0 ? { accumulators } : {}),
    // Legacy +24h-device profile, no longer written; read for BC only (PR 2 drops it).
    ...(Object.keys(forecastHourly).length > 0 ? { forecastHourly } : {}),
    ...(metForecast ? { metForecast } : {}),
    ...normalizeBackfillMarkers(raw, currentDateKey),
    // Derived fields: producer-written and recomputed after every records
    // change, so a shallow shape check suffices — corruption self-heals at
    // the next rollup/backfill. The new suppression fields are defaulted so a
    // fit/suggestion persisted by a PRE-suppression version still satisfies the
    // contract when served to the readout before the first recompute.
    ...(isUnknownRecord(raw.latestFit) ? { latestFit: defaultStoredFit(raw.latestFit) } : {}),
    ...(isUnknownRecord(raw.latestSuggestion)
      ? { latestSuggestion: defaultStoredSuggestion(raw.latestSuggestion) }
      : {}),
    ...(lastAutoApply ? { lastAutoApply } : {}),
    ...(budgetPressure ? { budgetPressure } : {}),
  };
}

function normalizeBackfillMarkers(raw: Record<string, unknown>, currentDateKey?: string): Pick<
  WeatherHistoryState,
  'backfilledDeviceId' | 'backfillVersion' | 'meterKwhBackfillDone' | 'meterKwhDeviceId'
  | 'kwhPurgeVersion' | 'controlledBackfillVersion' | 'meterScopeSignature' | 'meterScopeSinceDateKey'
  > {
  const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const isPositiveInteger = (value: unknown): value is number => (
    typeof value === 'number' && Number.isInteger(value) && value > 0
  );
  return {
    ...(isNonEmptyString(raw.backfilledDeviceId) ? { backfilledDeviceId: raw.backfilledDeviceId } : {}),
    ...(isPositiveInteger(raw.backfillVersion) ? { backfillVersion: raw.backfillVersion } : {}),
    ...(raw.meterKwhBackfillDone === true ? { meterKwhBackfillDone: true } : {}),
    ...(isNonEmptyString(raw.meterKwhDeviceId) ? { meterKwhDeviceId: raw.meterKwhDeviceId } : {}),
    ...(isPositiveInteger(raw.kwhPurgeVersion) ? { kwhPurgeVersion: raw.kwhPurgeVersion } : {}),
    ...(isPositiveInteger(raw.controlledBackfillVersion)
      ? { controlledBackfillVersion: raw.controlledBackfillVersion }
      : {}),
    ...normalizeMeterScopeMarkers(raw, currentDateKey),
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
  const merged = mergeKwhLayer(existing, record);
  return records.map((entry, position) => (position === index ? merged : entry));
}

/**
 * A temperature refresh owns the temperature fields, not the kWh layer: a
 * re-stitched record that arrives without kWh must not erase a fill the kWh
 * reconcile produced (the reconcile may not re-run for months — its marker
 * is dropped on COMPLETE temperature runs only). Carrying the value is safe
 * even when it is legacy-contaminated: the reconcile purges that class.
 */
function mergeKwhLayer(existing: WeatherDailyRecord, incoming: WeatherDailyRecord): WeatherDailyRecord {
  // Only the kWh layer is carried — `suppression` is deliberately not, because
  // this path only ever fires for an incoming BACKFILL record (live records are
  // never overwritten, see upsertRecord) and backfill records carry no
  // suppression, so the existing side never has one to lose here.
  if (incoming.kwhTotal !== undefined || existing.kwhTotal === undefined) return incoming;
  return {
    ...incoming,
    kwhTotal: existing.kwhTotal,
    ...(existing.kwhControlled !== undefined ? { kwhControlled: existing.kwhControlled } : {}),
    ...(existing.kwhUncontrolled !== undefined ? { kwhUncontrolled: existing.kwhUncontrolled } : {}),
    quality: {
      ...incoming.quality,
      missingKwh: false,
      ...(existing.quality.kwhBackfilled === true ? { kwhBackfilled: true } : {}),
    },
  };
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
