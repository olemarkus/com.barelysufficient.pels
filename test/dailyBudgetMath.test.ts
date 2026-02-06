import {
  allocateBudgetWithCaps,
  blendProfiles,
  buildAllowedCumKWh,
  buildCompositeWeights,
  buildDefaultProfile,
  buildPlan,
  buildPriceFactors,
  buildPriceSeries,
  buildWeightsFromPlan,
  getConfidence,
  normalizeWeights,
  resolveCurrentBucketIndex,
} from '../lib/dailyBudget/dailyBudgetMath';
import { buildPlanBreakdown } from '../lib/dailyBudget/dailyBudgetBreakdown';

describe('allocateBudgetWithCaps', () => {
  it('caps all buckets when every bucket hits its cap', () => {
    const weights = [1, 1, 1];
    const caps = [1, 1, 1];
    const allocations = allocateBudgetWithCaps({
      weights,
      totalKWh: 10,
      caps,
    });

    expect(allocations).toHaveLength(3);
    allocations.forEach((value, index) => {
      expect(value).toBeCloseTo(caps[index], 6);
    });
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(3, 6);
  });

  it('falls back to even allocation when weights are zero', () => {
    const allocations = allocateBudgetWithCaps({
      weights: [0, 0, 0],
      totalKWh: 6,
      caps: [10, 10, 10],
    });

    expect(allocations).toHaveLength(3);
    allocations.forEach((value) => {
      expect(value).toBeCloseTo(2, 6);
    });
  });

  it('redistributes overflow when caps are uneven', () => {
    const allocations = allocateBudgetWithCaps({
      weights: [0.7, 0.3],
      totalKWh: 5,
      caps: [1, 10],
    });

    expect(allocations[0]).toBeCloseTo(1, 6);
    expect(allocations[1]).toBeCloseTo(4, 6);
    const total = allocations.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(5, 6);
  });
});

describe('daily budget math helpers', () => {
  const hourMs = 60 * 60 * 1000;
  const dayStart = Date.UTC(2024, 0, 1, 0, 0, 0);
  const bucketStartUtcMs = [
    dayStart,
    dayStart + hourMs,
    dayStart + 2 * hourMs,
    dayStart + 3 * hourMs,
  ];
  const timeZone = 'UTC';

  it('clamps confidence and normalizes blended weights', () => {
    expect(getConfidence(-1)).toBe(0);
    expect(getConfidence(7)).toBeCloseTo(0.5, 5);
    expect(getConfidence(28)).toBe(1);

    expect(normalizeWeights([0, 0])).toEqual([0, 0]);
    expect(normalizeWeights([1, 1])).toEqual([0.5, 0.5]);

    const blended = blendProfiles([1, 1, 1], [2], 2);
    const blendedTotal = blended.reduce((sum, value) => sum + value, 0);
    expect(blendedTotal).toBeCloseTo(1, 6);
  });

  it('builds a default profile with normalized weights', () => {
    const profile = buildDefaultProfile();
    const total = profile.reduce((sum, value) => sum + value, 0);
    expect(profile).toHaveLength(24);
    expect(total).toBeCloseTo(1, 6);
  });

  it('maps combined prices onto buckets and ignores invalid entries', () => {
    expect(buildPriceSeries({ bucketStartUtcMs, combinedPrices: { prices: [] } })).toBeUndefined();

    const prices = buildPriceSeries({
      bucketStartUtcMs,
      combinedPrices: {
        prices: [
          { startsAt: new Date(bucketStartUtcMs[0]).toISOString(), total: 1 },
          { startsAt: 'invalid-date', total: 10 },
          { startsAt: new Date(bucketStartUtcMs[2]).toISOString(), total: 3 },
        ],
      },
    });

    expect(prices).toEqual([1, null, 3, null]);
  });

  it('builds price factors only when shaping is enabled and data is complete', () => {
    const combinedPrices = {
      prices: bucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: 10 + index,
      })),
    };

    const disabled = buildPriceFactors({
      bucketStartUtcMs,
      currentBucketIndex: 0,
      combinedPrices,
      priceOptimizationEnabled: false,
      priceShapingEnabled: true,
    });
    expect(disabled.priceShapingActive).toBe(false);
    expect(disabled.prices).toHaveLength(4);
    expect(disabled.priceFactors).toBeUndefined();

    const missing = buildPriceFactors({
      bucketStartUtcMs,
      currentBucketIndex: 1,
      combinedPrices: {
        prices: combinedPrices.prices.slice(0, 2),
      },
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });
    expect(missing.priceShapingActive).toBe(false);
    expect(missing.prices).toHaveLength(4);

    const enabled = buildPriceFactors({
      bucketStartUtcMs,
      currentBucketIndex: 1,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });
    expect(enabled.priceShapingActive).toBe(true);
    expect(enabled.priceFactors?.[0]).toBeNull();
    expect(typeof enabled.priceFactors?.[1]).toBe('number');
  });

  it('blends price factors into a flex share of weights', () => {
    const combined = buildCompositeWeights({
      baseWeights: [1, 1],
      priceFactors: [1.3, 0.7],
      flexShare: 0.5,
    });
    expect(combined[0]).toBeCloseTo(1.15, 6);
    expect(combined[1]).toBeCloseTo(0.85, 6);
  });

  it('keeps base weights when price factors are missing', () => {
    const combined = buildCompositeWeights({
      baseWeights: [1, 2],
      priceFactors: undefined,
      flexShare: 0.5,
    });
    expect(combined).toEqual([1, 2]);
  });

  it('builds a breakdown that sums to planned values', () => {
    const plannedKWh = [4, 2, 0, 6];
    const breakdown = buildPlanBreakdown({
      bucketStartUtcMs,
      timeZone,
      plannedKWh,
      breakdown: {
        uncontrolled: [1, 0, 0, 0, ...Array.from({ length: 20 }, () => 0)],
        controlled: [0, 1, 0, 0, ...Array.from({ length: 20 }, () => 0)],
      },
    });
    expect(breakdown).not.toBeNull();
    const plannedUncontrolled = breakdown?.plannedUncontrolledKWh ?? [];
    const plannedControlled = breakdown?.plannedControlledKWh ?? [];
    expect(plannedUncontrolled[0]).toBeCloseTo(4, 6);
    expect(plannedControlled[0]).toBeCloseTo(0, 6);
    expect(plannedUncontrolled[1]).toBeCloseTo(0, 6);
    expect(plannedControlled[1]).toBeCloseTo(2, 6);
    expect(plannedUncontrolled[3] + plannedControlled[3]).toBeCloseTo(6, 6);
  });

  it('builds a plan that respects previous buckets and locked current bucket', () => {
    const result = buildPlan({
      bucketStartUtcMs,
      bucketUsage: [1, 2, 0.5, 0.2],
      currentBucketIndex: 1,
      usedNowKWh: 3,
      dailyBudgetKWh: 10,
      profileWeights: Array.from({ length: 24 }, () => 0),
      timeZone,
      combinedPrices: {
        prices: bucketStartUtcMs.map((ts, index) => ({
          startsAt: new Date(ts).toISOString(),
          total: 15 + index,
        })),
      },
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      previousPlannedKWh: [1, Number.NaN, 3, 4],
      capacityBudgetKWh: 2,
      lockCurrentBucket: true,
    });

    expect(result.priceShapingActive).toBe(true);
    expect(result.plannedKWh).toHaveLength(4);
    expect(result.plannedKWh[0]).toBe(1);
    expect(result.plannedKWh[1]).toBeCloseTo(2, 6);
  });

  it('builds a plan without previous data and without a capacity cap', () => {
    const result = buildPlan({
      bucketStartUtcMs,
      bucketUsage: [1, 2, 0, 0],
      currentBucketIndex: 1,
      usedNowKWh: 3,
      dailyBudgetKWh: 8,
      profileWeights: Array.from({ length: 24 }, () => 1),
      timeZone,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      priceShapingEnabled: false,
    });

    expect(result.priceShapingActive).toBe(false);
    expect(result.plannedKWh[0]).toBeCloseTo(2, 6);
    expect(result.plannedKWh[1]).toBeCloseTo(3.666666, 4);
  });

  it('applies price shaping to controlled load only when split profiles exist', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: index === 0 ? 10 : 30,
      })),
    };
    const baseProfile = Array.from({ length: 24 }, () => 0);
    const controlledProfile = baseProfile.slice();
    const uncontrolledProfile = baseProfile.slice();
    controlledProfile[0] = 1;
    controlledProfile[1] = 1;
    uncontrolledProfile[0] = 1;
    uncontrolledProfile[1] = 3;

    const priceShape = buildPriceFactors({
      bucketStartUtcMs: shortBucketStartUtcMs,
      currentBucketIndex: 0,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });
    expect(priceShape.priceShapingActive).toBe(true);

    const uncontrolledWeights = [uncontrolledProfile[0], uncontrolledProfile[1]];
    const controlledWeights = [controlledProfile[0], controlledProfile[1]];
    const shapedControlled = buildCompositeWeights({
      baseWeights: controlledWeights,
      priceFactors: priceShape.priceFactors,
      flexShare: 1,
    });
    const combinedWeights = uncontrolledWeights.map((value, index) => value + (shapedControlled[index] ?? 0));
    const expectedWeights = normalizeWeights(combinedWeights);
    const expectedPlanned = expectedWeights.map((weight) => 10 * weight);

    const result = buildPlan({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: baseProfile,
      profileWeightsControlled: controlledProfile,
      profileWeightsUncontrolled: uncontrolledProfile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
    });

    expect(result.plannedKWh[0]).toBeCloseTo(expectedPlanned[0], 6);
    expect(result.plannedKWh[1]).toBeCloseTo(expectedPlanned[1], 6);
  });

  it('applies price shaping to the full weights when split profiles are missing', () => {
    const shortBucketStartUtcMs = bucketStartUtcMs.slice(0, 2);
    const combinedPrices = {
      prices: shortBucketStartUtcMs.map((ts, index) => ({
        startsAt: new Date(ts).toISOString(),
        total: index === 0 ? 10 : 30,
      })),
    };
    const baseProfile = Array.from({ length: 24 }, () => 0);
    baseProfile[0] = 2;
    baseProfile[1] = 4;

    const priceShape = buildPriceFactors({
      bucketStartUtcMs: shortBucketStartUtcMs,
      currentBucketIndex: 0,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });

    const baseWeights = [baseProfile[0], baseProfile[1]];
    const shapedWeights = buildCompositeWeights({
      baseWeights,
      priceFactors: priceShape.priceFactors,
      flexShare: 1,
    });
    const expectedWeights = normalizeWeights(shapedWeights);
    const expectedPlanned = expectedWeights.map((weight) => 10 * weight);

    const result = buildPlan({
      bucketStartUtcMs: shortBucketStartUtcMs,
      bucketUsage: [0, 0],
      currentBucketIndex: 0,
      usedNowKWh: 0,
      dailyBudgetKWh: 10,
      profileWeights: baseProfile,
      timeZone,
      combinedPrices,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1,
    });

    expect(result.plannedKWh[0]).toBeCloseTo(expectedPlanned[0], 6);
    expect(result.plannedKWh[1]).toBeCloseTo(expectedPlanned[1], 6);
  });

  it('handles cumulative budgets and weight normalization helpers', () => {
    expect(buildAllowedCumKWh([1, 2], 0)).toEqual([0, 0]);
    expect(buildAllowedCumKWh([1, 2], 10)).toEqual([1, 3]);

    expect(buildWeightsFromPlan([0, 0])).toEqual([0, 0]);
    expect(buildWeightsFromPlan([1, 3])).toEqual([0.25, 0.75]);

    expect(resolveCurrentBucketIndex(0, 0, 1000)).toBe(0);
    expect(resolveCurrentBucketIndex(0, 24, -hourMs)).toBe(0);
  });
});
