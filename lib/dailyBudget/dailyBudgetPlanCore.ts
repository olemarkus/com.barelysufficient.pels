import { clamp } from '../utils/mathUtils';
import {
  NEW_PLAN_BLEND_WEIGHT,
  PREVIOUS_PLAN_BLEND_WEIGHT,
  PRICE_SHAPING_FLEX_SHARE,
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
import type { CombinedPriceData } from './dailyBudgetPrices';
import { buildPriceFactors } from './dailyBudgetPrices';

type SplitShares = ReturnType<typeof resolveSplitShares>;

type PlanBounds = {
  safeCurrentBucketIndex: number;
  hasPreviousPlan: boolean;
  shouldLockCurrent: boolean;
  remainingStartIndex: number;
};

type BuildPlanParams = {
  bucketStartUtcMs: number[];
  bucketUsage: number[];
  currentBucketIndex: number;
  usedNowKWh: number;
  dailyBudgetKWh: number;
  profileWeights: number[];
  profileWeightsControlled?: number[];
  profileWeightsUncontrolled?: number[];
  timeZone: string;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
  priceShapingFlexShare?: number;
  previousPlannedKWh?: number[];
  previousPlannedUncontrolledKWh?: number[];
  previousPlannedControlledKWh?: number[];
  capacityBudgetKWh?: number;
  lockCurrentBucket?: boolean;
  controlledUsageWeight?: number;
  profileObservedMaxUncontrolledKWh?: number[];
  profileObservedMaxControlledKWh?: number[];
  profileObservedMinUncontrolledKWh?: number[];
  profileObservedMinControlledKWh?: number[];
  profileObservedP50UncontrolledKWh?: number[];
  profileObservedP75UncontrolledKWh?: number[];
  profileObservedP90UncontrolledKWh?: number[];
  profileObservedUncontrolledSampleCounts?: number[];
  observedPeakMarginRatio?: number;
};

type BuildPlanResult = {
  plannedKWh: number[];
  plannedUncontrolledKWh: number[];
  plannedControlledKWh: number[];
  price?: Array<number | null>;
  priceFactor?: Array<number | null>;
  priceShapingActive: boolean;
  priceSpreadFactor?: number;
  effectivePriceShapingFlexShare: number;
  uncontrolledReserveDiagnostics?: UncontrolledReservePlanDiagnostics;
};

type PlanSetup = {
  bounds: PlanBounds;
  splitShares: SplitShares;
  normalizedDayWeights: number[];
  combinedWeights: number[];
  usedInCurrent: number;
  priceShape: ReturnType<typeof buildPriceFactors>;
  remainingPrices?: Array<number | null>;
  effectivePriceShapingFlexShare: number;
};

type PlannedTotalsResult = {
  plannedKWh: number[];
  uncontrolledReserveFloors: number[];
  uncontrolledReserveDiagnostics?: UncontrolledReservePlanDiagnostics;
};

export function buildPlan(params: BuildPlanParams): BuildPlanResult {
  const setup = resolvePlanSetup(params);
  const plannedTotals = resolvePlannedTotals({
    params,
    bounds: setup.bounds,
    combinedWeights: setup.combinedWeights,
    normalizedDayWeights: setup.normalizedDayWeights,
    splitShares: setup.splitShares,
    usedInCurrent: setup.usedInCurrent,
    remainingPrices: setup.remainingPrices,
    effectivePriceShapingFlexShare: setup.effectivePriceShapingFlexShare,
  });
  const { plannedKWh } = plannedTotals;
  const controlledMinFloors = buildControlledMinFloors({
    bucketStartUtcMs: params.bucketStartUtcMs,
    timeZone: params.timeZone,
    profileObservedMinControlledKWh: params.profileObservedMinControlledKWh,
    observedPeakMarginRatio: params.observedPeakMarginRatio,
    applyFromIndex: setup.bounds.remainingStartIndex,
    controlledUsageWeight: params.controlledUsageWeight,
  });
  const plannedSplit = buildPlannedSplit({
    plannedKWh,
    splitShares: setup.splitShares,
    controlledMinFloors,
    uncontrolledReserveFloors: plannedTotals.uncontrolledReserveFloors,
    previousPlannedUncontrolledKWh: params.previousPlannedUncontrolledKWh,
    previousPlannedControlledKWh: params.previousPlannedControlledKWh,
    currentBucketIndex: setup.bounds.safeCurrentBucketIndex,
    shouldLockCurrent: setup.bounds.shouldLockCurrent,
  });

  return {
    plannedKWh,
    plannedUncontrolledKWh: plannedSplit.map((entry) => entry.plannedUncontrolled),
    plannedControlledKWh: plannedSplit.map((entry) => entry.plannedControlled),
    price: setup.priceShape.prices,
    priceFactor: setup.priceShape.priceFactors,
    priceShapingActive: setup.priceShape.priceShapingActive,
    priceSpreadFactor: setup.priceShape.priceSpreadFactor,
    effectivePriceShapingFlexShare: setup.effectivePriceShapingFlexShare,
    uncontrolledReserveDiagnostics: plannedTotals.uncontrolledReserveDiagnostics,
  };
}

const resolvePlanSetup = (params: BuildPlanParams): PlanSetup => {
  const {
    bucketStartUtcMs,
    bucketUsage,
    currentBucketIndex,
    profileWeights,
    profileWeightsControlled,
    profileWeightsUncontrolled,
    timeZone,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
    priceShapingFlexShare,
    previousPlannedKWh,
    lockCurrentBucket,
  } = params;
  const bounds = resolvePlanBounds({
    currentBucketIndex,
    bucketCount: bucketStartUtcMs.length,
    previousPlannedKWh,
    lockCurrentBucket,
  });
  const priceShape = buildPriceFactors({
    bucketStartUtcMs,
    currentBucketIndex: bounds.safeCurrentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  });
  const configuredFlexShare = typeof priceShapingFlexShare === 'number'
    ? priceShapingFlexShare
    : PRICE_SHAPING_FLEX_SHARE;
  const priceSpreadFactor = typeof priceShape.priceSpreadFactor === 'number'
    ? priceShape.priceSpreadFactor
    : 0;
  const effectivePriceShapingFlexShare = priceShape.priceShapingActive
    && priceSpreadFactor > 0
    ? clamp(configuredFlexShare, 0, 1)
    : 0;
  const planWeights = buildPlanWeights({
    bucketStartUtcMs,
    timeZone,
    profileWeights,
    profileWeightsControlled,
    profileWeightsUncontrolled,
    priceFactors: undefined,
    flexShare: 0,
  });
  const splitShares = resolveSplitShares({
    uncontrolledWeights: planWeights.uncontrolled,
    controlledWeights: planWeights.controlled,
  });
  return {
    bounds,
    splitShares,
    normalizedDayWeights: normalizeWeightsWithFallback(planWeights.combined),
    combinedWeights: planWeights.combined,
    usedInCurrent: bucketUsage[bounds.safeCurrentBucketIndex] ?? 0,
    priceShape,
    remainingPrices: priceShape.prices?.slice(bounds.remainingStartIndex),
    effectivePriceShapingFlexShare,
  };
};

const resolvePlanBounds = (params: {
  currentBucketIndex: number;
  bucketCount: number;
  previousPlannedKWh?: number[];
  lockCurrentBucket?: boolean;
}): PlanBounds => {
  const { currentBucketIndex, bucketCount, previousPlannedKWh, lockCurrentBucket } = params;
  const safeCurrentBucketIndex = Math.max(0, currentBucketIndex);
  const hasPreviousPlan = Array.isArray(previousPlannedKWh)
    && previousPlannedKWh.length === bucketCount;
  const shouldLockCurrent = Boolean(lockCurrentBucket) && hasPreviousPlan;
  const remainingStartIndex = shouldLockCurrent
    ? Math.min(safeCurrentBucketIndex + 1, bucketCount)
    : safeCurrentBucketIndex;
  return {
    safeCurrentBucketIndex,
    hasPreviousPlan,
    shouldLockCurrent,
    remainingStartIndex,
  };
};

function normalizeWeightsWithFallback(weights: number[]): number[] {
  let normalized = normalizeWeights(weights);
  if (normalized.every((value) => value === 0)) {
    normalized = normalizeWeights(weights.map(() => 1));
  }
  return normalized;
}

const resolvePlannedTotals = (params: {
  params: BuildPlanParams;
  bounds: PlanBounds;
  combinedWeights: number[];
  normalizedDayWeights: number[];
  splitShares: SplitShares;
  usedInCurrent: number;
  remainingPrices?: Array<number | null>;
  effectivePriceShapingFlexShare: number;
}): PlannedTotalsResult => {
  const {
    params: {
      bucketStartUtcMs,
      bucketUsage,
      usedNowKWh,
      dailyBudgetKWh,
      previousPlannedKWh,
      capacityBudgetKWh,
      timeZone,
      controlledUsageWeight,
      profileObservedMaxUncontrolledKWh,
      profileObservedMaxControlledKWh,
      profileObservedMinUncontrolledKWh,
      profileObservedMinControlledKWh,
      profileObservedP50UncontrolledKWh,
      profileObservedP75UncontrolledKWh,
      profileObservedP90UncontrolledKWh,
      profileObservedUncontrolledSampleCounts,
      observedPeakMarginRatio,
    },
    bounds,
    combinedWeights,
    normalizedDayWeights,
    splitShares,
    usedInCurrent,
    remainingPrices,
    effectivePriceShapingFlexShare,
  } = params;
  const normalizedRemaining = resolveRemainingWeights({
    baseWeights: combinedWeights,
    remainingStartIndex: bounds.remainingStartIndex,
    previousPlannedKWh: bounds.hasPreviousPlan ? previousPlannedKWh : undefined,
  });
  const remainingBudgetForFuture = resolveRemainingBudgetForFuture({
    dailyBudgetKWh,
    usedNowKWh,
    usedInCurrent,
    currentBucketIndex: bounds.safeCurrentBucketIndex,
    previousPlannedKWh: bounds.hasPreviousPlan ? previousPlannedKWh : undefined,
    shouldLockCurrent: bounds.shouldLockCurrent,
  });
  const remainingCaps = resolveRemainingCaps({
    bucketStartUtcMs,
    timeZone,
    splitSharesUncontrolled: splitShares.uncontrolled,
    splitSharesControlled: splitShares.controlled,
    controlledUsageWeight: typeof controlledUsageWeight === 'number' ? controlledUsageWeight : 0,
    profileObservedMaxUncontrolledKWh,
    profileObservedMaxControlledKWh,
    observedPeakMarginRatio,
    capacityBudgetKWh,
    usedInCurrent,
    remainingStartIndex: bounds.remainingStartIndex,
    currentBucketIndex: bounds.safeCurrentBucketIndex,
  });
  const remainingFloorsResult = resolveRemainingFloors({
    bucketStartUtcMs,
    timeZone,
    splitSharesUncontrolled: splitShares.uncontrolled,
    splitSharesControlled: splitShares.controlled,
    controlledUsageWeight: typeof controlledUsageWeight === 'number' ? controlledUsageWeight : 0,
    profileObservedMinUncontrolledKWh,
    profileObservedMinControlledKWh,
    profileObservedP50UncontrolledKWh,
    profileObservedP75UncontrolledKWh,
    profileObservedP90UncontrolledKWh,
    profileObservedUncontrolledSampleCounts,
    observedPeakMarginRatio,
    usedInCurrent,
    remainingStartIndex: bounds.remainingStartIndex,
    currentBucketIndex: bounds.safeCurrentBucketIndex,
  });
  const remainingAllocations = resolveRemainingAllocations({
    weights: normalizedRemaining,
    remainingBudgetKWh: remainingBudgetForFuture,
    caps: remainingCaps,
    floors: remainingFloorsResult.floors,
    prices: remainingPrices,
    priceFlexShare: effectivePriceShapingFlexShare,
  });
  const planned = buildPlannedKWh({
    bucketCount: bucketStartUtcMs.length,
    bucketUsage,
    currentBucketIndex: bounds.safeCurrentBucketIndex,
    usedInCurrent,
    dailyBudgetKWh,
    normalizedDayWeights,
    previousPlannedKWh: bounds.hasPreviousPlan ? previousPlannedKWh : undefined,
    shouldLockCurrent: bounds.shouldLockCurrent,
    remainingStartIndex: bounds.remainingStartIndex,
    remainingAllocations,
  });
  return {
    plannedKWh: planned,
    uncontrolledReserveFloors: remainingFloorsResult.uncontrolledReserves,
    uncontrolledReserveDiagnostics: remainingFloorsResult.diagnostics,
  };
};

function resolveRemainingWeights(params: {
  baseWeights: number[];
  remainingStartIndex: number;
  previousPlannedKWh?: number[];
}): number[] {
  const {
    baseWeights,
    remainingStartIndex,
    previousPlannedKWh,
  } = params;
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

function resolveRemainingBudgetForFuture(params: {
  dailyBudgetKWh: number;
  usedNowKWh: number;
  usedInCurrent: number;
  currentBucketIndex: number;
  previousPlannedKWh?: number[];
  shouldLockCurrent: boolean;
}): number {
  const {
    dailyBudgetKWh,
    usedNowKWh,
    usedInCurrent,
    currentBucketIndex,
    previousPlannedKWh,
    shouldLockCurrent,
  } = params;
  const remainingBudget = Math.max(0, dailyBudgetKWh - usedNowKWh);
  if (!shouldLockCurrent || !previousPlannedKWh?.length) return remainingBudget;
  const previousCurrent = previousPlannedKWh[currentBucketIndex];
  const plannedCurrent = Number.isFinite(previousCurrent) ? previousCurrent : 0;
  const reservedCurrent = Math.max(0, plannedCurrent - usedInCurrent);
  return Math.max(0, remainingBudget - reservedCurrent);
}

function resolveRemainingAllocations(params: {
  weights: number[];
  remainingBudgetKWh: number;
  caps: number[];
  floors: number[];
  prices?: Array<number | null>;
  priceFlexShare: number;
}): number[] {
  const {
    weights,
    remainingBudgetKWh,
    caps,
    floors,
    prices,
    priceFlexShare,
  } = params;
  if (weights.length === 0 || remainingBudgetKWh <= 0) return weights.map(() => 0);
  return allocateBudgetWithPriceTargets({
    neutralWeights: weights,
    totalKWh: remainingBudgetKWh,
    caps,
    floors,
    prices,
    flexShare: priceFlexShare,
  });
}

function buildPlannedKWh(params: {
  bucketCount: number;
  bucketUsage: number[];
  currentBucketIndex: number;
  usedInCurrent: number;
  dailyBudgetKWh: number;
  normalizedDayWeights: number[];
  previousPlannedKWh?: number[];
  shouldLockCurrent: boolean;
  remainingStartIndex: number;
  remainingAllocations: number[];
}): number[] {
  const {
    bucketCount,
    bucketUsage,
    currentBucketIndex,
    usedInCurrent,
    dailyBudgetKWh,
    normalizedDayWeights,
    previousPlannedKWh,
    shouldLockCurrent,
    remainingStartIndex,
    remainingAllocations,
  } = params;
  return Array.from({ length: bucketCount }, (_, index) => {
    if (index < currentBucketIndex) {
      if (previousPlannedKWh?.length) {
        const previousValue = previousPlannedKWh[index];
        return Number.isFinite(previousValue) ? previousValue : bucketUsage[index] ?? 0;
      }
      const fallbackWeight = normalizedDayWeights[index] ?? 0;
      return dailyBudgetKWh * fallbackWeight;
    }
    if (index === currentBucketIndex) {
      if (shouldLockCurrent && previousPlannedKWh?.length) {
        const previousValue = previousPlannedKWh[index];
        return Number.isFinite(previousValue) ? previousValue : usedInCurrent;
      }
      const allocation = remainingAllocations[0] ?? 0;
      return usedInCurrent + allocation;
    }
    const allocation = remainingAllocations[index - remainingStartIndex] ?? 0;
    return allocation;
  });
}
