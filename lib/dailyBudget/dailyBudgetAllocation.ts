/**
 * Pure allocation math for the daily kWh budget: weight normalization,
 * price-shaped composite weights, and cap/floor-constrained distribution of
 * a day's budget (kWh) across plan buckets. No I/O, no clock, no Homey SDK —
 * every function maps positional bucket arrays to positional bucket arrays,
 * so all array inputs of one call must be index-aligned to the same bucket
 * sequence. The formulas and their user-facing meaning are specified in
 * `docs/daily-budget-weights.md`; keep code and doc in lock-step.
 */
import { clamp } from '../../packages/shared-domain/src/utils/math';
import { PRICE_SHAPING_PRICE_RANGE_EPSILON } from './dailyBudgetConstants';

const CAP_ALLOCATION_EPSILON = 1e-6;
// Allow a few extra redistribution passes when caps fill due to rounding.
const MAX_CAP_REDISTRIBUTION_EXTRA_ITERATIONS = 3;

/**
 * Scales `weights` to sum to 1. Inputs are unitless relative shares (callers
 * pass kWh-derived per-bucket weights) and are expected non-negative —
 * negative entries are not clamped, they pass through scaled. A non-positive
 * total (empty array, all zeros, or net-negative sum) returns an all-zeros
 * array of the same length rather than dividing by zero; callers needing a
 * usable shape in that case supply their own fallback (see
 * `normalizeWeightsWithFallback` in `dailyBudgetPlanCore.ts`).
 */
export function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return weights.map(() => 0);
  return weights.map((value) => value / total);
}

export function allocateBudgetWithCaps(weights: number[], totalKWh: number, caps: number[]): number[] {
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

    const distribution = distributeActiveAllocations(active, remaining, weightSum, effectiveWeights, caps, allocations);
    remaining = distribution.overflow;
    active = distribution.nextActive;
    guard += 1;
  }

  return allocations;
}

/* eslint-disable functional/immutable-data, no-param-reassign -- The caller's accumulator: no per-pass copies. */
function distributeActiveAllocations(
  active: number[],
  remaining: number,
  weightSum: number,
  effectiveWeights: number[],
  caps: number[],
  allocations: number[],
): { overflow: number; nextActive: number[] } {
  let overflow = 0;
  const nextActive: number[] = [];
  for (const index of active) {
    // `active` only ever holds indices into `allocations`, which the caller
    // creates with one zeroed slot per weight.
    const allocated = allocations[index];
    if (allocated === undefined) continue;
    const share = remaining * ((effectiveWeights[index] ?? 0) / weightSum);
    const capRemaining = Math.max(0, (caps[index] ?? 0) - allocated);
    if (capRemaining <= CAP_ALLOCATION_EPSILON) {
      overflow += share;
      continue;
    }
    if (share >= capRemaining - CAP_ALLOCATION_EPSILON) {
      allocations[index] = allocated + capRemaining;
      overflow += share - capRemaining;
      continue;
    }
    allocations[index] = allocated + share;
    nextActive.push(index);
  }
  return { overflow, nextActive };
}
/* eslint-enable functional/immutable-data, no-param-reassign */

export function allocateBudgetWithCapsAndFloors(
  weights: number[],
  totalKWh: number,
  caps: number[],
  floors: number[],
): number[] {
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
    Math.max(0, (cap ?? 0) - (scaledFloors[index] ?? 0))
  ));
  const remainderAllocations = remaining > 0
    ? allocateBudgetWithCaps(weights, remaining, remainingCaps)
    : weights.map(() => 0);

  return scaledFloors.map((value, index) => value + (remainderAllocations[index] ?? 0));
}

export function allocateBudgetWithPriceTargets(
  neutralWeights: number[],
  totalKWh: number,
  caps: number[],
  floors: number[],
  prices: Array<number | null> | undefined,
  flexShare: number,
): number[] {
  const neutral = allocateBudgetWithCapsAndFloors(neutralWeights, totalKWh, caps, floors);
  const safeFlexShare = clamp(flexShare, 0, 1);
  if (safeFlexShare <= 0 || !prices || prices.length !== neutralWeights.length) {
    return neutral;
  }

  const priceTargets = buildPriceTargetWeights(prices, caps, floors, totalKWh);
  if (!priceTargets) return neutral;

  const priceTargetAllocation = allocateBudgetWithCapsAndFloors(priceTargets, totalKWh, caps, floors);
  const neutralShare = 1 - safeFlexShare;
  return neutral.map((value, index) => (
    value * neutralShare + (priceTargetAllocation[index] ?? 0) * safeFlexShare
  ));
}

function buildPriceTargetWeights(
  prices: Array<number | null>,
  caps: number[],
  floors: number[],
  totalKWh: number,
): number[] | null {
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
