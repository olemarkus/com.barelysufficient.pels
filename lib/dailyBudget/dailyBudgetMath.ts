import { getZonedParts } from '../utils/dateUtils';
import { clamp } from '../utils/mathUtils';

export type CombinedPriceEntry = {
  startsAt: string;
  total: number;
};

export type CombinedPriceData = {
  prices?: CombinedPriceEntry[];
  lastFetched?: string;
};

const PREVIOUS_PLAN_BLEND_WEIGHT = 0.7;
const NEW_PLAN_BLEND_WEIGHT = 1 - PREVIOUS_PLAN_BLEND_WEIGHT;
const CAP_ALLOCATION_EPSILON = 1e-6;
// Allow a few extra redistribution passes when caps fill due to rounding.
const MAX_CAP_REDISTRIBUTION_EXTRA_ITERATIONS = 3;

export function getConfidence(sampleCount: number): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0;
  return clamp(sampleCount / 14, 0, 1);
}


export function blendProfiles(defaultWeights: number[], learnedWeights: number[], confidence: number): number[] {
  const safeConfidence = clamp(confidence, 0, 1);
  const blended = defaultWeights.map((value, index) => (
    value * (1 - safeConfidence) + (learnedWeights[index] ?? value) * safeConfidence
  ));
  return normalizeWeights(blended);
}

export function normalizeWeights(weights: number[]): number[] {
  const total = sumArray(weights);
  if (total <= 0) return weights.map(() => 0);
  return weights.map((value) => value / total);
}

export function buildDefaultProfile(): number[] {
  const bumps: Record<number, number> = {
    6: 0.3,
    7: 0.5,
    8: 0.4,
    16: 0.2,
    17: 0.5,
    18: 0.8,
    19: 0.9,
    20: 0.8,
    21: 0.6,
    22: 0.4,
  };
  const weights = Array.from({ length: 24 }, (_, hour) => 1 + (bumps[hour] ?? 0));
  return normalizeWeights(weights);
}

export function buildPlan(params: {
  bucketStartUtcMs: number[];
  bucketUsage: number[];
  currentBucketIndex: number;
  usedNowKWh: number;
  dailyBudgetKWh: number;
  profileWeights: number[];
  timeZone: string;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
  previousPlannedKWh?: number[];
  capacityBudgetKWh?: number;
  lockCurrentBucket?: boolean;
}): {
  plannedKWh: number[];
  price?: Array<number | null>;
  priceFactor?: Array<number | null>;
  priceShapingActive: boolean;
} {
  const {
    bucketStartUtcMs,
    bucketUsage,
    currentBucketIndex,
    usedNowKWh,
    dailyBudgetKWh,
    profileWeights,
    timeZone,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
    previousPlannedKWh,
    capacityBudgetKWh,
    lockCurrentBucket,
  } = params;

  const safeCurrentBucketIndex = Math.max(0, currentBucketIndex);
  const hasPreviousPlan = Array.isArray(previousPlannedKWh)
    && previousPlannedKWh.length === bucketStartUtcMs.length;
  const shouldLockCurrent = Boolean(lockCurrentBucket) && hasPreviousPlan;
  const remainingStartIndex = shouldLockCurrent
    ? Math.min(safeCurrentBucketIndex + 1, bucketStartUtcMs.length)
    : safeCurrentBucketIndex;

  const baseWeights = buildHourWeights({ bucketStartUtcMs, profileWeights, timeZone });
  const normalizedDayWeights = normalizeWeightsWithFallback(baseWeights);

  const priceShape = buildPriceFactors({
    bucketStartUtcMs,
    currentBucketIndex: safeCurrentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  });

  const usedInCurrent = bucketUsage[safeCurrentBucketIndex] ?? 0;
  const normalizedRemaining = resolveRemainingWeights({
    baseWeights,
    remainingStartIndex,
    priceFactors: priceShape.priceFactors,
    previousPlannedKWh: hasPreviousPlan ? previousPlannedKWh : undefined,
  });
  const remainingBudgetForFuture = resolveRemainingBudgetForFuture({
    dailyBudgetKWh,
    usedNowKWh,
    usedInCurrent,
    currentBucketIndex: safeCurrentBucketIndex,
    previousPlannedKWh: hasPreviousPlan ? previousPlannedKWh : undefined,
    shouldLockCurrent,
  });
  const remainingAllocations = resolveRemainingAllocations({
    weights: normalizedRemaining,
    remainingBudgetKWh: remainingBudgetForFuture,
    capacityBudgetKWh,
    usedInCurrent,
    remainingStartIndex,
    currentBucketIndex: safeCurrentBucketIndex,
  });
  const plannedKWh = buildPlannedKWh({
    bucketCount: bucketStartUtcMs.length,
    bucketUsage,
    currentBucketIndex: safeCurrentBucketIndex,
    usedInCurrent,
    dailyBudgetKWh,
    normalizedDayWeights,
    previousPlannedKWh: hasPreviousPlan ? previousPlannedKWh : undefined,
    shouldLockCurrent,
    remainingStartIndex,
    remainingAllocations,
  });

  return {
    plannedKWh,
    price: priceShape.prices,
    priceFactor: priceShape.priceFactors,
    priceShapingActive: priceShape.priceShapingActive,
  };
}

function buildHourWeights(params: {
  bucketStartUtcMs: number[];
  profileWeights: number[];
  timeZone: string;
}): number[] {
  const { bucketStartUtcMs, profileWeights, timeZone } = params;
  return bucketStartUtcMs.map((ts) => {
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    return profileWeights[hour] ?? 0;
  });
}

function normalizeWeightsWithFallback(weights: number[]): number[] {
  let normalized = normalizeWeights(weights);
  if (normalized.every((value) => value === 0)) {
    normalized = normalizeWeights(weights.map(() => 1));
  }
  return normalized;
}

function resolveRemainingWeights(params: {
  baseWeights: number[];
  remainingStartIndex: number;
  priceFactors?: Array<number | null>;
  previousPlannedKWh?: number[];
}): number[] {
  const {
    baseWeights,
    remainingStartIndex,
    priceFactors,
    previousPlannedKWh,
  } = params;
  const remainingWeightsRaw = baseWeights.slice(remainingStartIndex);
  const remainingWeights = priceFactors?.length
    ? remainingWeightsRaw.map((value, index) => {
      const factor = priceFactors[remainingStartIndex + index];
      return typeof factor === 'number' ? value * factor : value;
    })
    : remainingWeightsRaw;
  let normalizedRemaining = normalizeWeightsWithFallback(remainingWeights);
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
  capacityBudgetKWh?: number;
  usedInCurrent: number;
  remainingStartIndex: number;
  currentBucketIndex: number;
}): number[] {
  const {
    weights,
    remainingBudgetKWh,
    capacityBudgetKWh,
    usedInCurrent,
    remainingStartIndex,
    currentBucketIndex,
  } = params;
  if (!Number.isFinite(capacityBudgetKWh)) {
    return weights.map((weight) => remainingBudgetKWh * weight);
  }
  const capKWh = Math.max(0, capacityBudgetKWh ?? 0);
  const caps = weights.map((_, index) => (
    remainingStartIndex === currentBucketIndex && index === 0
      ? Math.max(0, capKWh - usedInCurrent)
      : capKWh
  ));
  return allocateBudgetWithCaps({ weights, totalKWh: remainingBudgetKWh, caps });
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

export function allocateBudgetWithCaps(params: {
  weights: number[];
  totalKWh: number;
  caps: number[];
}): number[] {
  const { weights, totalKWh, caps } = params;
  const count = weights.length;
  let allocations = Array.from({ length: count }, () => 0);
  if (count === 0 || totalKWh <= 0) return allocations;
  let remaining = totalKWh;
  let active = weights
    .map((_, index) => index)
    .filter((index) => (caps[index] ?? 0) > CAP_ALLOCATION_EPSILON);
  let guard = 0;

  while (remaining > CAP_ALLOCATION_EPSILON && active.length > 0 && guard < count + MAX_CAP_REDISTRIBUTION_EXTRA_ITERATIONS) {
    const weightSum = active.reduce((sum, index) => sum + (weights[index] ?? 0), 0);
    if (weightSum <= CAP_ALLOCATION_EPSILON) {
      const evenShare = remaining / active.length;
      const result = active.reduce((acc, index) => {
        const capRemaining = Math.max(0, (caps[index] ?? 0) - acc.allocations[index]);
        const add = Math.min(capRemaining, evenShare);
        const nextAllocations = acc.allocations.map((value, idx) => (
          idx === index ? value + add : value
        ));
        const nextRemaining = acc.remaining - add;
        const nextActive = capRemaining - add > CAP_ALLOCATION_EPSILON
          ? acc.nextActive.concat(index)
          : acc.nextActive;
        return {
          allocations: nextAllocations,
          remaining: nextRemaining,
          nextActive,
        };
      }, {
        allocations,
        remaining,
        nextActive: [] as number[],
      });
      allocations = result.allocations;
      remaining = result.remaining;
      active = result.nextActive;
      guard += 1;
      continue;
    }

    const result = active.reduce((acc, index) => {
      const share = remaining * ((weights[index] ?? 0) / weightSum);
      const capRemaining = Math.max(0, (caps[index] ?? 0) - acc.allocations[index]);
      if (capRemaining <= CAP_ALLOCATION_EPSILON) {
        return {
          ...acc,
          overflow: acc.overflow + share,
        };
      }
      if (share >= capRemaining - CAP_ALLOCATION_EPSILON) {
        const nextAllocations = acc.allocations.map((value, idx) => (
          idx === index ? value + capRemaining : value
        ));
        return {
          allocations: nextAllocations,
          overflow: acc.overflow + share - capRemaining,
          nextActive: acc.nextActive,
        };
      }
      const nextAllocations = acc.allocations.map((value, idx) => (
        idx === index ? value + share : value
      ));
      return {
        allocations: nextAllocations,
        overflow: acc.overflow,
        nextActive: acc.nextActive.concat(index),
      };
    }, {
      allocations,
      overflow: 0,
      nextActive: [] as number[],
    });
    allocations = result.allocations;
    remaining = result.overflow;
    active = result.nextActive;
    guard += 1;
  }

  return allocations;
}

export function buildPriceDebugData(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): { prices?: Array<number | null>; priceFactors?: Array<number | null>; priceShapingActive: boolean } {
  const priceShape = buildPriceFactors(params);
  return {
    prices: priceShape.prices,
    priceFactors: priceShape.priceFactors,
    priceShapingActive: priceShape.priceShapingActive,
  };
}

/**
 * Map combined price entries onto the bucket timestamps.
 */
export function buildPriceSeries(params: {
  bucketStartUtcMs: number[];
  combinedPrices?: CombinedPriceData | null;
}): Array<number | null> | undefined {
  const { bucketStartUtcMs, combinedPrices } = params;
  const entries = combinedPrices?.prices;
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const priceByStart = new Map<number, number>();
  entries.forEach((entry) => {
    const ts = new Date(entry.startsAt).getTime();
    if (Number.isFinite(ts)) priceByStart.set(ts, entry.total);
  });
  return bucketStartUtcMs.map((ts) => {
    const value = priceByStart.get(ts);
    return typeof value === 'number' ? value : null;
  });
}

export function buildPriceFactors(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): { prices?: Array<number | null>; priceFactors?: Array<number | null>; priceShapingActive: boolean } {
  const {
    bucketStartUtcMs,
    currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  } = params;

  const safeCurrentBucketIndex = Math.max(0, currentBucketIndex);
  const pricesAll = buildPriceSeries({ bucketStartUtcMs, combinedPrices });
  if (!pricesAll) {
    return { priceShapingActive: false };
  }
  if (!priceOptimizationEnabled || !priceShapingEnabled) {
    return { prices: pricesAll, priceShapingActive: false };
  }
  const remainingPrices = pricesAll.slice(safeCurrentBucketIndex);
  if (remainingPrices.some((value) => typeof value !== 'number')) {
    return { prices: pricesAll, priceShapingActive: false };
  }
  const numericPrices = remainingPrices as number[];
  const priceList = [...numericPrices].sort((a, b) => a - b);
  const median = percentile(priceList, 0.5);
  const p10 = percentile(priceList, 0.1);
  const p90 = percentile(priceList, 0.9);
  const spread = Math.max(1, p90 - p10);
  const minFactor = 0.7;
  const maxFactor = 1.3;
  const remainingFactors = numericPrices.map((price) => clamp(1 + (median - price) / spread, minFactor, maxFactor));
  const priceFactorsAll = [
    ...Array.from({ length: safeCurrentBucketIndex }, () => null),
    ...remainingFactors,
  ];

  return {
    prices: pricesAll,
    priceFactors: priceFactorsAll,
    priceShapingActive: true,
  };
}

export function buildAllowedCumKWh(plannedKWh: number[], dailyBudgetKWh: number): number[] {
  if (dailyBudgetKWh <= 0) return plannedKWh.map(() => 0);
  let total = 0;
  return plannedKWh.map((value) => {
    total += value;
    return Math.min(total, dailyBudgetKWh);
  });
}

export function buildWeightsFromPlan(plannedKWh: number[]): number[] {
  const total = sumArray(plannedKWh);
  if (total <= 0) return plannedKWh.map(() => 0);
  return plannedKWh.map((value) => value / total);
}

export function resolveCurrentBucketIndex(dayStartUtcMs: number, bucketCount: number, nowMs: number): number {
  if (bucketCount <= 0) return 0;
  const diff = nowMs - dayStartUtcMs;
  const index = Math.floor(diff / (60 * 60 * 1000));
  return clamp(index, 0, bucketCount - 1);
}

export function sumArray(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * ratio)));
  return values[index];
}
