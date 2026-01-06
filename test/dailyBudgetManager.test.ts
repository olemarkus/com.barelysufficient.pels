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
