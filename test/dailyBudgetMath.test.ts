import {
  allocateBudgetWithCaps,
  blendProfiles,
  buildAllowedCumKWh,
  buildDefaultProfile,
  buildPlan,
  buildPriceFactors,
  buildPriceSeries,
  buildWeightsFromPlan,
  getConfidence,
  normalizeWeights,
  resolveCurrentBucketIndex,
} from '../lib/dailyBudget/dailyBudgetMath';

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

  it('handles cumulative budgets and weight normalization helpers', () => {
    expect(buildAllowedCumKWh([1, 2], 0)).toEqual([0, 0]);
    expect(buildAllowedCumKWh([1, 2], 10)).toEqual([1, 3]);

    expect(buildWeightsFromPlan([0, 0])).toEqual([0, 0]);
    expect(buildWeightsFromPlan([1, 3])).toEqual([0.25, 0.75]);

    expect(resolveCurrentBucketIndex(0, 0, 1000)).toBe(0);
    expect(resolveCurrentBucketIndex(0, 24, -hourMs)).toBe(0);
  });
});
