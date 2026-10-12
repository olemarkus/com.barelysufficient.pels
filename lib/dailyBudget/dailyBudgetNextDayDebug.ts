import { buildPriceDebugData } from './dailyBudgetMath';
import type { DailyBudgetPlanInputs, RebuildPlanDebug } from './dailyBudgetManagerTypes';
import type { PriceData } from './dailyBudgetState';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

/** A preview plans the whole day, with no previous plan to lock against. */
export const NEXT_DAY_PLAN_DEBUG: RebuildPlanDebug = {
  lockCurrentBucket: false,
  shouldLockCurrent: false,
  remainingStartIndex: 0,
  hasPreviousPlan: false,
};

/**
 * The price block of tomorrow's `next_day` plan entry. The preview payload
 * carries neither the spread factor nor the effective flex share, and the spread
 * is taken on planning prices it does not carry, so both are derived from the
 * prices and price setting the preview was built on.
 */
export function buildNextDayPriceDebugData(
  preview: DailyBudgetDayPayload,
  settings: DailyBudgetSettings,
  inputs: DailyBudgetPlanInputs,
): PriceData {
  return buildPriceDebugData({
    bucketStartUtcMs: preview.buckets.startUtc.map((ts) => new Date(ts).getTime()),
    currentBucketIndex: preview.currentBucketIndex,
    combinedPrices: inputs.combinedPrices,
    priceOptimizationEnabled: inputs.priceOptimizationEnabled,
    priceShapingEnabled: settings.priceShapingEnabled,
    priceShapingFlexShare: settings.priceShapingFlexShare,
  });
}
