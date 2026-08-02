import type { BudgetPressureState, EnergySignatureFit } from '../../../contracts/src/weatherAdvisorTypes';
import { predictDailyKwh } from './energySignature';
import { PRESSURE_CEILING_FRACTION, resolveBudgetPressureKwh } from './budgetPressure';

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
 *    inflate the upper tail; ~4 of 5 typical days fit inside the suggestion),
 *    leaning to q90 when the daily budget has recently been limiting.
 * 3. Add the budget-pressure term — the integral half of the loop, which keeps
 *    escalating while the budget is demonstrably holding devices back. See
 *    `budgetPressure.ts` for why the model alone cannot be trusted here.
 * 4. Floor at the 5th percentile of observed days — never suggest below what the
 *    home has demonstrably used.
 * 5. Clamp to the daily-budget setting bounds and (when known) the capacity
 *    ceiling × 24 h — suggesting an unreachable number misleads.
 */
export type DailyBudgetSuggestionInput = {
  fit: EnergySignatureFit;
  forecastMeanTempC: number;
  /** Hard capacity cap (kW); the suggestion never exceeds cap × 24 h. */
  capacityLimitKw?: number;
  /** Accumulated budget-pressure term; absent when the loop has nothing to add. */
  budgetPressure?: BudgetPressureState;
};

export type DailyBudgetSuggestionResult = {
  predictedKwh: number;
  predictedLowKwh: number;
  predictedHighKwh: number;
  suggestedBudgetKwh: number;
  beyondObservedCold: boolean;
  beyondObservedWarm: boolean;
  /** The daily budget has recently been limiting — headroom leaned q80→q90. */
  budgetMayBeLimiting: boolean;
  /** kWh the budget-pressure loop contributed, after its ceiling. 0 when idle. */
  budgetPressureKwh: number;
};

const MIN_RELATIVE_HEADROOM = 0.05;
const OBSERVED_RANGE_SLACK_C = 2;

export function suggestDailyBudgetKwh(input: DailyBudgetSuggestionInput): DailyBudgetSuggestionResult {
  const { fit, forecastMeanTempC, capacityLimitKw, budgetPressure } = input;
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

  // Raise-lean: when the daily budget has recently been limiting the home, the
  // measured days it was limiting are censored lower bounds on demand, so the
  // fit reads low. Widen the headroom q80→q90 so a held-back home is nudged UP,
  // never lower — the suggestion may only ever over-cover here, so a rough
  // detection threshold is safe.
  //
  // This used to also require a forecast below the heating knee. That made the
  // correction dead above the knee, which is exactly where the base load is an
  // extrapolated value rather than an observed one, and where a mild-weather
  // home can be throttled all day without a single cold hour to trigger it.
  const budgetMayBeLimiting = fit.recentSuppressionSuspected;
  const headroomQuantile = budgetMayBeLimiting ? fit.residualQ90 : fit.residualQ80;
  const headroom = Math.max(headroomQuantile, MIN_RELATIVE_HEADROOM * predictedKwh);
  // Integral term on top of that proportional one. It is measured against the
  // budget that was actually applied — which already carried the headroom — so
  // the two compose rather than double-count.
  const pressureKwh = resolveBudgetPressureKwh({
    state: budgetPressure,
    predictedKwh,
    ceilingFraction: PRESSURE_CEILING_FRACTION,
  });
  const capacityCapKwh = capacityLimitKw !== undefined && capacityLimitKw > 0
    ? capacityLimitKw * 24
    : Number.POSITIVE_INFINITY;
  const clamp = (modelledKwh: number): number => Math.min(
    MAX_DAILY_BUDGET_KWH,
    capacityCapKwh,
    // The capacity ceiling is physical, so it outranks the setting's 20 kWh
    // minimum: with a sub-minimum hard cap the suggestion must stay under the
    // cap rather than be raised back to an impossible number.
    Math.max(MIN_DAILY_BUDGET_KWH, modelledKwh),
  );
  const floorKwh = fit.lowObservedDayKwh;
  const suggestedBudgetKwh = clamp(Math.max(predictedKwh + headroom + pressureKwh, floorKwh));
  // Report what the term actually CONTRIBUTED, not what it had accumulated: a
  // floor or the hard cap can absorb some or all of it, and the reason line
  // names this number to the owner ("so N kWh was added"). Claiming a raise the
  // suggestion did not receive would be a lie in the one place they check.
  const budgetPressureKwh = Math.max(0, suggestedBudgetKwh - clamp(Math.max(predictedKwh + headroom, floorKwh)));

  const predictedLowKwh = Math.max(0, predictedKwh + fit.residualQ10);
  return {
    predictedKwh,
    predictedLowKwh,
    predictedHighKwh: Math.max(predictedLowKwh, predictedKwh + fit.residualQ90),
    suggestedBudgetKwh,
    beyondObservedCold,
    beyondObservedWarm,
    budgetMayBeLimiting,
    budgetPressureKwh,
  };
}
