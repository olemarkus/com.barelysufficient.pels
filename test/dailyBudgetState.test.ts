import { buildBucketUsage } from '../lib/dailyBudget/dailyBudgetState';

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
});
