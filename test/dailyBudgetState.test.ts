import { buildBucketUsage, buildDayContext } from '../lib/dailyBudget/dailyBudgetState';

describe('daily budget state helpers', () => {
  it('buildBucketUsage clamps split data to total usage', () => {
    const hourMs = 60 * 60 * 1000;
    const dayStart = Date.UTC(2024, 0, 1, 0, 0, 0);
    const bucketStartUtcMs = [
      dayStart,
      dayStart + hourMs,
      dayStart + 2 * hourMs,
    ];
    const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());

    const result = buildBucketUsage({
      bucketStartUtcMs,
      powerTracker: {
        buckets: {
          [bucketKeys[0]]: 5,
          [bucketKeys[1]]: 3,
          [bucketKeys[2]]: 2,
        },
        controlledBuckets: {
          [bucketKeys[0]]: 4,
          [bucketKeys[1]]: 5,
        },
        uncontrolledBuckets: {
          [bucketKeys[0]]: 4,
          [bucketKeys[2]]: 5,
        },
      },
    });

    expect(result.bucketUsageControlled).toEqual([4, 3, 0]);
    expect(result.bucketUsageUncontrolled).toEqual([1, 0, 2]);
  });

  it('buildBucketUsage treats exempt usage as uncontrolled for budget breakdowns', () => {
    const hourMs = 60 * 60 * 1000;
    const dayStart = Date.UTC(2024, 0, 1, 0, 0, 0);
    const bucketStartUtcMs = [dayStart, dayStart + hourMs];
    const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());

    const result = buildBucketUsage({
      bucketStartUtcMs,
      powerTracker: {
        buckets: {
          [bucketKeys[0]]: 4,
          [bucketKeys[1]]: 4,
        },
        controlledBuckets: {
          [bucketKeys[0]]: 3,
        },
        uncontrolledBuckets: {
          [bucketKeys[1]]: 1,
        },
        exemptBuckets: {
          [bucketKeys[0]]: 1,
          [bucketKeys[1]]: 1.5,
        },
      },
    });

    expect(result.bucketUsageControlled).toEqual([2, 1.5]);
    expect(result.bucketUsageUncontrolled).toEqual([2, 2.5]);
    expect(result.bucketUsageExempt).toEqual([1, 1.5]);
  });

  it('buildBucketUsage omits split arrays when no split data exists', () => {
    const hourMs = 60 * 60 * 1000;
    const dayStart = Date.UTC(2024, 0, 1, 0, 0, 0);
    const bucketStartUtcMs = [dayStart, dayStart + hourMs];
    const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());

    const result = buildBucketUsage({
      bucketStartUtcMs,
      powerTracker: {
        buckets: {
          [bucketKeys[0]]: 1,
          [bucketKeys[1]]: 2,
        },
      },
    });

    expect(result.bucketUsageControlled).toBeUndefined();
    expect(result.bucketUsageUncontrolled).toBeUndefined();
  });

  it('buildDayContext keeps reported usage real while using exempt-adjusted values for budget control', () => {
    const nowMs = Date.UTC(2024, 0, 1, 1, 30, 0);
    const context = buildDayContext({
      nowMs,
      timeZone: 'UTC',
      powerTracker: {
        buckets: {
          '2024-01-01T00:00:00.000Z': 2,
          '2024-01-01T01:00:00.000Z': 1,
        },
        exemptBuckets: {
          '2024-01-01T00:00:00.000Z': 0.5,
          '2024-01-01T01:00:00.000Z': 0.25,
        },
      },
    });

    expect(context.bucketUsage.slice(0, 2)).toEqual([2, 1]);
    expect(context.bucketUsageExempt?.slice(0, 2)).toEqual([0.5, 0.25]);
    expect(context.budgetControlBucketUsage.slice(0, 2)).toEqual([1.5, 0.75]);
    expect(context.meteredUsedNowKWh).toBeCloseTo(3, 6);
    expect(context.exemptUsedNowKWh).toBeCloseTo(0.75, 6);
    expect(context.usedNowKWh).toBeCloseTo(3, 6);
    expect(context.budgetControlUsedNowKWh).toBeCloseTo(2.25, 6);
  });
});
