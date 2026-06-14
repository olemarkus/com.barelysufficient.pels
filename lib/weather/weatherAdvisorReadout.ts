import type {
  EnergySignatureFit,
  EnergySignatureSuggestion,
  WeatherAdvisorPrediction,
  WeatherAdvisorReadoutPayload,
  WeatherAdvisorReadoutState,
  WeatherAdvisorSettings,
  WeatherAdvisorSuggestion,
  WeatherAdvisorYesterday,
  WeatherCoverageBin,
  WeatherDailyRecord,
  WeatherDeviceReading,
  WeatherForecastStatus,
  WeatherHistoryState,
  WeatherRecentDay,
  WeatherScatterBin,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  countUsableDays,
  isUsableSignatureDay,
  predictDailyKwh,
  quantile,
} from '../../packages/shared-domain/src/energySignature/energySignature';
import { suggestDailyBudgetKwh } from '../../packages/shared-domain/src/energySignature/suggestDailyBudget';
import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';
import {
  resolveComingDayFromState,
  resolveMetDay,
  resolvePersistenceMeanTempC,
} from './energySignatureService';

/**
 * Pure assembly of the settings-UI weather readout from the collector's
 * in-memory state. Owns the resolution-in-producer work: state enum, scatter
 * decimation (1 °C bins + ≤90 raw recent days), 5 °C coverage bins, and the
 * always-TOMORROW prediction/suggestion. Consumers (settings UI) never branch
 * on raw records or provenance. No I/O — names, budget, and capacity arrive
 * as flat inputs from the setup-layer assembler.
 *
 * Design of record: `notes/weather-insight-spec.md`.
 */

/** Decimation window: the scatter advertises "one dot per day from the last year". */
const SCATTER_WINDOW_DAYS = 365;
const RECENT_RAW_DAYS = 90;
const COVERAGE_BIN_WIDTH_C = 5;
/** ≥14 usable days in a 5 °C bin = the solid coverage shade. */
const COVERAGE_SUFFICIENT_DAYS = 14;
const DRIFT_RECENT_DAYS = 14;

export type WeatherAdvisorReadoutInput = {
  settings: WeatherAdvisorSettings;
  state: WeatherHistoryState;
  backfillRunning: boolean;
  outdoorDeviceName?: string;
  /** Live outdoor temperature (on-demand read); undefined when unreadable. */
  currentOutdoorTempC?: number;
  /** Active daily budget (kWh); undefined when the daily budget is disabled. */
  currentDailyBudgetKwh?: number;
  /** Whether the daily budget feature is on — gates the auto-apply inert hint. */
  dailyBudgetEnabled?: boolean;
  /** Hard capacity cap (kW); the suggestion stays subordinate to it. */
  capacityLimitKw?: number;
  nowMs: number;
  timeZone: string;
};

/** The auto-apply echo, resolved once and shared by every payload branch. */
type AutoApplyEcho = Pick<
  WeatherAdvisorReadoutPayload,
  'dailyBudgetEnabled' | 'autoApplyDailyBudget' | 'lastAutoApply'
>;

function resolveAutoApplyEcho(input: WeatherAdvisorReadoutInput): AutoApplyEcho {
  const last = input.state.lastAutoApply;
  return {
    dailyBudgetEnabled: input.dailyBudgetEnabled ?? false,
    autoApplyDailyBudget: input.settings.autoApplyDailyBudget ?? false,
    lastAutoApply: last ? { dateKey: last.dateKey, kwh: last.kwh } : null,
  };
}

/** Null = feature flag off → structural absence in the UI. */
export function buildWeatherAdvisorReadout(
  input: WeatherAdvisorReadoutInput,
): WeatherAdvisorReadoutPayload | null {
  const { settings, state } = input;
  if (!settings.enabled) return null;

  const settingsEcho = resolveSettingsEcho(input);
  const todayKey = getDateKeyInTimeZone(new Date(input.nowMs), input.timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  // Both validity lines use the INSTANT on-demand device read (resolved in the
  // assembler), so a just-picked device confirms itself immediately and a
  // sub-capability-only forecast device is caught at once — rather than waiting
  // for a sample cycle (outdoor) or a full tomorrow profile (forecast).
  const outdoorReading = resolveDeviceReading(settings.outdoorDeviceId, input.currentOutdoorTempC);
  // The forecast comes from a direct MET Norway fetch, not a device — there is
  // no forecast device to validate, so the picker and its reading are gone.
  const dailyBudgetKwh = input.currentDailyBudgetKwh ?? null;

  // No configured device → an intentionally empty setup payload. Leftover
  // records (a previously-configured device's history) must not leak into the
  // setup card as if they described the current configuration.
  const autoApplyEcho = resolveAutoApplyEcho(input);
  if (!settings.outdoorDeviceId) {
    return buildNeedsDevicePayload({
      settingsEcho,
      forecastStatus: resolvePayloadForecastStatus(state, tomorrowKey),
      outdoorReading,
      dailyBudgetKwh,
      autoApplyEcho,
      nowMs: input.nowMs,
    });
  }
  const fit = state.latestFit ?? null;
  const readoutState = resolveReadoutState(input.backfillRunning, fit);

  const yearRecords = state.records.filter(
    (record) => record.dateKey >= shiftDateKey(todayKey, -SCATTER_WINDOW_DAYS),
  );
  const usableYearRecords = yearRecords.filter((record) => isUsableSignatureDay(record));

  const tomorrow = fit ? resolveTomorrowOutlook(input, fit, todayKey) : null;
  const forecastStatus = resolveOutlookForecastStatus(tomorrow, state, tomorrowKey);

  return {
    state: readoutState,
    driftSuspected: fit?.driftSuspected ?? false,
    driftDeviationKwh: resolveDriftDeviationKwh(fit, usableYearRecords),
    settings: settingsEcho,
    forecastStatus,
    outdoorReading,
    dailyBudgetKwh,
    ...autoApplyEcho,
    fit,
    coverage: buildCoverageBins(usableYearRecords, tomorrow?.prediction.tempMeanC),
    prediction: tomorrow?.prediction ?? null,
    suggestion: tomorrow?.suggestion ?? null,
    scatter: buildScatterBins(usableYearRecords),
    recentDays: buildRecentDays(yearRecords),
    yesterday: buildYesterday(state.records, fit, todayKey),
    usableDays: countUsableDays(state.records),
    backfilledDays: usableYearRecords.filter((record) => record.quality.backfilled).length,
    suppressedDaysExcluded: fit?.suppressedDaysExcluded ?? 0,
    generatedAtMs: input.nowMs,
  };
}

function resolveSettingsEcho(input: WeatherAdvisorReadoutInput): WeatherAdvisorReadoutPayload['settings'] {
  return {
    outdoorDeviceId: input.settings.outdoorDeviceId ?? null,
    outdoorDeviceName: input.outdoorDeviceName ?? null,
  };
}

function buildNeedsDevicePayload(params: {
  settingsEcho: WeatherAdvisorReadoutPayload['settings'];
  forecastStatus: WeatherForecastStatus;
  outdoorReading: WeatherDeviceReading;
  dailyBudgetKwh: number | null;
  autoApplyEcho: AutoApplyEcho;
  nowMs: number;
}): WeatherAdvisorReadoutPayload {
  return {
    state: 'needs_device',
    driftSuspected: false,
    driftDeviationKwh: null,
    settings: params.settingsEcho,
    forecastStatus: params.forecastStatus,
    outdoorReading: params.outdoorReading,
    dailyBudgetKwh: params.dailyBudgetKwh,
    ...params.autoApplyEcho,
    fit: null,
    coverage: [],
    prediction: null,
    suggestion: null,
    scatter: [],
    recentDays: [],
    yesterday: null,
    usableDays: 0,
    backfilledDays: 0,
    suppressedDaysExcluded: 0,
    generatedAtMs: params.nowMs,
  };
}

/**
 * Live reading of a configured device, for the Settings picker validity line.
 * No device → `no_device` (the picker shows only its hint); configured but no
 * current value → `unreadable`; otherwise the live reading.
 */
function resolveDeviceReading(
  deviceId: string | undefined,
  tempC: number | undefined,
): WeatherDeviceReading {
  if (!deviceId) return { status: 'no_device' };
  return tempC === undefined ? { status: 'unreadable' } : { status: 'reading', tempC };
}

function resolveDriftDeviationKwh(
  fit: EnergySignatureFit | null,
  usableYearRecords: WeatherDailyRecord[],
): number | null {
  if (!fit?.driftSuspected) return null;
  return computeDriftDeviationKwh(usableYearRecords, fit);
}

function resolveReadoutState(
  backfillRunning: boolean,
  fit: EnergySignatureFit | null,
): WeatherAdvisorReadoutState {
  if (fit) return 'ready';
  return backfillRunning ? 'backfilling' : 'learning';
}

/** A resolved coming-day mean + the suggestion result + display/verdict context. */
type ResolvedOutlook = {
  meanTempC: number;
  source: EnergySignatureSuggestion['forecastSource'];
  tempMinC?: number;
  tempMaxC?: number;
  coldEveningSuspected?: boolean;
  result: Pick<
    EnergySignatureSuggestion,
    'predictedKwh' | 'predictedLowKwh' | 'predictedHighKwh' | 'suggestedBudgetKwh'
    | 'beyondObservedCold' | 'beyondObservedWarm' | 'budgetMayBeLimiting'
  >;
};

/** Whether a forecast source is one the current pipeline emits (vs a legacy persisted value). */
const isCurrentForecastSource = (source: string): boolean => (
  source === 'met_api' || source === 'recent_days'
);

/**
 * The stored suggestion to reuse for tomorrow's outlook, or undefined to recompute.
 * Reused only when it targets tomorrow AND carries a CURRENT source: a pre-MET
 * upgrade can leave a `forecast_device`-sourced suggestion whose device-derived
 * numbers would be mislabeled `recent_days` if reused, so any legacy source is
 * recomputed through the MET/persistence resolver instead.
 */
const reusableStoredSuggestion = (
  stored: EnergySignatureSuggestion | undefined,
  tomorrowKey: string,
): EnergySignatureSuggestion | undefined => (
  stored !== undefined
    && stored.targetDateKey === tomorrowKey
    && isCurrentForecastSource(stored.forecastSource)
    ? stored
    : undefined
);

/**
 * The card is forward-looking, so the outlook always targets TOMORROW. The
 * persisted `latestSuggestion` already targets tomorrow (MET gives a complete
 * forward profile, so the midnight recompute targets tomorrow directly), so it
 * is reused as-is when it points there; otherwise the cheap suggestion layer is
 * recomputed here from the persisted fit + tomorrow's MET cache / persistence.
 */
function resolveTomorrowOutlook(
  input: WeatherAdvisorReadoutInput,
  fit: EnergySignatureFit,
  todayKey: string,
): {
  prediction: WeatherAdvisorPrediction;
  suggestion: WeatherAdvisorSuggestion;
  forecastStatus: WeatherForecastStatus;
} | null {
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const stored = reusableStoredSuggestion(input.state.latestSuggestion, tomorrowKey);
  // `!= null` (loose) for the persisted-optional fields: a JSON round-trip can
  // store `null`, and a strict `!== undefined` would let that null leak into a
  // `number` (tempMin/Max) or `boolean` (coldEvening) field.
  const resolved: ResolvedOutlook | null = stored
    ? {
      meanTempC: stored.forecastMeanTempC,
      source: stored.forecastSource,
      ...(stored.tempMinC != null ? { tempMinC: stored.tempMinC } : {}),
      ...(stored.tempMaxC != null ? { tempMaxC: stored.tempMaxC } : {}),
      ...(stored.coldEveningSuspected != null ? { coldEveningSuspected: stored.coldEveningSuspected } : {}),
      result: stored,
    }
    : recomputeTomorrowSuggestion(input, fit, tomorrowKey);
  if (!resolved) return null;

  const capacityCapKwh = input.capacityLimitKw !== undefined && input.capacityLimitKw > 0
    ? input.capacityLimitKw * 24
    : Number.POSITIVE_INFINITY;
  return {
    prediction: {
      tempMeanC: resolved.meanTempC,
      ...(resolved.tempMinC !== undefined ? { tempMinC: resolved.tempMinC } : {}),
      ...(resolved.tempMaxC !== undefined ? { tempMaxC: resolved.tempMaxC } : {}),
      kwh: resolved.result.predictedKwh,
      lowKwh: resolved.result.predictedLowKwh,
      highKwh: resolved.result.predictedHighKwh,
      beyondObservedCold: resolved.result.beyondObservedCold,
      beyondObservedWarm: resolved.result.beyondObservedWarm,
    },
    suggestion: {
      kwh: resolved.result.suggestedBudgetKwh,
      currentDailyBudgetKwh: input.currentDailyBudgetKwh ?? null,
      // True only when tomorrow's EXPECTED usage exceeds what the cap can deliver
      // in a day — the over-cap banner's actual claim. Gating on the predicted
      // demand (not the clamped suggestion) avoids a false positive when a tiny
      // hard cap clamps the [20,360] floor below the cap on a low-demand day.
      cappedByCapacity: resolved.result.predictedKwh >= capacityCapKwh - 1e-6,
      budgetMayBeLimiting: resolved.result.budgetMayBeLimiting,
      ...(resolved.coldEveningSuspected !== undefined
        ? { coldEveningSuspected: resolved.coldEveningSuspected } : {}),
    },
    forecastStatus: resolveForecastStatusFromSource(resolved.source),
  };
}

function recomputeTomorrowSuggestion(
  input: WeatherAdvisorReadoutInput,
  fit: EnergySignatureFit,
  tomorrowKey: string,
): ResolvedOutlook | null {
  const met = resolveComingDayFromState(input.state, fit, tomorrowKey);
  const meanTempC = met?.meanTempC ?? resolvePersistenceMeanTempC(input.state);
  if (meanTempC === undefined) return null;
  return {
    meanTempC,
    source: met ? met.source : 'recent_days',
    ...(met?.tempMinC !== undefined ? { tempMinC: met.tempMinC } : {}),
    ...(met?.tempMaxC !== undefined ? { tempMaxC: met.tempMaxC } : {}),
    ...(met?.coldEveningSuspected !== undefined ? { coldEveningSuspected: met.coldEveningSuspected } : {}),
    result: suggestDailyBudgetKwh({
      fit,
      forecastMeanTempC: meanTempC,
      capacityLimitKw: input.capacityLimitKw,
    }),
  };
}

/**
 * Payload forecastStatus: a prediction follows ITS provenance; without one
 * (learning / backfilling / needs_device), fall back to whether the MET cache
 * covers tomorrow so the always-rendered footer stays honest before the first fit.
 */
function resolveOutlookForecastStatus(
  outlook: { forecastStatus: WeatherForecastStatus } | null,
  state: WeatherHistoryState,
  tomorrowKey: string,
): WeatherForecastStatus {
  return outlook ? outlook.forecastStatus : resolvePayloadForecastStatus(state, tomorrowKey);
}

/**
 * The forecast comes from MET Norway: `met_api` → `forecast`; the persistence
 * fallback (`recent_days`) → `recent_days`. A lingering stored suggestion from
 * the retired +24h-device source would also be a non-`met_api` value, so it maps
 * to `recent_days` (its mean was a recent-days proxy anyway).
 */
function resolveForecastStatusFromSource(
  source: EnergySignatureSuggestion['forecastSource'],
): WeatherForecastStatus {
  return source === 'met_api' ? 'forecast' : 'recent_days';
}

/**
 * Forecast provenance when there is NO prediction — resolved from whether the
 * MET cache covers tomorrow so the always-rendered footer stays honest before
 * the first fit exists.
 */
function resolvePayloadForecastStatus(
  state: WeatherHistoryState,
  tomorrowKey: string,
): WeatherForecastStatus {
  // Mirror the suggestion path (resolveComingDayFromState): only credit MET when
  // tomorrow is FULLY covered. A partial cached day is rejected for the numbers
  // (→ recent_days), so the footer/attribution must not label it `forecast` either.
  return resolveMetDay(state.metForecast, tomorrowKey)?.fullDayCoverage === true ? 'forecast' : 'recent_days';
}

/** 1 °C bins over usable days — the count-weighted symbols the chart renders. */
function buildScatterBins(usableRecords: WeatherDailyRecord[]): WeatherScatterBin[] {
  const byBin = new Map<number, number[]>();
  for (const record of usableRecords) {
    const bin = Math.round(record.tempMeanC);
    byBin.set(bin, [...(byBin.get(bin) ?? []), record.kwhTotal as number]);
  }
  return [...byBin.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tempBinC, kwhs]) => ({
      tempBinC,
      kwhMedian: quantile(kwhs, 0.5),
      kwhQ1: quantile(kwhs, 0.25),
      kwhQ3: quantile(kwhs, 0.75),
      count: kwhs.length,
    }));
}

/**
 * 5 °C coverage bins from the coldest to the warmest observed usable day,
 * extended one bin when tomorrow's forecast falls outside the observed range
 * so the band can show tomorrow standing on thin ice.
 */
function buildCoverageBins(
  usableRecords: WeatherDailyRecord[],
  tomorrowTempC: number | undefined,
): WeatherCoverageBin[] {
  if (usableRecords.length === 0) return [];
  const temps = usableRecords.map((record) => record.tempMeanC);
  const spanTemps = tomorrowTempC === undefined ? temps : [...temps, tomorrowTempC];
  const firstBin = Math.floor(Math.min(...spanTemps) / COVERAGE_BIN_WIDTH_C) * COVERAGE_BIN_WIDTH_C;
  const lastBin = Math.floor(Math.max(...spanTemps) / COVERAGE_BIN_WIDTH_C) * COVERAGE_BIN_WIDTH_C;
  const binCount = Math.round((lastBin - firstBin) / COVERAGE_BIN_WIDTH_C) + 1;
  return Array.from({ length: binCount }, (_, index) => {
    const fromC = firstBin + index * COVERAGE_BIN_WIDTH_C;
    const days = temps.filter((temp) => temp >= fromC && temp < fromC + COVERAGE_BIN_WIDTH_C).length;
    return {
      fromC,
      toC: fromC + COVERAGE_BIN_WIDTH_C,
      days,
      sufficient: days >= COVERAGE_SUFFICIENT_DAYS,
    };
  });
}

/** Raw recent days (any quality, plottable kWh) for the accent overlay + tooltips. */
function buildRecentDays(yearRecords: WeatherDailyRecord[]): WeatherRecentDay[] {
  return yearRecords
    .filter((record) => (
      Number.isFinite(record.tempMeanC)
      && typeof record.kwhTotal === 'number'
      && Number.isFinite(record.kwhTotal)
      && record.kwhTotal > 0
    ))
    .slice(-RECENT_RAW_DAYS)
    .map((record) => ({
      dateKey: record.dateKey,
      tempMeanC: record.tempMeanC,
      kwhTotal: record.kwhTotal as number,
      quality: record.quality,
    }));
}

function buildYesterday(
  records: WeatherDailyRecord[],
  fit: EnergySignatureFit | null,
  todayKey: string,
): WeatherAdvisorYesterday | null {
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const record = records.find((entry) => entry.dateKey === yesterdayKey);
  if (!record || !isUsableSignatureDay(record)) return null;
  const kwhTotal = record.kwhTotal as number;
  return {
    dateKey: record.dateKey,
    tempMeanC: record.tempMeanC,
    kwhTotal,
    deviationKwh: fit ? kwhTotal - typicalKwhFor(fit, record.tempMeanC) : null,
  };
}

/** Median residual of the most recent usable days — the drift sentence's magnitude. */
function computeDriftDeviationKwh(usableRecords: WeatherDailyRecord[], fit: EnergySignatureFit): number {
  const residuals = usableRecords
    .slice(-DRIFT_RECENT_DAYS)
    .map((record) => (record.kwhTotal as number) - typicalKwhFor(fit, record.tempMeanC));
  return quantile(residuals, 0.5);
}

const typicalKwhFor = (fit: EnergySignatureFit, tempC: number): number => (
  predictDailyKwh(fit, tempC) ?? fit.medianDayKwh
);
