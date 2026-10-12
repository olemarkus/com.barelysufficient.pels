import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getNextLocalDayStartUtcMs,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { buildPlan } from './dailyBudgetMath';
import type { DailyBudgetPlanInputs } from './dailyBudgetManagerTypes';
import { resolvePlanBounds, type PlanBounds } from './dailyBudgetPlanCore';
import { buildPriceData, NO_PRICE_DATA, type PriceData } from './dailyBudgetPrices';
import { getEffectiveProfileData, getProfileSplitSampleCount } from './dailyBudgetProfile';
import {
  buildDailyBudgetSnapshot,
  computeBudgetState,
  isDailyBudgetEnabled,
  type DayContext,
} from './dailyBudgetState';
import type { DailyBudgetDayPayload, DailyBudgetSettings, DailyBudgetState } from './dailyBudgetTypes';
import { resolveObservedHourlyStats } from './observedHourlyStats';

/** A day's plan before any of it has elapsed, and the inputs it was built on. */
export type DailyBudgetPreview = {
  snapshot: DailyBudgetDayPayload;
  priceData: PriceData;
  bounds: PlanBounds;
};

/** The context of a local day that has not started: no usage, no current bucket. */
export const buildPreviewDayContext = (dayStartUtcMs: number, timeZone: string): DayContext => {
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const bucketUsage = bucketStartUtcMs.map(() => 0);
  return {
    nowMs: dayStartUtcMs,
    timeZone,
    dateKey: getDateKeyInTimeZone(new Date(dayStartUtcMs), timeZone),
    dayStartUtcMs,
    bucketStartUtcMs,
    bucketStartLocalLabels,
    bucketKeys: bucketStartUtcMs.map((ts) => new Date(ts).toISOString()),
    currentBucketIndex: -1,
    currentBucketProgress: 0,
    bucketUsage,
    budgetControlBucketUsage: bucketUsage,
    bucketUsageControlled: bucketStartUtcMs.map(() => null),
    bucketUsageUncontrolled: bucketStartUtcMs.map(() => null),
    bucketUsageExempt: undefined,
    usedNowKWh: 0,
    budgetControlUsedNowKWh: 0,
    meteredUsedNowKWh: 0,
    exemptUsedNowKWh: 0,
    currentBucketUsage: 0,
  };
};

export const buildDailyBudgetPreview = (
  state: DailyBudgetState,
  settings: DailyBudgetSettings,
  day: DayContext,
  inputs: DailyBudgetPlanInputs,
  defaultProfile: number[],
): DailyBudgetPreview => {
  const { combinedPrices, priceOptimizationEnabled, planningCeiling } = inputs;
  const enabled = isDailyBudgetEnabled(settings);
  const profile = getEffectiveProfileData(state, settings, defaultProfile);
  const priceData = enabled ? buildPriceData(day, settings, combinedPrices, priceOptimizationEnabled) : NO_PRICE_DATA;
  const plan = enabled
    ? buildPlan(day, settings, profile, resolveObservedHourlyStats(state), null, priceData, planningCeiling)
    : null;
  const plannedKWh = plan?.plannedKWh ?? day.bucketStartUtcMs.map(() => 0);
  const snapshot = buildDailyBudgetSnapshot({
    context: day,
    settings,
    enabled,
    plannedKWh,
    plannedGrossUncontrolledKWh: plan?.plannedGrossUncontrolledKWh,
    // Off, the day plans nothing, so there is no load to split.
    plannedUncontrolledKWh: plan?.plannedUncontrolledKWh ?? plannedKWh.slice(),
    plannedControlledKWh: plan?.plannedControlledKWh ?? plannedKWh.map(() => 0),
    priceData,
    budget: computeBudgetState(
      day,
      enabled,
      settings.dailyBudgetKWh,
      plannedKWh,
      profile.sampleCount,
      getProfileSplitSampleCount(state),
    ),
    frozen: false,
    planningCeiling,
  });
  return { snapshot, priceData, bounds: plan?.bounds ?? resolvePlanBounds(day, null) };
};
