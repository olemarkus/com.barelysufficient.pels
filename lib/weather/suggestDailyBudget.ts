import type { BudgetPressureState, EnergySignatureFit } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  predictDailyKwh, resolveResidualHeadroom,
} from '../../packages/shared-domain/src/energySignature/energySignature';
import { resolveBudgetPressureKwh } from '../../packages/shared-domain/src/energySignature/budgetPressure';

// Mirrors lib/dailyBudget/dailyBudgetConstants.ts and packages/contracts/src/
// dailyBudgetConstants.ts (all copies must stay in sync). The contracts package
// is types-only at runtime, so this backend weather owner keeps the values.
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
 *    retaining a wider recent-fortnight quantile when household usage changes,
 *    and leaning to q90 only for unresolved budget-attributed shortfall.
 * 3. Add the budget-pressure term — the integral half of the loop, which keeps
 *    correcting measured overshoot or unresolved budget-attributed shortfall. See
 *    `budgetPressure.ts` for recovery and unused-allowance accounting.
 * 4. Floor at the 5th percentile of observed days — never suggest below what the
 *    home has demonstrably used.
 * 5. Clamp to the daily-budget setting bounds and (when known) the capacity
 *    sustainable-capacity ceiling × the target local day's 23/24/25 hours.
 */
export type DailyBudgetSuggestionInput = {
  fit: EnergySignatureFit;
  /** Local date the suggestion is for; the fit's season term is evaluated on it. */
  targetDateKey: string;
  forecastMeanTempC: number;
  /** Sustainable capacity rate (hard cap minus margin), in kW. */
  capacityLimitKw?: number;
  /** Length of the target local day; 23/24/25 across DST. */
  capacityDayHours?: number;
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
  const {
    fit, targetDateKey, forecastMeanTempC, capacityLimitKw, capacityDayHours = 24, budgetPressure,
  } = input;
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
  const predictedKwh = predictDailyKwh(fit, evaluationTempC, targetDateKey) ?? fit.medianDayKwh;

  // Keep annual uncertainty, but widen for measured recent demand. Only proven
  // unresolved budget shortfall enables q90; routine shifting does not.
  const budgetMayBeLimiting = fit.recentSuppressionSuspected;
  const residualHeadroom = resolveResidualHeadroom(fit);
  const headroomQuantile = budgetMayBeLimiting ? residualHeadroom.q90 : residualHeadroom.q80;
  const headroom = Math.max(headroomQuantile, MIN_RELATIVE_HEADROOM * predictedKwh);
  // Integral term on top of that proportional one. It is measured against the
  // budget that was actually applied — which already carried the headroom — so
  // the two compose rather than double-count.
  const pressureKwh = resolveBudgetPressureKwh({ state: budgetPressure });
  const capacityCapKwh = capacityLimitKw !== undefined && capacityLimitKw > 0
    ? capacityLimitKw * capacityDayHours
    : Number.POSITIVE_INFINITY;
  const clamp = (modelledKwh: number): number => Math.min(
    MAX_DAILY_BUDGET_KWH,
    capacityCapKwh,
    // The capacity ceiling is physical, so it outranks the setting's 20 kWh
    // minimum: with a sub-minimum capacity ceiling the suggestion stays under the
    // cap rather than be raised back to an impossible number.
    Math.max(MIN_DAILY_BUDGET_KWH, modelledKwh),
  );
  const floorKwh = fit.lowObservedDayKwh;
  const suggestedBudgetKwh = clamp(Math.max(predictedKwh + headroom + pressureKwh, floorKwh));
  // Report what the term actually CONTRIBUTED, not what it had accumulated: a
  // floor or the physical capacity ceiling can absorb some or all of it, and the reason line
  // names this number to the owner ("so N kWh was added"). Claiming a raise the
  // suggestion did not receive would be a lie in the one place they check.
  const budgetPressureKwh = Math.max(0, suggestedBudgetKwh - clamp(Math.max(predictedKwh + headroom, floorKwh)));

  const predictedLowKwh = Math.max(0, predictedKwh + fit.residualQ10);
  return {
    predictedKwh,
    predictedLowKwh,
    predictedHighKwh: Math.max(
      predictedLowKwh, predictedKwh + residualHeadroom.q90,
    ),
    suggestedBudgetKwh,
    beyondObservedCold,
    beyondObservedWarm,
    budgetMayBeLimiting,
    budgetPressureKwh,
  };
}
