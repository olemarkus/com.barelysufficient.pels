import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import {
  NEW_PLAN_BLEND_WEIGHT,
  PREVIOUS_PLAN_BLEND_WEIGHT,
} from './dailyBudgetConstants';
import {
  allocateBudgetWithPriceTargets,
  normalizeWeights,
} from './dailyBudgetAllocation';
import {
  buildControlledMinFloors,
  resolveRemainingCaps,
  resolveRemainingFloors,
  type UncontrolledReservePlanDiagnostics,
} from './dailyBudgetPlanCaps';
import { buildPlanWeights, resolveSplitShares } from './dailyBudgetPlanWeights';
import { buildPlannedSplit } from './dailyBudgetPlanSplit';
import type { PriceData } from './dailyBudgetPrices';
import type { EffectiveProfileData } from './dailyBudgetProfile';
import type { DayContext } from './dailyBudgetState';
import type { DailyBudgetSettings, DailyBudgetState } from './dailyBudgetTypes';
import type { ObservedHourlyStats } from './observedHourlyStats';

/**
 * The plan already in force for the day: a rebuild keeps it for elapsed hours,
 * blends the remaining hours toward it, and keeps the hour in progress when the
 * plan was built in that hour.
 */
export type StoredPlan = Pick<
  DailyBudgetState,
  'plannedUncontrolledKWh' | 'plannedGrossUncontrolledKWh' | 'plannedControlledKWh' | 'lastPlanBucketStartUtcMs'
> & { plannedKWh: number[] };

/** Where a rebuild's fixed part of the day ends and the re-spread part begins. */
export type PlanBounds = {
  /** The stored plan was built in the hour in progress. */
  lockCurrentBucket: boolean;
  /** A stored plan of this day's shape exists. */
  hasPreviousPlan: boolean;
  /** The hour in progress keeps the stored plan's allocation. */
  shouldLockCurrent: boolean;
  /** The first bucket the remaining budget is spread over. */
  remainingStartIndex: number;
};

export type BuildPlanResult = {
  plannedKWh: number[];
  plannedUncontrolledKWh: number[];
  plannedGrossUncontrolledKWh: number[];
  plannedControlledKWh: number[];
  bounds: PlanBounds;
  uncontrolledReserveDiagnostics: UncontrolledReservePlanDiagnostics;
};

// A day that has not started (index -1) plans from its first bucket.
const planCurrentIndex = (context: DayContext): number => Math.max(0, context.currentBucketIndex);

export function buildPlan(
  context: DayContext,
  settings: DailyBudgetSettings,
  profile: EffectiveProfileData,
  observedStats: ObservedHourlyStats,
  previous: StoredPlan | null,
  priceData: PriceData,
  planningCeiling: PowerLimitCeiling | null,
): BuildPlanResult {
  const bounds = resolvePlanBounds(context, previous);
  const currentBucketIndex = planCurrentIndex(context);
  const usedInCurrent = context.budgetControlBucketUsage[currentBucketIndex] ?? 0;
  const previousPlannedKWh = bounds.hasPreviousPlan ? previous?.plannedKWh : undefined;
  const planWeights = buildPlanWeights(context, profile);
  const splitShares = resolveSplitShares(planWeights);
  const remainingFloors = resolveRemainingFloors(
    context,
    settings.controlledUsageWeight,
    observedStats,
    usedInCurrent,
    bounds.remainingStartIndex,
    currentBucketIndex,
  );
  const remainingAllocations = resolveRemainingAllocations(
    resolveRemainingWeights(planWeights.combined, bounds.remainingStartIndex, previousPlannedKWh),
    resolveRemainingBudgetForFuture(context, settings.dailyBudgetKWh, bounds, previousPlannedKWh),
    resolveRemainingCaps(
      context,
      observedStats,
      planningCeiling,
      usedInCurrent,
      bounds.remainingStartIndex,
      currentBucketIndex,
    ),
    remainingFloors.floors,
    // Allocation is a planning surface: spread the remaining budget over the
    // planning price (`budgetPrice ?? total`), not the money series the payload
    // publishes as `buckets.price`. Identical when no entry carries a budgetPrice.
    priceData.planningPrices?.slice(bounds.remainingStartIndex),
    priceData.effectivePriceShapingFlexShare,
  );
  const plannedKWh = buildPlannedKWh(
    context,
    settings.dailyBudgetKWh,
    bounds,
    normalizeWeightsWithFallback(planWeights.combined),
    previousPlannedKWh,
    remainingAllocations,
  );
  const plannedSplit = buildPlannedSplit({
    plannedKWh,
    splitShares,
    controlledMinFloors: buildControlledMinFloors(
      context,
      observedStats.profileObservedMinControlledKWh,
      bounds.remainingStartIndex,
    ),
    uncontrolledReserveFloors: remainingFloors.uncontrolledReserves,
    previousPlannedUncontrolledKWh: previous?.plannedUncontrolledKWh,
    previousPlannedControlledKWh: previous?.plannedControlledKWh,
    currentBucketIndex,
    shouldLockCurrent: bounds.shouldLockCurrent,
  });

  return {
    plannedKWh,
    plannedUncontrolledKWh: plannedSplit.map((entry) => entry.plannedUncontrolled),
    plannedGrossUncontrolledKWh: buildPlannedGrossUncontrolledKWh(
      plannedSplit,
      remainingFloors.grossUncontrolledReserves,
      remainingFloors.grossUncontrolledReserveHasData,
      previous?.plannedGrossUncontrolledKWh,
      currentBucketIndex,
      bounds.shouldLockCurrent,
    ),
    plannedControlledKWh: plannedSplit.map((entry) => entry.plannedControlled),
    bounds,
    uncontrolledReserveDiagnostics: remainingFloors.diagnostics,
  };
}

export const resolvePlanBounds = (context: DayContext, previous: StoredPlan | null): PlanBounds => {
  const bucketCount = context.bucketStartUtcMs.length;
  const currentBucketIndex = planCurrentIndex(context);
  const lockCurrentBucket = previous !== null
    && previous.lastPlanBucketStartUtcMs === context.bucketStartUtcMs[context.currentBucketIndex];
  const hasPreviousPlan = previous !== null && previous.plannedKWh.length === bucketCount;
  const shouldLockCurrent = lockCurrentBucket && hasPreviousPlan;
  return {
    lockCurrentBucket,
    hasPreviousPlan,
    shouldLockCurrent,
    remainingStartIndex: shouldLockCurrent
      ? Math.min(currentBucketIndex + 1, bucketCount)
      : currentBucketIndex,
  };
};

function normalizeWeightsWithFallback(weights: number[]): number[] {
  let normalized = normalizeWeights(weights);
  if (normalized.every((value) => value === 0)) {
    normalized = normalizeWeights(weights.map(() => 1));
  }
  return normalized;
}

function buildPlannedGrossUncontrolledKWh(
  plannedSplit: Array<{ plannedUncontrolled: number; plannedControlled: number }>,
  grossUncontrolledReserveFloors: number[],
  grossUncontrolledReserveHasData: boolean[],
  previousPlannedGrossUncontrolledKWh: number[] | undefined,
  currentBucketIndex: number,
  shouldLockCurrent: boolean,
): number[] {
  const hasPreviousGross = Array.isArray(previousPlannedGrossUncontrolledKWh)
    && previousPlannedGrossUncontrolledKWh.length === plannedSplit.length;

  return plannedSplit.map((entry, index) => {
    const shouldPreservePrevious = hasPreviousGross
      && (index < currentBucketIndex || (shouldLockCurrent && index === currentBucketIndex));
    const previousGross = shouldPreservePrevious ? previousPlannedGrossUncontrolledKWh?.[index] : undefined;
    const grossReserve = Number.isFinite(previousGross)
      ? previousGross as number
      : (grossUncontrolledReserveFloors[index] ?? 0);
    return Number.isFinite(previousGross) || grossUncontrolledReserveHasData[index] === true
      ? Math.max(0, grossReserve)
      : Math.max(0, entry.plannedUncontrolled);
  });
}

function resolveRemainingWeights(
  baseWeights: number[],
  remainingStartIndex: number,
  previousPlannedKWh: number[] | undefined,
): number[] {
  const remainingWeightsRaw = baseWeights.slice(remainingStartIndex);
  let normalizedRemaining = normalizeWeightsWithFallback(remainingWeightsRaw);
  if (previousPlannedKWh?.length) {
    const previousRemaining = previousPlannedKWh.slice(remainingStartIndex);
    const previousWeights = normalizeWeights(previousRemaining);
    const blended = normalizedRemaining.map((value, index) => (
      previousWeights[index] !== undefined
        ? previousWeights[index] * PREVIOUS_PLAN_BLEND_WEIGHT + value * NEW_PLAN_BLEND_WEIGHT
        : value
    ));
    normalizedRemaining = normalizeWeights(blended);
  }
  return normalizedRemaining;
}

function resolveRemainingBudgetForFuture(
  context: DayContext,
  dailyBudgetKWh: number,
  bounds: PlanBounds,
  previousPlannedKWh: number[] | undefined,
): number {
  const remainingBudget = Math.max(0, dailyBudgetKWh - context.budgetControlUsedNowKWh);
  if (!bounds.shouldLockCurrent || !previousPlannedKWh?.length) return remainingBudget;
  const currentBucketIndex = planCurrentIndex(context);
  const previousCurrent = previousPlannedKWh[currentBucketIndex];
  const plannedCurrent = isFiniteNumber(previousCurrent) ? previousCurrent : 0;
  const usedInCurrent = context.budgetControlBucketUsage[currentBucketIndex] ?? 0;
  const reservedCurrent = Math.max(0, plannedCurrent - usedInCurrent);
  return Math.max(0, remainingBudget - reservedCurrent);
}

function resolveRemainingAllocations(
  weights: number[],
  remainingBudgetKWh: number,
  caps: number[],
  floors: number[],
  prices: Array<number | null> | undefined,
  priceFlexShare: number,
): number[] {
  if (weights.length === 0 || remainingBudgetKWh <= 0) return weights.map(() => 0);
  return allocateBudgetWithPriceTargets(weights, remainingBudgetKWh, caps, floors, prices, priceFlexShare);
}

function buildPlannedKWh(
  context: DayContext,
  dailyBudgetKWh: number,
  bounds: PlanBounds,
  normalizedDayWeights: number[],
  previousPlannedKWh: number[] | undefined,
  remainingAllocations: number[],
): number[] {
  const bucketUsage = context.budgetControlBucketUsage;
  const currentBucketIndex = planCurrentIndex(context);
  return Array.from({ length: context.bucketStartUtcMs.length }, (_, index) => {
    if (index < currentBucketIndex) {
      if (previousPlannedKWh?.length) {
        const previousValue = previousPlannedKWh[index];
        return isFiniteNumber(previousValue) ? previousValue : bucketUsage[index] ?? 0;
      }
      const fallbackWeight = normalizedDayWeights[index] ?? 0;
      return dailyBudgetKWh * fallbackWeight;
    }
    if (index === currentBucketIndex) {
      const usedInCurrent = bucketUsage[index] ?? 0;
      if (bounds.shouldLockCurrent && previousPlannedKWh?.length) {
        const previousValue = previousPlannedKWh[index];
        return isFiniteNumber(previousValue) ? previousValue : usedInCurrent;
      }
      const allocation = remainingAllocations[0] ?? 0;
      return usedInCurrent + allocation;
    }
    const allocation = remainingAllocations[index - bounds.remainingStartIndex] ?? 0;
    return allocation;
  });
}
