import type { Logger as PinoLogger } from 'pino';
import type {
  EnergySignatureSuggestion,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { fitEnergySignature } from '../../packages/shared-domain/src/energySignature/energySignature';
import { suggestDailyBudgetKwh } from '../../packages/shared-domain/src/energySignature/suggestDailyBudget';
import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';

/**
 * Derives the energy-signature fit and tomorrow's budget suggestion from the
 * collected history, stamping both onto the state blob (so the future UI
 * endpoint reads flat values) and emitting one structured log line — the only
 * surfacing the hidden feature has until the UI ships.
 */

/** Hours of tomorrow's profile the forecast device must have filled to beat persistence. */
const MIN_FORECAST_HOURS = 12;
/** Persistence fallback: average the trailing week of observed daily means. */
const PERSISTENCE_LOOKBACK_DAYS = 7;

export type EnergySignatureServiceDeps = {
  getNowMs: () => number;
  getTimeZone: () => string;
  /** Hard capacity cap (kW); the suggestion stays subordinate to it. */
  getCapacityLimitKw: () => number | undefined;
  logger: PinoLogger;
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

  const forecast = resolveComingDayMeanTempC(state, nowMs, deps.getTimeZone());
  const suggestion: EnergySignatureSuggestion | undefined = forecast
    ? {
      targetDateKey: forecast.targetDateKey,
      forecastMeanTempC: forecast.meanTempC,
      forecastSource: forecast.source,
      ...suggestDailyBudgetKwh({
        fit,
        forecastMeanTempC: forecast.meanTempC,
        capacityLimitKw: deps.getCapacityLimitKw(),
      }),
      computedAtMs: nowMs,
    }
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

/**
 * Resolves the expected mean temperature for the coming day. At the midnight
 * recompute the actionable budget day is the JUST-STARTED day — and that is
 * the day whose +24h forecast profile was filled across yesterday and is now
 * complete. Tomorrow's profile holds only ~one hour at that moment, so trying
 * today first is what makes the forecast device reachable in steady state
 * (and avoids the cold-biased night-hours-only prefix of a partial profile).
 */
function resolveComingDayMeanTempC(
  state: WeatherHistoryState,
  nowMs: number,
  timeZone: string,
): { targetDateKey: string; meanTempC: number; source: EnergySignatureSuggestion['forecastSource'] } | undefined {
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  for (const targetDateKey of [todayKey, shiftDateKey(todayKey, 1)]) {
    const forecast = resolveForecastDeviceMeanTempC(state, targetDateKey);
    if (forecast !== undefined) {
      return { targetDateKey, meanTempC: forecast, source: 'forecast_device' };
    }
  }
  const persistence = resolvePersistenceMeanTempC(state);
  if (persistence === undefined) return undefined;
  return { targetDateKey: todayKey, meanTempC: persistence, source: 'recent_days' };
}

/**
 * Mean of the forecast-device profile for one specific local day, or
 * undefined when fewer than `MIN_FORECAST_HOURS` hours have accumulated.
 * Shared with the settings-UI readout builder, which always targets TOMORROW
 * (the card is forward-looking), unlike the midnight recompute above.
 */
export function resolveForecastDeviceMeanTempC(
  state: WeatherHistoryState,
  targetDateKey: string,
): number | undefined {
  const forecastHours = Object.values(state.forecastHourly?.[targetDateKey] ?? {});
  if (forecastHours.length < MIN_FORECAST_HOURS) return undefined;
  return mean(forecastHours);
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
