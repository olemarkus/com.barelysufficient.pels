import type { EnergySignatureFit } from '../../../contracts/src/weatherAdvisorTypes';
import { predictDailyKwh } from './energySignature';

// Mirrors lib/dailyBudget/dailyBudgetConstants.ts and packages/contracts/src/
// dailyBudgetConstants.ts (all three must stay in sync). Deliberate copy:
// shared-domain ships inside the Homey app bundle while packages/contracts is
// DELETED from it by scripts/sanitize-homey-build.mjs (contracts is types-only
// at runtime — a value import here crash-looped the app at boot), and the
// lib/ copy is unreachable across the packages-isolation boundary.
const MIN_DAILY_BUDGET_KWH = 20;
const MAX_DAILY_BUDGET_KWH = 360;

/**
 * Turns tomorrow's expected mean temperature into an advisory daily budget.
 * Clamp ladder, in order:
 * 1. Never extrapolate below observed temperatures — evaluate at the coldest
 *    observed day and flag it (linear extrapolation is downward-biased
 *    exactly during cold snaps, when a too-tight budget hurts most).
 * 2. Add q80 residual headroom (right-skewed residuals: guests/laundry days
 *    inflate the upper tail; ~4 of 5 typical days fit inside the suggestion).
 * 3. Floor at the 5th percentile of observed days — never suggest below what
 *    the home has demonstrably used.
 * 4. Clamp to the daily-budget setting bounds and (when known) the capacity
 *    ceiling × 24 h — suggesting an unreachable number misleads.
 */
export type DailyBudgetSuggestionInput = {
  fit: EnergySignatureFit;
  forecastMeanTempC: number;
  /** Hard capacity cap (kW); the suggestion never exceeds cap × 24 h. */
  capacityLimitKw?: number;
};

export type DailyBudgetSuggestionResult = {
  predictedKwh: number;
  predictedLowKwh: number;
  predictedHighKwh: number;
  suggestedBudgetKwh: number;
  beyondObservedCold: boolean;
  beyondObservedWarm: boolean;
};

const MIN_RELATIVE_HEADROOM = 0.05;
const OBSERVED_RANGE_SLACK_C = 2;

export function suggestDailyBudgetKwh(input: DailyBudgetSuggestionInput): DailyBudgetSuggestionResult {
  const { fit, forecastMeanTempC, capacityLimitKw } = input;
  // Never extrapolate OUTSIDE the observed range in either direction: the
  // cold side underestimates exactly during cold snaps, and the warm side of
  // a winter-only linear fit descends without bound (negative predictions on
  // the first spring days). Evaluate at the nearest observed edge and flag.
  const beyondObservedCold = forecastMeanTempC < fit.observedTempMinC - OBSERVED_RANGE_SLACK_C;
  const beyondObservedWarm = forecastMeanTempC > fit.observedTempMaxC + OBSERVED_RANGE_SLACK_C;
  const evaluationTempC = Math.min(
    fit.observedTempMaxC,
    Math.max(fit.observedTempMinC, forecastMeanTempC),
  );
  const predictedKwh = predictDailyKwh(fit, evaluationTempC) ?? fit.medianDayKwh;

  const headroom = Math.max(fit.residualQ80, MIN_RELATIVE_HEADROOM * predictedKwh);
  const floored = Math.max(predictedKwh + headroom, fit.lowObservedDayKwh);
  const capacityCapKwh = capacityLimitKw !== undefined && capacityLimitKw > 0
    ? capacityLimitKw * 24
    : Number.POSITIVE_INFINITY;
  // The capacity ceiling is physical, so it outranks the setting's 20 kWh
  // minimum: with a sub-minimum hard cap the suggestion must stay under the
  // cap rather than be raised back to an impossible number.
  const suggestedBudgetKwh = Math.min(
    MAX_DAILY_BUDGET_KWH,
    capacityCapKwh,
    Math.max(MIN_DAILY_BUDGET_KWH, floored),
  );

  const predictedLowKwh = Math.max(0, predictedKwh + fit.residualQ10);
  return {
    predictedKwh,
    predictedLowKwh,
    predictedHighKwh: Math.max(predictedLowKwh, predictedKwh + fit.residualQ90),
    suggestedBudgetKwh,
    beyondObservedCold,
    beyondObservedWarm,
  };
}
