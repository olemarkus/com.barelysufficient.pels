import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';

/**
 * A rolled-up day's budget evidence as the `weather_day_rollup` log reports
 * it: the budget in force, the usage it counted, and the two denial signals.
 * Every field resolves absence to `null` rather than fabricating zero.
 *
 * Split out of `WeatherCollector.rollup` to keep that method under the
 * complexity cap and the collector under its size budget.
 */
export const budgetEvidenceLogFields = (record: WeatherDailyRecord | undefined): {
  appliedBudgetKwh: number | null;
  kwhBudgetCounted: number | null;
  budgetDeniedKwh: number | null;
  deadlineMissDeniedKwh: number | null;
} => ({
  appliedBudgetKwh: record?.appliedBudgetKwh ?? null,
  // Metered less budget-exempt: the axis the budget paced and the pressure loop measures.
  kwhBudgetCounted: record?.kwhBudgetCounted ?? null,
  // Cause-independent denied energy integrated across observed demand spans.
  budgetDeniedKwh: record?.suppression?.budgetDeniedKwh ?? null,
  // Denied energy attached to budget-bound smart-task deadline misses.
  deadlineMissDeniedKwh: record?.suppression?.deadlineMissDeniedKwh ?? null,
});
