import {
  DailyBudgetManager,
  buildDefaultProfile,
  buildPriceFactors,
  blendProfiles,
  getConfidence,
  normalizeWeights,
} from '../lib/dailyBudget/dailyBudgetManager';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../lib/utils/dateUtils';

const TZ = 'Europe/Oslo';

const buildManager = () => new DailyBudgetManager({
  log: () => undefined,
  logDebug: () => undefined,
});

describe('daily budget time boundaries', () => {
  it('computes local date key and day start from UTC', () => {
    const lateUtc = Date.UTC(2024, 0, 15, 22, 30);
    expect(getDateKeyInTimeZone(new Date(lateUtc), TZ)).toBe('2024-01-15');
    expect(new Date(getDateKeyStartMs('2024-01-15', TZ)).toISOString()).toBe('2024-01-14T23:00:00.000Z');

    const afterMidnightUtc = Date.UTC(2024, 0, 15, 23, 30);
    expect(getDateKeyInTimeZone(new Date(afterMidnightUtc), TZ)).toBe('2024-01-16');
    expect(new Date(getDateKeyStartMs('2024-01-16', TZ)).toISOString()).toBe('2024-01-15T23:00:00.000Z');
  });

  it('handles DST spring-forward and fall-back bucket counts', () => {
    const springKey = '2024-03-31';
    const springStart = getDateKeyStartMs(springKey, TZ);
    const springNext = getNextLocalDayStartUtcMs(springStart, TZ);
    const springBuckets = buildLocalDayBuckets({
      dayStartUtcMs: springStart,
      nextDayStartUtcMs: springNext,
      timeZone: TZ,
    }).bucketStartUtcMs;
    expect(springBuckets.length).toBe(23);

    const fallKey = '2024-10-27';
    const fallStart = getDateKeyStartMs(fallKey, TZ);
    const fallNext = getNextLocalDayStartUtcMs(fallStart, TZ);
    const fallBuckets = buildLocalDayBuckets({
      dayStartUtcMs: fallStart,
      nextDayStartUtcMs: fallNext,
      timeZone: TZ,
    }).bucketStartUtcMs;
    expect(fallBuckets.length).toBe(25);
  });
});

describe('daily budget profile blending', () => {
  it('ramps confidence from 0 to 1 over 14 days', () => {
    expect(getConfidence(0)).toBe(0);
    expect(getConfidence(7)).toBeCloseTo(0.5, 3);
    expect(getConfidence(14)).toBe(1);
  });

  it('blends default and learned profiles based on confidence', () => {
    const defaultWeights = buildDefaultProfile();
    const learnedWeights = normalizeWeights(defaultWeights.map((value, index) => (index === 0 ? value + 2 : value)));
    const blendedZero = blendProfiles(defaultWeights, learnedWeights, 0);
    const blendedFull = blendProfiles(defaultWeights, learnedWeights, 1);
    expect(blendedZero[0]).toBeCloseTo(defaultWeights[0], 6);
    expect(blendedFull[0]).toBeCloseTo(learnedWeights[0], 6);
  });
});

describe('daily budget planning', () => {
  it('builds an allowed curve from weights and daily budget', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    };
    const dateKey = getDateKeyInTimeZone(new Date(Date.UTC(2024, 0, 15, 0, 30)), TZ);
    const dayStart = getDateKeyStartMs(dateKey, TZ);
    const now = dayStart + 30 * 60 * 1000;
    const bucketKey = new Date(dayStart).toISOString();
    manager.loadState({
      profile: {
        weights: normalizeWeights([0.5, 0.5, ...Array.from({ length: 22 }, () => 0)]),
        sampleCount: 14,
      },
      plannedKWh: [],
    });
    const update = manager.update({
      nowMs: now,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0 } },
      priceOptimizationEnabled: false,
    });
    expect(update.snapshot.buckets.plannedKWh[0]).toBeCloseTo(5, 3);
    expect(update.snapshot.state.allowedNowKWh).toBeCloseTo(2.5, 3);
  });

  it('caps planned buckets to the capacity budget per hour', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    };
    const dateKey = getDateKeyInTimeZone(new Date(Date.UTC(2024, 0, 15, 0, 30)), TZ);
    const dayStart = getDateKeyStartMs(dateKey, TZ);
    const now = dayStart + 30 * 60 * 1000;
    const bucketKey = new Date(dayStart).toISOString();
    manager.loadState({
      profile: {
        weights: normalizeWeights([0.5, 0.5, ...Array.from({ length: 22 }, () => 0)]),
        sampleCount: 14,
      },
    });
    const update = manager.update({
      nowMs: now,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0.5 } },
      priceOptimizationEnabled: false,
      capacityBudgetKWh: 2,
    });
    const planned = update.snapshot.buckets.plannedKWh;
    const maxPlanned = Math.max(...planned);
    expect(maxPlanned).toBeLessThanOrEqual(2 + 1e-6);
    expect(planned[update.snapshot.currentBucketIndex]).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps the current bucket plan stable when usage changes within the hour', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    };
    const dateKey = getDateKeyInTimeZone(new Date(Date.UTC(2024, 0, 15, 0, 30)), TZ);
    const dayStart = getDateKeyStartMs(dateKey, TZ);
    const now = dayStart + 10 * 60 * 1000;
    const bucketKey = new Date(dayStart).toISOString();
    manager.loadState({
      profile: {
        weights: normalizeWeights([0.5, 0.5, ...Array.from({ length: 22 }, () => 0)]),
        sampleCount: 14,
      },
    });

    const first = manager.update({
      nowMs: now,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0 } },
      priceOptimizationEnabled: false,
    });
    const firstPlanned = first.snapshot.buckets.plannedKWh[first.snapshot.currentBucketIndex];

    const second = manager.update({
      nowMs: now + 2 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 2 } },
      priceOptimizationEnabled: false,
    });
    const secondPlanned = second.snapshot.buckets.plannedKWh[second.snapshot.currentBucketIndex];

    expect(secondPlanned).toBeCloseTo(firstPlanned, 6);
  });

  it('preserves planned values for past buckets when rebuilding', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    };
    const dateKey = getDateKeyInTimeZone(new Date(Date.UTC(2024, 0, 15, 1, 30)), TZ);
    const dayStart = getDateKeyStartMs(dateKey, TZ);
    const now = dayStart + 2.5 * 60 * 60 * 1000;
    const bucketKey0 = new Date(dayStart).toISOString();
    const bucketKey1 = new Date(dayStart + 60 * 60 * 1000).toISOString();
    const previousPlan = Array.from({ length: 24 }, (_, index) => (index === 0 ? 0.5 : 1));

    manager.loadState({
      dateKey,
      dayStartUtcMs: dayStart,
      plannedKWh: previousPlan,
      profile: {
        weights: normalizeWeights(Array.from({ length: 24 }, () => 1)),
        sampleCount: 14,
      },
    });

    const update = manager.update({
      nowMs: now,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey0]: 2, [bucketKey1]: 1.5 } },
      priceOptimizationEnabled: false,
      forcePlanRebuild: true,
    });

    expect(update.snapshot.buckets.plannedKWh[0]).toBeCloseTo(previousPlan[0], 6);
    expect(update.snapshot.buckets.plannedKWh[1]).toBeCloseTo(previousPlan[1], 6);
  });

  it('updates the learned profile on day rollover', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 8,
      priceShapingEnabled: false,
    };
    const previousKey = '2024-01-14';
    const previousStart = getDateKeyStartMs(previousKey, TZ);
    const previousBucketKey = new Date(previousStart).toISOString();
    manager.loadState({
      dateKey: previousKey,
      dayStartUtcMs: previousStart,
      profile: {
        weights: buildDefaultProfile(),
        sampleCount: 0,
      },
    });
    manager.update({
      nowMs: Date.UTC(2024, 0, 15, 1, 0),
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [previousBucketKey]: 4 } },
      priceOptimizationEnabled: false,
    });
    const nextState = manager.exportState();
    expect(nextState.profile?.sampleCount).toBe(1);
    expect(nextState.profile?.weights[0]).toBeCloseTo(1, 3);
  });
});

describe('daily budget price shaping', () => {
  it('weights cheaper hours higher within clamp limits', () => {
    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    const bucketStartUtcMs = [dayStart, dayStart + 60 * 60 * 1000];
    const priceData = {
      prices: [
        { startsAt: new Date(bucketStartUtcMs[0]).toISOString(), total: 10 },
        { startsAt: new Date(bucketStartUtcMs[1]).toISOString(), total: 100 },
      ],
    };
    const result = buildPriceFactors({
      bucketStartUtcMs,
      currentBucketIndex: 0,
      combinedPrices: priceData,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });
    expect(result.priceShapingActive).toBe(true);
    expect(result.priceFactors?.[0]).toBeGreaterThan(result.priceFactors?.[1] ?? 0);
    expect(result.priceFactors?.[0]).toBeLessThanOrEqual(1.3);
    expect(result.priceFactors?.[0]).toBeGreaterThanOrEqual(0.7);
  });
});

describe('daily budget preview', () => {
  it('builds a tomorrow preview without a current bucket', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 24,
      priceShapingEnabled: false,
    };
    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    const preview = manager.buildPreview({
      dayStartUtcMs: dayStart,
      timeZone: TZ,
      settings,
      priceOptimizationEnabled: false,
    });

    expect(preview.currentBucketIndex).toBe(-1);
    expect(preview.state.allowedNowKWh).toBe(0);
    const plannedTotal = preview.buckets.plannedKWh.reduce((sum, value) => sum + value, 0);
    expect(plannedTotal).toBeCloseTo(settings.dailyBudgetKWh, 6);
  });
});

describe('daily budget exceeded state', () => {
  it('freezes when usage exceeds the allowed curve', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 1,
      priceShapingEnabled: false,
    };
    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    const bucketKey = new Date(dayStart).toISOString();
    const update = manager.update({
      nowMs: dayStart + 10 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 2 } },
      priceOptimizationEnabled: false,
    });
    expect(update.snapshot.state.exceeded).toBe(true);
    expect(update.snapshot.state.frozen).toBe(true);
  });

  it('unfreezes once usage returns under plan', () => {
    const manager = buildManager();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    };
    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    const bucketKey = new Date(dayStart).toISOString();
    const nextBucketKey = new Date(dayStart + 60 * 60 * 1000).toISOString();

    manager.loadState({
      profile: {
        weights: normalizeWeights([0.5, 0.5, ...Array.from({ length: 22 }, () => 0)]),
        sampleCount: 14,
      },
    });

    manager.update({
      nowMs: dayStart + 5 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0 } },
      priceOptimizationEnabled: false,
    });

    const overUpdate = manager.update({
      nowMs: dayStart + 30 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 6 } },
      priceOptimizationEnabled: false,
    });
    expect(overUpdate.snapshot.state.frozen).toBe(true);

    const underUpdate = manager.update({
      nowMs: dayStart + 60 * 60 * 1000 + 12 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 6, [nextBucketKey]: 0 } },
      priceOptimizationEnabled: false,
    });

    expect(underUpdate.snapshot.state.frozen).toBe(false);
  });
});

describe('daily budget profile learning math', () => {
  let manager: ReturnType<typeof buildManager>;
  const settings = {
    enabled: true,
    dailyBudgetKWh: 10,
    priceShapingEnabled: false,
  };
  const PREVIOUS_DATE_KEY = '2024-01-14';

  beforeEach(() => {
    manager = buildManager();
  });

  it('learns usage pattern from a single day', () => {
    const previousStart = getDateKeyStartMs(PREVIOUS_DATE_KEY, TZ);
    // Create bucket keys for hours 18 and 3
    const bucket18 = new Date(previousStart + 18 * 60 * 60 * 1000).toISOString();
    const bucket3 = new Date(previousStart + 3 * 60 * 60 * 1000).toISOString();

    manager.loadState({
      dateKey: PREVIOUS_DATE_KEY,
      dayStartUtcMs: previousStart,
      profile: {
        weights: buildDefaultProfile(),
        sampleCount: 0,
      },
    });

    // Simulate rollover with usage spike at hour 18, small usage at hour 3
    manager.update({
      nowMs: Date.UTC(2024, 0, 15, 1, 0),
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucket18]: 8, [bucket3]: 1 } },
      priceOptimizationEnabled: false,
    });

    const nextState = manager.exportState();
    expect(nextState.profile?.sampleCount).toBe(1);
    // Hour 18 should have high weight, hour 3 should have low weight
    expect(nextState.profile?.weights[18]).toBeGreaterThan(nextState.profile?.weights[3] ?? 0);
    // With only one sample, weights should directly reflect usage pattern
    // 8 / 9 = 0.889 for hour 18, 1 / 9 = 0.111 for hour 3
    expect(nextState.profile?.weights[18]).toBeCloseTo(8 / 9, 3);
    expect(nextState.profile?.weights[3]).toBeCloseTo(1 / 9, 3);
  });

  it('averages usage patterns across multiple days using cumulative formula', () => {
    // Start with a profile weighted towards hour 10
    const initialWeights = Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 1 : 0));
    manager.loadState({
      dateKey: PREVIOUS_DATE_KEY,
      dayStartUtcMs: getDateKeyStartMs(PREVIOUS_DATE_KEY, TZ),
      profile: {
        weights: normalizeWeights(initialWeights),
        sampleCount: 4,
      },
    });

    // New day with ALL usage at hour 20
    const previousStart = getDateKeyStartMs(PREVIOUS_DATE_KEY, TZ);
    const bucket20 = new Date(previousStart + 20 * 60 * 60 * 1000).toISOString();

    manager.update({
      nowMs: Date.UTC(2024, 0, 15, 1, 0),
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucket20]: 5 } },
      priceOptimizationEnabled: false,
    });

    const nextState = manager.exportState();
    expect(nextState.profile?.sampleCount).toBe(5);

    // Cumulative average: (oldWeight * 4 + newWeight) / 5
    // Hour 10: (1.0 * 4 + 0) / 5 = 0.8
    // Hour 20: (0.0 * 4 + 1) / 5 = 0.2
    // After normalization, hour 10 should still be dominant
    const weights = nextState.profile?.weights ?? [];
    expect(weights[10]).toBeGreaterThan(weights[20]);
    // Verify the ratio: hour10 / hour20 should be approximately 4:1
    expect(weights[10] / weights[20]).toBeCloseTo(4, 0);
  });

  it('dampens single day outliers when history exists', () => {
    // Profile with 9 samples, evenly distributed
    const evenWeights = normalizeWeights(Array.from({ length: 24 }, () => 1));
    manager.loadState({
      dateKey: PREVIOUS_DATE_KEY,
      dayStartUtcMs: getDateKeyStartMs(PREVIOUS_DATE_KEY, TZ),
      profile: {
        weights: evenWeights,
        sampleCount: 9,
      },
    });

    // Massive outlier: single-hour usage (100 kWh) dominates the daily pattern
    const previousStart = getDateKeyStartMs(PREVIOUS_DATE_KEY, TZ);
    const bucket18 = new Date(previousStart + 18 * 60 * 60 * 1000).toISOString();

    manager.update({
      nowMs: Date.UTC(2024, 0, 15, 1, 0),
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucket18]: 100 } },
      priceOptimizationEnabled: false,
    });

    const nextState = manager.exportState();
    expect(nextState.profile?.sampleCount).toBe(10);

    // Hour 18 should only increase by ~10% (1/10th contribution)
    // Original: 1/24, new day: 1.0, next: (1/24 * 9 + 1) / 10 = 0.1375
    // All other hours: (1/24 * 9 + 0) / 10 = 0.0375
    const weights = nextState.profile?.weights ?? [];
    const expectedHour18 = ((1 / 24) * 9 + 1) / 10;
    const expectedOther = ((1 / 24) * 9 + 0) / 10;
    // After normalization, hour 18 should be higher but not dominating
    expect(weights[18]).toBeGreaterThan(weights[0]);
    // The ratio should be approximately expectedHour18 / expectedOther ≈ 3.67
    expect(weights[18] / weights[0]).toBeCloseTo(expectedHour18 / expectedOther, 1);
  });
});

describe('daily budget plan allocation math', () => {
  let manager: ReturnType<typeof buildManager>;
  const settings = {
    enabled: true,
    dailyBudgetKWh: 10,
    priceShapingEnabled: false,
  };
  const PRECISION_EPSILON = 1e-6;

  beforeEach(() => {
    manager = buildManager();
  });

  it('distributes remaining budget proportionally to profile weights', () => {
    // Profile with weights concentrated in first 3 hours: [0.5, 0.3, 0.2]
    const weights = [0.5, 0.3, 0.2, ...Array.from({ length: 21 }, () => 0)];
    manager.loadState({
      profile: {
        weights: normalizeWeights(weights),
        sampleCount: 14,
      },
    });

    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    const bucketKey = new Date(dayStart).toISOString();

    const update = manager.update({
      nowMs: dayStart + 5 * 60 * 1000, // 5 minutes into first bucket
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0 } },
      priceOptimizationEnabled: false,
    });

    const planned = update.snapshot.buckets.plannedKWh;
    // Should distribute 10 kWh as [5, 3, 2] based on weights
    expect(planned[0]).toBeCloseTo(5, 1);
    expect(planned[1]).toBeCloseTo(3, 1);
    expect(planned[2]).toBeCloseTo(2, 1);
  });

  it('redistributes overflow when capacity cap is hit', () => {
    // Profile wants 80% in first hour (8 kWh) but cap is 2 kWh
    const weights = [0.8, 0.1, 0.1, ...Array.from({ length: 21 }, () => 0)];
    manager.loadState({
      profile: {
        weights: normalizeWeights(weights),
        sampleCount: 14,
      },
    });

    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    const bucketKey = new Date(dayStart).toISOString();

    const update = manager.update({
      nowMs: dayStart + 5 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0 } },
      priceOptimizationEnabled: false,
      capacityBudgetKWh: 2,
    });

    const planned = update.snapshot.buckets.plannedKWh;
    // Hour 0 should be capped at 2 kWh (with tolerance for floating point)
    expect(planned[0]).toBeLessThanOrEqual(2 + PRECISION_EPSILON);
    // Total should still sum to budget
    const total = planned.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(10, 1);
  });

  it('uses blended weights for future buckets when previous plan exists', () => {
    const settings = {
      enabled: true,
      dailyBudgetKWh: 24,
      priceShapingEnabled: false,
    };
    // Flat profile: 1 kWh per hour
    const flatWeights = normalizeWeights(Array.from({ length: 24 }, () => 1));
    // Previous plan with 2 kWh at hour 10, 1 kWh elsewhere
    const previousPlan = Array.from({ length: 24 }, (_, i) => (i === 10 ? 2 : 1));
    // Flat plan would allocate 1 kWh per hour (24 kWh / 24 hours)
    const flatPlanHour10 = 1;
    // Previous plan has 2 kWh at hour 10
    const previousPlanHour10 = 2;
    // The implementation blends normalized weight distributions derived from the
    // previous plan with newly computed weights, then scales to the remaining budget.
    // This causes hour 10 to land between the flat and previous allocations,
    // biased towards the previous plan due to the 70/30 blend ratio.

    const dayStart = getDateKeyStartMs('2024-01-15', TZ);
    manager.loadState({
      dateKey: '2024-01-15',
      dayStartUtcMs: dayStart,
      plannedKWh: previousPlan,
      profile: {
        weights: flatWeights,
        sampleCount: 14,
      },
    });

    const bucketKey = new Date(dayStart).toISOString();
    const update = manager.update({
      nowMs: dayStart + 5 * 60 * 1000,
      timeZone: TZ,
      settings,
      powerTracker: { buckets: { [bucketKey]: 0 } },
      priceOptimizationEnabled: false,
      forcePlanRebuild: true,
    });

    const planned = update.snapshot.buckets.plannedKWh;
    // Hour 10 should be blended: strictly between flat (1) and previous (2)
    // The 70/30 blend means it should be closer to 2 than to 1
    expect(planned[10]).toBeGreaterThan(flatPlanHour10);
    expect(planned[10]).toBeLessThan(previousPlanHour10);
    // Verify it's closer to previous than to flat (due to 70/30 weighting)
    const distanceToFlat = planned[10] - flatPlanHour10;
    const distanceToPrevious = previousPlanHour10 - planned[10];
    expect(distanceToFlat).toBeGreaterThan(distanceToPrevious);
  });
});

describe('daily budget default profile shape', () => {
  const profile = buildDefaultProfile();

  it('has evening peak higher than night hours', () => {
    expect(profile).toHaveLength(24);
    // Hour 19 (7 PM) should be higher than hour 3 (3 AM)
    expect(profile[19]).toBeGreaterThan(profile[3] * 1.5);
  });

  it('has morning peak higher than night hours', () => {
    // Hour 7 (7 AM) should be higher than hour 3 (3 AM)
    expect(profile[7]).toBeGreaterThan(profile[3]);
  });

  it('has highest weight in evening hours', () => {
    // Find the maximum weight and its index
    const maxWeight = Math.max(...profile);
    const maxIndex = profile.indexOf(maxWeight);
    // Peak should be in evening hours (17-22)
    expect(maxIndex).toBeGreaterThanOrEqual(17);
    expect(maxIndex).toBeLessThanOrEqual(22);
  });
});
