import { clamp } from '../utils/mathUtils';

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
  let allocations = Array.from({ length: count }, () => 0);
  if (count === 0 || totalKWh <= 0) return allocations;
  let remaining = totalKWh;
  let active = weights
    .map((_, index) => index)
    .filter((index) => (caps[index] ?? 0) > CAP_ALLOCATION_EPSILON);
  let guard = 0;
  const maxIterations = count + MAX_CAP_REDISTRIBUTION_EXTRA_ITERATIONS;

  while (remaining > CAP_ALLOCATION_EPSILON && active.length > 0 && guard < maxIterations) {
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
