import { EnergyAccounting } from '../power/energyAccounting';
import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../power/tracker';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getNextLocalDayStartUtcMs,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { sumArray, type CombinedPriceData } from './dailyBudgetMath';
import { buildPriceData } from './dailyBudgetPrices';
import {
  buildDailyBudgetSnapshot,
  computeBudgetState,
  resolvePlannedSplit,
  type DayContext,
} from './dailyBudgetState';
import { buildPlanBreakdown } from './dailyBudgetBreakdown';
import type { DailyBudgetDayPayload } from './dailyBudgetTypes';
import { CONTROLLED_USAGE_WEIGHT, PRICE_SHAPING_FLEX_SHARE } from './dailyBudgetConstants';

export const buildDailyBudgetHistory = (params: {
  dayStartUtcMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
  /**
   * The budget this day ran with (`DailyBudgetState.closedDayBudget`), or null
   * when none was recorded for it: the day ran without a daily budget, or closed
   * before this was kept. Null reports the day with no budget, never a guess.
   */
  closedDayBudgetKWh: number | null;
  combinedPrices: CombinedPriceData | null;
  priceShapingEnabled: boolean;
  profileSampleCount: number;
  profileBreakdown?: { uncontrolled: number[]; controlled: number[] } | null;
  /** The planning ceiling as the limits stand now; a closed day reports no allocation pressure. */
  planningCeiling: PowerLimitCeiling | null;
}): DailyBudgetDayPayload | null => {
  const {
    dayStartUtcMs,
    timeZone,
    powerTracker,
    closedDayBudgetKWh,
    combinedPrices,
    priceShapingEnabled,
    profileSampleCount,
    profileBreakdown,
    planningCeiling,
  } = params;

  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const usage = new EnergyAccounting(powerTracker).window(bucketStartUtcMs);
  const {
    bucketKeys,
    bucketUsage,
    bucketUsageControlled,
    bucketUsageUncontrolled,
    bucketUsageExempt,
  } = usage;
  // Each hour's cap is its share of the budget as that hour closed. On a day that
  // runs under budget, the unused share is offered again to later hours, so the
  // caps sum to more than the budget. They give the day's shape, scaled to the
  // budget the day ran with.
  const hourCapsKWh = bucketKeys.map((key) => powerTracker.dailyBudgetCaps?.[key] ?? 0);
  const hasPlanned = hourCapsKWh.some((value) => value > 0);
  const hasUsage = bucketUsage.some((value) => value > 0);
  if (!hasPlanned && !hasUsage) return null;
  const dailyBudgetKWh = closedDayBudgetKWh ?? 0;
  const capsTotalKWh = sumArray(hourCapsKWh);
  const plannedKWh = dailyBudgetKWh > 0 && capsTotalKWh > 0
    ? hourCapsKWh.map((value) => value * (dailyBudgetKWh / capsTotalKWh))
    : hourCapsKWh;
  const {
    budgetControlBucketUsage,
    budgetControlUsedNowKWh,
    meteredUsedNowKWh,
    exemptUsedNowKWh,
    usedNowKWh,
  } = usage;
  const enabled = dailyBudgetKWh > 0;

  const currentBucketIndex = bucketStartUtcMs.length;
  const context: DayContext = {
    nowMs: nextDayStartUtcMs - 1,
    timeZone,
    dateKey: getDateKeyInTimeZone(new Date(dayStartUtcMs), timeZone),
    dayStartUtcMs,
    bucketStartUtcMs,
    bucketStartLocalLabels,
    bucketKeys,
    currentBucketIndex,
    currentBucketProgress: 1,
    bucketUsage,
    budgetControlBucketUsage,
    bucketUsageControlled,
    bucketUsageUncontrolled,
    bucketUsageExempt,
    usedNowKWh,
    budgetControlUsedNowKWh,
    meteredUsedNowKWh,
    exemptUsedNowKWh,
  };

  const budget = computeBudgetState(context, enabled, dailyBudgetKWh, plannedKWh, profileSampleCount);

  const settings = {
    enabled,
    dailyBudgetKWh,
    priceShapingEnabled,
    controlledUsageWeight: CONTROLLED_USAGE_WEIGHT,
    priceShapingFlexShare: PRICE_SHAPING_FLEX_SHARE,
  };
  // A closed day has no hours left to shape: it carries its prices only.
  const priceData = buildPriceData(context, settings, combinedPrices, false);

  const planBreakdown = buildPlanBreakdown({
    bucketStartUtcMs,
    timeZone,
    plannedKWh,
    breakdown: profileBreakdown ?? undefined,
  });

  return buildDailyBudgetSnapshot({
    context,
    settings,
    enabled,
    plannedKWh,
    ...resolvePlannedSplit(plannedKWh, planBreakdown),
    priceData,
    budget,
    frozen: false,
    planningCeiling,
  });
};
