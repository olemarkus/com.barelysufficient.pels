import { clamp } from '../utils/mathUtils';
import { PRICE_SHAPING_PRICE_RANGE_EPSILON } from './dailyBudgetConstants';

const CAP_ALLOCATION_EPSILON = 1e-6;
// Allow a few extra redistribution passes when caps fill due to rounding.
const MAX_CAP_REDISTRIBUTION_EXTRA_ITERATIONS = 3;

export function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return weights.map(() => 0);
  return weights.map((value) => value / total);
}

export function buildCompositeWeights(params: {
  baseWeights: number[];
  priceFactors?: Array<number | null>;
  flexShare: number;
}): number[] {
  const { baseWeights, priceFactors, flexShare } = params;
  if (!priceFactors || priceFactors.length === 0) {
    return baseWeights.slice();
  }
  const safeFlexShare = clamp(flexShare, 0, 1);
  const baselineShare = 1 - safeFlexShare;
  return baseWeights.map((value, index) => {
    const factor = priceFactors[index];
    const priceAdjusted = typeof factor === 'number' ? value * factor : value;
    return value * baselineShare + priceAdjusted * safeFlexShare;
  });
}

export function allocateBudgetWithCaps(params: {
  weights: number[];
  totalKWh: number;
  caps: number[];
}): number[] {
  const { weights, totalKWh, caps } = params;
  const count = weights.length;
  let effectiveWeights = weights.slice();
  const allocations = Array.from({ length: count }, () => 0);
  if (count === 0 || totalKWh <= 0) return allocations;
  let remaining = totalKWh;
  let active = weights
    .map((_, index) => index)
    .filter((index) => (caps[index] ?? 0) > CAP_ALLOCATION_EPSILON);
  let guard = 0;
  const maxIterations = count + MAX_CAP_REDISTRIBUTION_EXTRA_ITERATIONS;

  while (remaining > CAP_ALLOCATION_EPSILON && active.length > 0 && guard < maxIterations) {
    const weightSum = active.reduce((sum, index) => sum + (effectiveWeights[index] ?? 0), 0);
    if (weightSum <= CAP_ALLOCATION_EPSILON) {
      const activeSet = new Set(active);
      effectiveWeights = effectiveWeights.map((value, index) => (
        activeSet.has(index) ? 1 : value
      ));
      guard += 1;
      continue;
    }

    const distribution = distributeActiveAllocations({
      active,
      remaining,
      weightSum,
      effectiveWeights,
      caps,
      allocations,
    });
    remaining = distribution.overflow;
    active = distribution.nextActive;
    guard += 1;
  }

  return allocations;
}

function distributeActiveAllocations(params: {
  active: number[];
  remaining: number;
  weightSum: number;
  effectiveWeights: number[];
  caps: number[];
  allocations: number[];
}): { overflow: number; nextActive: number[] } {
  const {
    active,
    remaining,
    weightSum,
    effectiveWeights,
    caps,
    allocations,
  } = params;
  let overflow = 0;
  const nextActive: number[] = [];
  for (const index of active) {
    const share = remaining * ((effectiveWeights[index] ?? 0) / weightSum);
    const capRemaining = Math.max(0, (caps[index] ?? 0) - allocations[index]);
    if (capRemaining <= CAP_ALLOCATION_EPSILON) {
      overflow += share;
      continue;
    }
    if (share >= capRemaining - CAP_ALLOCATION_EPSILON) {
      allocations[index] += capRemaining;
      overflow += share - capRemaining;
      continue;
    }
    allocations[index] += share;
    nextActive.push(index);
  }
  return { overflow, nextActive };
}

export function allocateBudgetWithCapsAndFloors(params: {
  weights: number[];
  totalKWh: number;
  caps: number[];
  floors: number[];
}): number[] {
  const { weights, totalKWh, caps, floors } = params;
  const count = weights.length;
  if (count === 0 || totalKWh <= 0) return weights.map(() => 0);

  const safeFloors = floors.map((value, index) => {
    const floor = Math.max(0, value ?? 0);
    const cap = Math.max(0, caps[index] ?? 0);
    return Math.min(floor, cap);
  });
  const floorSum = safeFloors.reduce((sum, value) => sum + value, 0);
  const scale = floorSum > totalKWh ? totalKWh / floorSum : 1;
  const scaledFloors = safeFloors.map((value) => value * scale);

  const remaining = Math.max(0, totalKWh - scaledFloors.reduce((sum, value) => sum + value, 0));
  const remainingCaps = caps.map((cap, index) => (
    Math.max(0, (cap ?? 0) - scaledFloors[index])
  ));
  const remainderAllocations = remaining > 0
    ? allocateBudgetWithCaps({ weights, totalKWh: remaining, caps: remainingCaps })
    : weights.map(() => 0);

  return scaledFloors.map((value, index) => value + (remainderAllocations[index] ?? 0));
}

export function allocateBudgetWithPriceTargets(params: {
  neutralWeights: number[];
  totalKWh: number;
  caps: number[];
  floors: number[];
  prices?: Array<number | null>;
  flexShare: number;
}): number[] {
  const {
    neutralWeights,
    totalKWh,
    caps,
    floors,
    prices,
    flexShare,
  } = params;
  const neutral = allocateBudgetWithCapsAndFloors({
    weights: neutralWeights,
    totalKWh,
    caps,
    floors,
  });
  const safeFlexShare = clamp(flexShare, 0, 1);
  if (safeFlexShare <= 0 || !prices || prices.length !== neutralWeights.length) {
    return neutral;
  }

  const priceTargets = buildPriceTargetWeights({ prices, caps, floors, totalKWh });
  if (!priceTargets) return neutral;

  const priceTargetAllocation = allocateBudgetWithCapsAndFloors({
    weights: priceTargets,
    totalKWh,
    caps,
    floors,
  });
  const neutralShare = 1 - safeFlexShare;
  return neutral.map((value, index) => (
    value * neutralShare + (priceTargetAllocation[index] ?? 0) * safeFlexShare
  ));
}

function buildPriceTargetWeights(params: {
  prices: Array<number | null>;
  caps: number[];
  floors: number[];
  totalKWh: number;
}): number[] | null {
  const { prices, caps, floors, totalKWh } = params;
  if (prices.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return null;
  }
  const numericPrices = prices as number[];
  const minPrice = Math.min(...numericPrices);
  const maxPrice = Math.max(...numericPrices);
  const priceRange = maxPrice - minPrice;
  if (!Number.isFinite(priceRange) || priceRange <= PRICE_SHAPING_PRICE_RANGE_EPSILON) {
    return null;
  }

  return numericPrices.map((price, index) => {
    const floor = Math.max(0, floors[index] ?? 0);
    const cap = Math.max(floor, caps[index] ?? 0);
    const effectiveCap = Number.isFinite(cap) ? cap : Math.max(floor, totalKWh);
    const pricePosition = (price - minPrice) / priceRange;
    const target = effectiveCap - pricePosition * (effectiveCap - floor);
    return Math.max(0, target - floor);
  });
}
