import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import {
  buildPlan,
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
  profileObservedMaxUncontrolledKWh?: number[];
  profileObservedMaxControlledKWh?: number[];
  profileObservedMinUncontrolledKWh?: number[];
  profileObservedMinControlledKWh?: number[];
};

const resolvePlannedBreakdown = (params: {
  enabled: boolean;
  buildResult: ReturnType<typeof buildPlan> | null;
  plannedKWh: number[];
  bucketStartUtcMs: number[];
  timeZone: string;
  profileBreakdown?: { uncontrolled: number[]; controlled: number[] };
}): ReturnType<typeof buildPlanBreakdown> | null => {
  const {
    enabled,
    buildResult,
    plannedKWh,
    bucketStartUtcMs,
    timeZone,
    profileBreakdown,
  } = params;
  if (!enabled) return null;
  const hasPlannedBreakdown = Array.isArray(buildResult?.plannedUncontrolledKWh)
    && Array.isArray(buildResult?.plannedControlledKWh)
    && buildResult.plannedUncontrolledKWh.length === plannedKWh.length
    && buildResult.plannedControlledKWh.length === plannedKWh.length;
  if (hasPlannedBreakdown) {
    return {
      plannedUncontrolledKWh: buildResult.plannedUncontrolledKWh,
      plannedControlledKWh: buildResult.plannedControlledKWh,
    };
  }
  return buildPlanBreakdown({
    bucketStartUtcMs,
    timeZone,
    plannedKWh,
    breakdown: profileBreakdown,
  });
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
    profileObservedMaxUncontrolledKWh,
    profileObservedMaxControlledKWh,
    profileObservedMinUncontrolledKWh,
    profileObservedMinControlledKWh,
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

  let buildResult: ReturnType<typeof buildPlan> | null = null;
  if (enabled) {
    buildResult = buildPlan({
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
      controlledUsageWeight: settings.controlledUsageWeight,
      profileObservedMaxUncontrolledKWh,
      profileObservedMaxControlledKWh,
      profileObservedMinUncontrolledKWh,
      profileObservedMinControlledKWh,
    });
  }
  const plannedKWh = buildResult?.plannedKWh ?? bucketStartUtcMs.map(() => 0);
  const breakdown = resolvePlannedBreakdown({
    enabled,
    buildResult,
    plannedKWh,
    bucketStartUtcMs,
    timeZone,
    profileBreakdown,
  });

  const budget = computeBudgetState({
    context,
    enabled,
    dailyBudgetKWh: settings.dailyBudgetKWh,
    plannedKWh,
    profileSampleCount,
    profileSplitSampleCount,
  });

  const priceData = enabled && buildResult
    ? {
      prices: buildResult.price,
      priceFactors: buildResult.priceFactor,
      priceShapingActive: buildResult.priceShapingActive,
      priceSpreadFactor: buildResult.priceSpreadFactor,
      effectivePriceShapingFlexShare: buildResult.effectivePriceShapingFlexShare,
    }
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
