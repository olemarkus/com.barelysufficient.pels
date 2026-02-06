import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import {
  buildPlan,
  buildPriceDebugData,
} from './dailyBudgetMath';
import { buildPlanBreakdown } from './dailyBudgetBreakdown';
import type { CombinedPriceData } from './dailyBudgetMath';
import {
  buildDailyBudgetSnapshot,
  computeBudgetState,
} from './dailyBudgetState';
import type { DayContext } from './dailyBudgetState';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

type BuildDailyBudgetPreviewParams = {
  dayStartUtcMs: number;
  timeZone: string;
  settings: DailyBudgetSettings;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
  capacityBudgetKWh?: number;
  enabled: boolean;
  profileWeights: number[];
  profileSampleCount: number;
  profileSplitSampleCount?: number;
  profileBreakdown?: { uncontrolled: number[]; controlled: number[] };
};

export const buildDailyBudgetPreview = (params: BuildDailyBudgetPreviewParams): DailyBudgetDayPayload => {
  const {
    dayStartUtcMs,
    timeZone,
    settings,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
    capacityBudgetKWh,
    enabled,
    profileWeights,
    profileSampleCount,
    profileSplitSampleCount,
    profileBreakdown,
  } = params;

  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const bucketUsage = bucketStartUtcMs.map(() => 0);
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const currentBucketIndex = -1;
  const usedNowKWh = 0;
  const context: DayContext = {
    nowMs: dayStartUtcMs,
    timeZone,
    dateKey: getDateKeyInTimeZone(new Date(dayStartUtcMs), timeZone),
    dayStartUtcMs,
    bucketStartUtcMs,
    bucketStartLocalLabels,
    bucketKeys,
    currentBucketIndex,
    currentBucketProgress: 0,
    bucketUsage,
    bucketUsageControlled: undefined,
    bucketUsageUncontrolled: undefined,
    usedNowKWh,
    currentBucketUsage: 0,
  };

  const plannedKWh = enabled
    ? buildPlan({
      bucketStartUtcMs,
      bucketUsage,
      currentBucketIndex,
      usedNowKWh,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      profileWeights,
      profileWeightsControlled: profileBreakdown?.controlled,
      profileWeightsUncontrolled: profileBreakdown?.uncontrolled,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled,
      priceShapingEnabled,
      priceShapingFlexShare: settings.priceShapingFlexShare,
      capacityBudgetKWh,
    }).plannedKWh
    : bucketStartUtcMs.map(() => 0);
  const breakdown = enabled
    ? buildPlanBreakdown({
      bucketStartUtcMs,
      timeZone,
      plannedKWh,
      breakdown: profileBreakdown,
    })
    : null;

  const budget = computeBudgetState({
    context,
    enabled,
    dailyBudgetKWh: settings.dailyBudgetKWh,
    plannedKWh,
    profileSampleCount,
    profileSplitSampleCount,
  });

  const priceData = enabled
    ? buildPriceDebugData({
      bucketStartUtcMs,
      currentBucketIndex,
      combinedPrices,
      priceOptimizationEnabled,
      priceShapingEnabled,
    })
    : { priceShapingActive: false };

  return buildDailyBudgetSnapshot({
    context,
    settings,
    enabled,
    plannedKWh,
    plannedUncontrolledKWh: breakdown?.plannedUncontrolledKWh,
    plannedControlledKWh: breakdown?.plannedControlledKWh,
    priceData,
    budget,
    frozen: false,
  });
};
