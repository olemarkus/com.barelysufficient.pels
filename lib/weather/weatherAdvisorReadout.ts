import type {
  EnergySignatureFit,
  WeatherAdvisorPrediction,
  WeatherAdvisorReadoutPayload,
  WeatherAdvisorReadoutState,
  WeatherAdvisorSettings,
  WeatherAdvisorSuggestion,
  WeatherAdvisorYesterday,
  WeatherCoverageBin,
  WeatherDailyRecord,
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
  resolveForecastDeviceMeanTempC,
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
  forecastDeviceName?: string;
  /** Active daily budget (kWh); undefined when the daily budget is disabled. */
  currentDailyBudgetKwh?: number;
  /** Hard capacity cap (kW); the suggestion stays subordinate to it. */
  capacityLimitKw?: number;
  nowMs: number;
  timeZone: string;
};

/** Null = feature flag off → structural absence in the UI. */
export function buildWeatherAdvisorReadout(
  input: WeatherAdvisorReadoutInput,
): WeatherAdvisorReadoutPayload | null {
  const { settings, state } = input;
  if (!settings.enabled) return null;

  const settingsEcho = resolveSettingsEcho(input);

  // No configured device → an intentionally empty setup payload. Leftover
  // records (a previously-configured device's history) must not leak into the
  // setup card as if they described the current configuration.
  if (!settings.outdoorDeviceId) {
    return buildNeedsDevicePayload(settingsEcho, input.nowMs);
  }

  const todayKey = getDateKeyInTimeZone(new Date(input.nowMs), input.timeZone);
  const fit = state.latestFit ?? null;
  const readoutState = resolveReadoutState(input.backfillRunning, fit);

  const yearRecords = state.records.filter(
    (record) => record.dateKey >= shiftDateKey(todayKey, -SCATTER_WINDOW_DAYS),
  );
  const usableYearRecords = yearRecords.filter((record) => isUsableSignatureDay(record));

  const tomorrow = fit ? resolveTomorrowOutlook(input, fit, todayKey) : null;

  return {
    state: readoutState,
    driftSuspected: fit?.driftSuspected ?? false,
    driftDeviationKwh: resolveDriftDeviationKwh(fit, usableYearRecords),
    settings: settingsEcho,
    fit,
    coverage: buildCoverageBins(usableYearRecords, tomorrow?.prediction.tempMeanC),
    prediction: tomorrow?.prediction ?? null,
    suggestion: tomorrow?.suggestion ?? null,
    scatter: buildScatterBins(usableYearRecords),
    recentDays: buildRecentDays(yearRecords),
    yesterday: buildYesterday(state.records, fit, todayKey),
    usableDays: countUsableDays(state.records),
    backfilledDays: usableYearRecords.filter((record) => record.quality.backfilled).length,
    generatedAtMs: input.nowMs,
  };
}

function resolveSettingsEcho(input: WeatherAdvisorReadoutInput): WeatherAdvisorReadoutPayload['settings'] {
  return {
    outdoorDeviceId: input.settings.outdoorDeviceId ?? null,
    outdoorDeviceName: input.outdoorDeviceName ?? null,
    forecastDeviceId: input.settings.forecastDeviceId ?? null,
    forecastDeviceName: input.forecastDeviceName ?? null,
  };
}

function buildNeedsDevicePayload(
  settingsEcho: WeatherAdvisorReadoutPayload['settings'],
  nowMs: number,
): WeatherAdvisorReadoutPayload {
  return {
    state: 'needs_device',
    driftSuspected: false,
    driftDeviationKwh: null,
    settings: settingsEcho,
    fit: null,
    coverage: [],
    prediction: null,
    suggestion: null,
    scatter: [],
    recentDays: [],
    yesterday: null,
    usableDays: 0,
    backfilledDays: 0,
    generatedAtMs: nowMs,
  };
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

/**
 * The card is forward-looking, so the outlook always targets TOMORROW. The
 * persisted `latestSuggestion` targets the just-started day for most of the
 * day (the midnight recompute's actionable day), so it is reused only when it
 * already points at tomorrow; otherwise the cheap suggestion layer is
 * recomputed here from the persisted fit + tomorrow's forecast/persistence.
 */
function resolveTomorrowOutlook(
  input: WeatherAdvisorReadoutInput,
  fit: EnergySignatureFit,
  todayKey: string,
): { prediction: WeatherAdvisorPrediction; suggestion: WeatherAdvisorSuggestion } | null {
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const stored = input.state.latestSuggestion;
  const resolved = stored && stored.targetDateKey === tomorrowKey
    ? {
      meanTempC: stored.forecastMeanTempC,
      source: stored.forecastSource,
      result: {
        predictedKwh: stored.predictedKwh,
        predictedLowKwh: stored.predictedLowKwh,
        predictedHighKwh: stored.predictedHighKwh,
        suggestedBudgetKwh: stored.suggestedBudgetKwh,
        beyondObservedCold: stored.beyondObservedCold,
        beyondObservedWarm: stored.beyondObservedWarm,
      },
    }
    : recomputeTomorrowSuggestion(input, fit, tomorrowKey);
  if (!resolved) return null;

  const capacityCapKwh = input.capacityLimitKw !== undefined && input.capacityLimitKw > 0
    ? input.capacityLimitKw * 24
    : Number.POSITIVE_INFINITY;
  return {
    prediction: {
      tempMeanC: resolved.meanTempC,
      source: resolved.source === 'forecast_device' ? 'forecast' : 'recent',
      kwh: resolved.result.predictedKwh,
      lowKwh: resolved.result.predictedLowKwh,
      highKwh: resolved.result.predictedHighKwh,
      beyondObservedCold: resolved.result.beyondObservedCold,
      beyondObservedWarm: resolved.result.beyondObservedWarm,
    },
    suggestion: {
      kwh: resolved.result.suggestedBudgetKwh,
      currentDailyBudgetKwh: input.currentDailyBudgetKwh ?? null,
      cappedByCapacity: resolved.result.suggestedBudgetKwh >= capacityCapKwh - 1e-6,
    },
  };
}

function recomputeTomorrowSuggestion(
  input: WeatherAdvisorReadoutInput,
  fit: EnergySignatureFit,
  tomorrowKey: string,
): {
  meanTempC: number;
  source: 'forecast_device' | 'recent_days';
  result: ReturnType<typeof suggestDailyBudgetKwh>;
} | null {
  const forecastMean = resolveForecastDeviceMeanTempC(input.state, tomorrowKey);
  const persistenceMean = forecastMean === undefined ? resolvePersistenceMeanTempC(input.state) : undefined;
  const meanTempC = forecastMean ?? persistenceMean;
  if (meanTempC === undefined) return null;
  return {
    meanTempC,
    source: forecastMean !== undefined ? 'forecast_device' : 'recent_days',
    result: suggestDailyBudgetKwh({
      fit,
      forecastMeanTempC: meanTempC,
      capacityLimitKw: input.capacityLimitKw,
    }),
  };
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
