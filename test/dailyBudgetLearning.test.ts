import {
  buildBucketUsageSplit,
  finalizePreviousDayLearning,
  hasUnreliableOverlap,
} from '../lib/dailyBudget/dailyBudgetLearning';
import { buildDefaultProfile } from '../lib/dailyBudget/dailyBudgetManager';
import {
  buildLocalDayBuckets,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../lib/utils/dateUtils';

describe('daily budget learning DST handling', () => {
  it('aggregates repeated fall-back hour buckets into the same local hour', () => {
    const timeZone = 'Europe/Oslo';
    const previousDateKey = '2024-10-27';
    const previousDayStartUtcMs = getDateKeyStartMs(previousDateKey, timeZone);
    const nextDayStartUtcMs = getNextLocalDayStartUtcMs(previousDayStartUtcMs, timeZone);
    const { bucketStartUtcMs } = buildLocalDayBuckets({
      dayStartUtcMs: previousDayStartUtcMs,
      nextDayStartUtcMs,
      timeZone,
    });

    const hour2Indexes = bucketStartUtcMs
      .map((ts, index) => ({
        index,
        hour: getZonedParts(new Date(ts), timeZone).hour,
      }))
      .filter((entry) => entry.hour === 2)
      .map((entry) => entry.index);

    expect(hour2Indexes.length).toBe(2);

    const buckets: Record<string, number> = {};
    const [firstIndex, secondIndex] = hour2Indexes;
    buckets[new Date(bucketStartUtcMs[firstIndex]).toISOString()] = 1;
    buckets[new Date(bucketStartUtcMs[secondIndex]).toISOString()] = 2;

    const result = finalizePreviousDayLearning({
      state: {
        profileUncontrolled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlledShare: 0,
        profileSampleCount: 0,
        profileSplitSampleCount: 0,
      },
      timeZone,
      powerTracker: {
        buckets,
      },
      previousDateKey,
      previousDayStartUtcMs,
      defaultProfile: buildDefaultProfile(),
    });

    const { nextState } = result;
    const weights = nextState.profileUncontrolled?.weights ?? [];
    expect(nextState.profileSampleCount).toBe(1);
    expect(nextState.profileControlledShare).toBeCloseTo(0, 6);
    expect(weights[2]).toBeCloseTo(1, 6);
    expect(weights[1]).toBeCloseTo(0, 6);
    expect(weights[3]).toBeCloseTo(0, 6);
  });
});

describe('daily budget learning utilities', () => {
  it('buildBucketUsageSplit clamps negatives and controlled over total', () => {
    const timeZone = 'UTC';
    const dateKey = '2024-01-14';
    const dayStart = getDateKeyStartMs(dateKey, timeZone);
    const bucketStartUtcMs = [dayStart, dayStart + 60 * 60 * 1000, dayStart + 2 * 60 * 60 * 1000];
    const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());

    const result = buildBucketUsageSplit({
      bucketStartUtcMs,
      powerTracker: {
        buckets: {
          [bucketKeys[0]]: -5,
          [bucketKeys[1]]: 3,
          [bucketKeys[2]]: 0.5,
        },
        controlledBuckets: {
          [bucketKeys[0]]: 2,
          [bucketKeys[1]]: 5,
          [bucketKeys[2]]: -1,
        },
      },
    });

    expect(result.bucketUsageUncontrolled).toEqual([0, 0, 0.5]);
    expect(result.bucketUsageControlled).toEqual([0, 3, 0]);
    expect(result.usedControlledData).toBe(true);
    expect(result.hasTotalData).toBe(true);
  });

  it('hasUnreliableOverlap handles boundary and overlap cases', () => {
    expect(hasUnreliableOverlap({
      startUtcMs: 0,
      endUtcMs: 100,
      unreliablePeriods: [{ start: 100, end: 200 }],
    })).toBe(false);

    expect(hasUnreliableOverlap({
      startUtcMs: 0,
      endUtcMs: 100,
      unreliablePeriods: [{ start: 50, end: 150 }],
    })).toBe(true);

    expect(hasUnreliableOverlap({
      startUtcMs: 0,
      endUtcMs: 100,
      unreliablePeriods: [{ start: 10, end: 20 }, { start: 80, end: 120 }],
    })).toBe(true);

    expect(hasUnreliableOverlap({
      startUtcMs: 0,
      endUtcMs: 100,
      unreliablePeriods: [{ start: -50, end: 0 }],
    })).toBe(false);
  });

  it('finalizePreviousDayLearning skips when totals are missing', () => {
    const timeZone = 'UTC';
    const previousDateKey = '2024-01-14';
    const previousDayStartUtcMs = getDateKeyStartMs(previousDateKey, timeZone);
    const result = finalizePreviousDayLearning({
      state: {
        profileUncontrolled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlledShare: 0,
        profileSampleCount: 0,
        profileSplitSampleCount: 0,
        frozen: true,
        lastPlanBucketStartUtcMs: 123,
        plannedKWh: [1, 2],
      },
      timeZone,
      powerTracker: {},
      previousDateKey,
      previousDayStartUtcMs,
      defaultProfile: buildDefaultProfile(),
    });

    expect(result.shouldMarkDirty).toBe(true);
    expect(result.logMessage).toContain('missing totals');
    expect(result.nextState.frozen).toBe(false);
    expect(result.nextState.lastPlanBucketStartUtcMs).toBeNull();
    expect(result.nextState.plannedKWh).toEqual([]);
  });

  it('finalizePreviousDayLearning skips when total kWh is zero', () => {
    const timeZone = 'UTC';
    const previousDateKey = '2024-01-14';
    const previousDayStartUtcMs = getDateKeyStartMs(previousDateKey, timeZone);
    const bucketKey = new Date(previousDayStartUtcMs).toISOString();
    const result = finalizePreviousDayLearning({
      state: {
        profileUncontrolled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlledShare: 0,
        profileSampleCount: 0,
        profileSplitSampleCount: 0,
        frozen: true,
        lastPlanBucketStartUtcMs: 123,
        plannedKWh: [1, 2],
      },
      timeZone,
      powerTracker: {
        buckets: {
          [bucketKey]: 0,
        },
      },
      previousDateKey,
      previousDayStartUtcMs,
      defaultProfile: buildDefaultProfile(),
    });

    expect(result.shouldMarkDirty).toBe(true);
    expect(result.logMessage).toContain('0 kWh');
    expect(result.nextState.frozen).toBe(false);
    expect(result.nextState.lastPlanBucketStartUtcMs).toBeNull();
    expect(result.nextState.plannedKWh).toEqual([]);
  });

  it('finalizePreviousDayLearning skips when previous day data is unreliable', () => {
    const timeZone = 'UTC';
    const previousDateKey = '2024-01-14';
    const previousDayStartUtcMs = getDateKeyStartMs(previousDateKey, timeZone);
    const result = finalizePreviousDayLearning({
      state: {
        profileUncontrolled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlled: {
          weights: buildDefaultProfile(),
          sampleCount: 0,
        },
        profileControlledShare: 0,
        profileSampleCount: 0,
        profileSplitSampleCount: 0,
        frozen: true,
        lastPlanBucketStartUtcMs: 123,
        plannedKWh: [1, 2],
      },
      timeZone,
      powerTracker: {
        unreliablePeriods: [
          { start: previousDayStartUtcMs + 10, end: previousDayStartUtcMs + 20 },
        ],
      },
      previousDateKey,
      previousDayStartUtcMs,
      defaultProfile: buildDefaultProfile(),
    });

    expect(result.shouldMarkDirty).toBe(true);
    expect(result.logMessage).toContain('incomplete data');
    expect(result.nextState.frozen).toBe(false);
    expect(result.nextState.lastPlanBucketStartUtcMs).toBeNull();
    expect(result.nextState.plannedKWh).toEqual([]);
  });
});
