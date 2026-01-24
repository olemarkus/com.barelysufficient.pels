import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import { buildPriceDebugData, sumArray, type CombinedPriceData } from './dailyBudgetMath';
import {
  buildBucketUsage,
  buildDailyBudgetSnapshot,
  computeBudgetState,
  type DayContext,
} from './dailyBudgetState';
import type { DailyBudgetDayPayload } from './dailyBudgetTypes';

export const buildDailyBudgetHistory = (params: {
  dayStartUtcMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
  profileSampleCount: number;
}): DailyBudgetDayPayload | null => {
  const {
    dayStartUtcMs,
    timeZone,
    powerTracker,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
    profileSampleCount,
  } = params;

  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const { bucketKeys, bucketUsage } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
  const plannedKWh = bucketKeys.map((key) => powerTracker.dailyBudgetCaps?.[key] ?? 0);
  const hasPlanned = plannedKWh.some((value) => value > 0);
  const hasUsage = bucketUsage.some((value) => value > 0);
  if (!hasPlanned && !hasUsage) return null;
  const dailyBudgetKWh = sumArray(plannedKWh);
  const usedNowKWh = sumArray(bucketUsage);
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
    usedNowKWh,
    currentBucketUsage: bucketUsage[currentBucketIndex] ?? 0,
  };

  const budget = computeBudgetState({
    context,
    enabled,
    dailyBudgetKWh,
    plannedKWh,
    profileSampleCount,
  });

  const priceData = buildPriceDebugData({
    bucketStartUtcMs,
    currentBucketIndex: context.currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  });

  return buildDailyBudgetSnapshot({
    context,
    settings: { enabled, dailyBudgetKWh, priceShapingEnabled },
    enabled,
    plannedKWh,
    priceData,
    budget,
    frozen: false,
  });
};
