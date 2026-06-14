import type { Logger as PinoLogger } from 'pino';
import type {
  EnergySignatureFit,
  EnergySignatureSuggestion,
  MetDaySummary,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { fitEnergySignature } from '../../packages/shared-domain/src/energySignature/energySignature';
import { suggestDailyBudgetKwh } from '../../packages/shared-domain/src/energySignature/suggestDailyBudget';
import { getDateKeyInTimeZone } from '../utils/dateUtils';

/**
 * Derives the energy-signature fit and the budget suggestion from the collected
 * history, stamping both onto the state blob (so the future UI endpoint reads
 * flat values) and emitting one structured log line — the only surfacing the
 * hidden feature has until the UI ships.
 *
 * AUTO-APPLY TARGET DAY: this runs at the 00:05 midnight rollup, and the
 * suggestion it stamps is what `performBudgetAutoApply` writes to the ACTIVE
 * daily budget. So the suggestion must target the JUST-STARTED day (today), not
 * tomorrow — applying tomorrow's forecast to today's active budget would be wrong
 * by one day. The forward-looking readout card resolves tomorrow separately (it
 * reads `byDay[tomorrowKey]`); the per-day MET cache lets each consumer read the
 * day it needs.
 *
 * The coming-day mean comes from the cached MET Norway forecast (`met_api`) when
 * it covers the target day, else the trailing-week persistence mean
 * (`recent_days`). MET supplies a SIMPLE per-hour mean — the same estimator the
 * fit was trained on — so it feeds the prediction directly; its min/max and
 * evening window are display/verdict context that never enter the kWh number.
 */

/** Persistence fallback: average the trailing week of observed daily means. */
const PERSISTENCE_LOOKBACK_DAYS = 7;

export type EnergySignatureServiceDeps = {
  getNowMs: () => number;
  getTimeZone: () => string;
  /** Hard capacity cap (kW); the suggestion stays subordinate to it. */
  getCapacityLimitKw: () => number | undefined;
  logger: PinoLogger;
};

/** Coming-day mean + the producer-resolved display/verdict context that travels with it. */
export type ResolvedComingDay = {
  targetDateKey: string;
  meanTempC: number;
  source: EnergySignatureSuggestion['forecastSource'];
  tempMinC?: number;
  tempMaxC?: number;
  coldEveningSuspected?: boolean;
};

export function computeEnergySignatureUpdate(
  state: WeatherHistoryState,
  deps: EnergySignatureServiceDeps,
): WeatherHistoryState {
  const nowMs = deps.getNowMs();
  const fit = fitEnergySignature(state.records, nowMs);
  if (!fit) {
    deps.logger.info({
      event: 'weather_advisor_fit',
      status: 'learning',
      recordCount: state.records.length,
    });
    const { latestFit: _fit, latestSuggestion: _suggestion, ...rest } = state;
    return rest;
  }

  const forecast = resolveComingDayMeanTempC(state, fit, nowMs, deps.getTimeZone());
  const suggestion = forecast
    ? buildSuggestion(fit, forecast, deps.getCapacityLimitKw(), nowMs)
    : undefined;

  deps.logger.info({
    event: 'weather_advisor_fit',
    status: 'fitted',
    model: fit.model,
    confidence: fit.confidence,
    usableDays: fit.usableDays,
    slopeKwhPerDegree: round2(fit.slopeKwhPerDegree),
    slopeCi: fit.slopeCiLow !== undefined ? [round2(fit.slopeCiLow), round2(fit.slopeCiHigh ?? 0)] : null,
    balancePointC: fit.balancePointC ?? null,
    baseLoadKwhPerDay: fit.baseLoadKwhPerDay !== undefined ? round2(fit.baseLoadKwhPerDay) : null,
    pseudoR2: round2(fit.pseudoR2),
    heatLossWPerK: fit.heatLossWPerK !== undefined ? Math.round(fit.heatLossWPerK) : null,
    curvatureSteeperWhenCold: fit.curvatureSteeperWhenCold,
    driftSuspected: fit.driftSuspected,
    suppressedDaysExcluded: fit.suppressedDaysExcluded,
    suppressionFilterRelaxed: fit.suppressionFilterRelaxed,
    recentColdSuppressionSuspected: fit.recentColdSuppressionSuspected,
    ...(suggestion ? {
      targetDateKey: suggestion.targetDateKey,
      forecastSource: suggestion.forecastSource,
      forecastMeanTempC: round2(suggestion.forecastMeanTempC),
      forecastTempMinC: suggestion.tempMinC !== undefined ? round2(suggestion.tempMinC) : null,
      forecastTempMaxC: suggestion.tempMaxC !== undefined ? round2(suggestion.tempMaxC) : null,
      coldEveningSuspected: suggestion.coldEveningSuspected ?? null,
      predictedKwhTargetDay: round2(suggestion.predictedKwh),
      suggestedBudgetKwh: round2(suggestion.suggestedBudgetKwh),
      beyondObservedCold: suggestion.beyondObservedCold,
      beyondObservedWarm: suggestion.beyondObservedWarm,
      budgetMayBeLimiting: suggestion.budgetMayBeLimiting,
    } : {}),
  });

  // Strip any stale suggestion symmetrically with the no-fit branch: a fresh
  // fit must never sit next to a week-old suggestion when the forecast was
  // unresolvable (e.g. a dead temperature sensor).
  const { latestSuggestion: _stale, ...rest } = state;
  return {
    ...rest,
    latestFit: fit,
    ...(suggestion ? { latestSuggestion: suggestion } : {}),
  };
}

/** Assembles the budget suggestion from the fit + resolved coming-day mean (drops undefined optionals). */
function buildSuggestion(
  fit: EnergySignatureFit,
  forecast: ResolvedComingDay,
  capacityLimitKw: number | undefined,
  nowMs: number,
): EnergySignatureSuggestion {
  return {
    targetDateKey: forecast.targetDateKey,
    forecastMeanTempC: forecast.meanTempC,
    forecastSource: forecast.source,
    ...suggestDailyBudgetKwh({ fit, forecastMeanTempC: forecast.meanTempC, capacityLimitKw }),
    ...(forecast.tempMinC !== undefined ? { tempMinC: forecast.tempMinC } : {}),
    ...(forecast.tempMaxC !== undefined ? { tempMaxC: forecast.tempMaxC } : {}),
    ...(forecast.coldEveningSuspected !== undefined
      ? { coldEveningSuspected: forecast.coldEveningSuspected } : {}),
    computedAtMs: nowMs,
  };
}

/**
 * Resolves the expected mean temperature for the day this rollup acts on — the
 * JUST-STARTED local day (today), because the stamped suggestion drives
 * `performBudgetAutoApply`, which writes the ACTIVE daily budget. The MET cache
 * (`met_api`) wins when `byDay` covers today; otherwise the trailing-week
 * persistence mean (`recent_days`). (The readout card resolves tomorrow
 * separately for its forward-looking display.)
 */
function resolveComingDayMeanTempC(
  state: WeatherHistoryState,
  fit: EnergySignatureFit,
  nowMs: number,
  timeZone: string,
): ResolvedComingDay | undefined {
  const currentDayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const resolved = resolveComingDayFromState(state, fit, currentDayKey);
  if (resolved) return resolved;
  const persistence = resolvePersistenceMeanTempC(state);
  if (persistence === undefined) return undefined;
  return { targetDateKey: currentDayKey, meanTempC: persistence, source: 'recent_days' };
}

/**
 * Shared MET resolution for one target day, used by both the midnight recompute
 * (today, the just-started day) and the settings-UI readout (tomorrow). Returns
 * the producer-resolved mean + display/verdict context when the cache covers the
 * day, else undefined (caller falls back to persistence). `coldEveningSuspected`
 * is resolved HERE, where the fit's balance point lives.
 */
export function resolveComingDayFromState(
  state: WeatherHistoryState,
  fit: EnergySignatureFit,
  targetDateKey: string,
): ResolvedComingDay | undefined {
  const met = resolveMetDay(state.metForecast, targetDateKey);
  // Only budget off a day MET covers in full. A boot/catch-up after the local
  // day is already underway yields a partial today (MET forecasts from "now"
  // forward, missing the elapsed hours) → a biased mean; fall back to
  // persistence rather than auto-apply a half-day budget. Tomorrow is always
  // full when fetched, so this only excludes the mid-day-restart active day.
  if (!met || !met.fullDayCoverage) return undefined;
  return {
    targetDateKey,
    meanTempC: met.meanTempC,
    source: 'met_api',
    tempMinC: met.minTempC,
    tempMaxC: met.maxTempC,
    coldEveningSuspected: deriveColdEveningSuspected(met, fit),
  };
}

/** The cached MET day summary for `dateKey` (exact match); undefined when absent. */
export function resolveMetDay(
  cache: WeatherHistoryState['metForecast'],
  dateKey: string,
): MetDaySummary | undefined {
  return cache?.byDay[dateKey];
}

/**
 * A genuine evening swing toward cold: the evening dips below the fit's balance
 * point while the day MEAN is still at/above it (a flat-cold day already reads
 * cold from the mean — that is not an "evening" story). Display/verdict only.
 * Undefined when there is no balance point (linear/uncorrelated fits) or no
 * evening sample.
 *
 * `!= null` (loose) guards both `fit.balancePointC` and `met.eveningMinTempC`:
 * either can deserialize from persisted state as `null` (a JSON-round-tripped
 * optional), and a strict `=== undefined` would let `null` through, where
 * `eveningMinTempC < null` coerces null→0 and reads a bogus 0 °C balance point.
 */
function deriveColdEveningSuspected(
  met: MetDaySummary,
  fit: EnergySignatureFit,
): boolean | undefined {
  if (fit.balancePointC == null || met.eveningMinTempC == null) return undefined;
  return met.eveningMinTempC < fit.balancePointC && met.meanTempC >= fit.balancePointC;
}

/** Persistence fallback: trailing-week mean of observed daily temperatures. */
export function resolvePersistenceMeanTempC(state: WeatherHistoryState): number | undefined {
  const recentTemps = state.records
    .slice(-PERSISTENCE_LOOKBACK_DAYS)
    .filter((record) => !record.quality.partialTemp)
    .map((record) => record.tempMeanC);
  if (recentTemps.length === 0) return undefined;
  return mean(recentTemps);
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const round2 = (value: number): number => Math.round(value * 100) / 100;
