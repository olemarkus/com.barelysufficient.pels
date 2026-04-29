import {
  buildBucketUsage,
  buildBudgetUsageViews,
  buildDailyBudgetSnapshot,
  buildDayContext,
} from '../lib/dailyBudget/dailyBudgetState';
import type { BudgetState, DayContext } from '../lib/dailyBudget/dailyBudgetState';
import type { DailyBudgetSettings } from '../lib/dailyBudget/dailyBudgetTypes';

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

    expect(result.bucketUsageControlled).toEqual([2, 0]);
    expect(result.bucketUsageUncontrolled).toEqual([2, 4]);
    expect(result.bucketUsageExempt).toEqual([1, 1.5]);
  });

  it('buildBucketUsage falls back to fully uncontrolled usage when controlled data is missing', () => {
    const dayStart = Date.UTC(2024, 0, 1, 0, 0, 0);
    const bucketStartUtcMs = [dayStart];
    const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());

    const result = buildBucketUsage({
      bucketStartUtcMs,
      powerTracker: {
        buckets: {
          [bucketKeys[0]]: 4,
        },
        uncontrolledBuckets: {
          [bucketKeys[0]]: 1,
        },
        exemptBuckets: {
          [bucketKeys[0]]: 1.5,
        },
      },
    });

    expect(result.bucketUsageControlled).toEqual([0]);
    expect(result.bucketUsageUncontrolled).toEqual([4]);
    expect(result.bucketUsageExempt).toEqual([1.5]);
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

  it('buildBudgetUsageViews clamps exempt reductions for budget control math', () => {
    const result = buildBudgetUsageViews({
      bucketUsage: [2, 1, 0],
      bucketUsageExempt: [0.5, 2, 1],
    });

    expect(result.budgetControlBucketUsage).toEqual([1.5, 0, 0]);
    expect(result.meteredUsedNowKWh).toBeCloseTo(3, 6);
    expect(result.exemptUsedNowKWh).toBeCloseTo(1.5, 6);
    expect(result.usedNowKWh).toBeCloseTo(3, 6);
    expect(result.budgetControlUsedNowKWh).toBeCloseTo(1.5, 6);
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

  it('does not report allocation pressure for already consumed budget', () => {
    const context = buildSnapshotContext({
      currentBucketIndex: 2,
      budgetControlBucketUsage: [8, 8, 0, 0],
      budgetControlUsedNowKWh: 20,
      usedNowKWh: 20,
    });
    const snapshot = buildDailyBudgetSnapshot({
      context,
      settings: buildSettings({ dailyBudgetKWh: 24 }),
      enabled: true,
      plannedKWh: [0, 0, 2, 2],
      priceData: { priceShapingActive: true },
      budget: buildBudgetState({ remainingKWh: 4 }),
      frozen: false,
    });

    expect(snapshot.state.allocationPressure).toMatchObject({
      requestedBudgetKWh: 4,
      plannedBudgetKWh: 4,
      unallocatedBudgetKWh: 0,
      constrained: false,
    });
  });

  it('reports allocation pressure when remaining budget cannot fit into caps', () => {
    const context = buildSnapshotContext({
      currentBucketIndex: 2,
      budgetControlBucketUsage: [0, 0, 1, 0],
      budgetControlUsedNowKWh: 2,
      usedNowKWh: 2,
    });
    const snapshot = buildDailyBudgetSnapshot({
      context,
      settings: buildSettings({ dailyBudgetKWh: 12 }),
      enabled: true,
      plannedKWh: [0, 0, 3, 2],
      priceData: { priceShapingActive: true },
      budget: buildBudgetState({ remainingKWh: 10 }),
      frozen: false,
    });

    expect(snapshot.state.allocationPressure).toMatchObject({
      requestedBudgetKWh: 10,
      plannedBudgetKWh: 4,
      unallocatedBudgetKWh: 6,
      constrained: true,
    });
  });

  it('bases allocation pressure on budget-control remaining budget with exempt usage', () => {
    const context = buildSnapshotContext({
      currentBucketIndex: 2,
      budgetControlBucketUsage: [0, 0, 1, 0],
      budgetControlUsedNowKWh: 2,
      usedNowKWh: 8,
    });
    const snapshot = buildDailyBudgetSnapshot({
      context,
      settings: buildSettings({ dailyBudgetKWh: 12 }),
      enabled: true,
      plannedKWh: [0, 0, 3, 2],
      priceData: { priceShapingActive: true },
      budget: buildBudgetState({ remainingKWh: 4 }),
      frozen: false,
    });

    expect(snapshot.state.allocationPressure).toMatchObject({
      requestedBudgetKWh: 10,
      plannedBudgetKWh: 4,
      unallocatedBudgetKWh: 6,
      constrained: true,
    });
  });

  it('does not report allocation pressure after the day has ended', () => {
    const context = buildSnapshotContext({
      currentBucketIndex: 4,
      budgetControlBucketUsage: [2, 2, 2, 2],
      usedNowKWh: 8,
    });
    const snapshot = buildDailyBudgetSnapshot({
      context,
      settings: buildSettings({ dailyBudgetKWh: 12 }),
      enabled: true,
      plannedKWh: [2, 2, 2, 2],
      priceData: { priceShapingActive: false },
      budget: buildBudgetState({ remainingKWh: 4 }),
      frozen: false,
    });

    expect(snapshot.state.allocationPressure).toMatchObject({
      requestedBudgetKWh: 0,
      plannedBudgetKWh: 0,
      unallocatedBudgetKWh: 0,
      constrained: false,
    });
  });
});

function buildSettings(overrides: Partial<DailyBudgetSettings> = {}): DailyBudgetSettings {
  return {
    enabled: true,
    dailyBudgetKWh: 24,
    priceShapingEnabled: true,
    controlledUsageWeight: 0,
    priceShapingFlexShare: 1,
    ...overrides,
  };
}

function buildBudgetState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    plannedWeight: [],
    allowedCumKWh: [],
    allowedNowKWh: 0,
    remainingKWh: 0,
    deviationKWh: 0,
    exceeded: false,
    confidence: 1,
    profileBlendConfidence: 1,
    ...overrides,
  };
}

function buildSnapshotContext(overrides: Partial<DayContext> = {}): DayContext {
  const dayStartUtcMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const hourMs = 60 * 60 * 1000;
  const bucketStartUtcMs = [0, 1, 2, 3].map((hour) => dayStartUtcMs + hour * hourMs);
  const bucketUsage = [0, 0, 0, 0];
  const budgetControlBucketUsage = overrides.budgetControlBucketUsage ?? bucketUsage;
  return {
    nowMs: dayStartUtcMs + 2 * hourMs,
    timeZone: 'UTC',
    dateKey: '2024-01-01',
    dayStartUtcMs,
    bucketStartUtcMs,
    bucketStartLocalLabels: ['00:00', '01:00', '02:00', '03:00'],
    bucketKeys: bucketStartUtcMs.map((ts) => new Date(ts).toISOString()),
    currentBucketIndex: 0,
    currentBucketProgress: 0,
    bucketUsage,
    budgetControlBucketUsage,
    usedNowKWh: 0,
    budgetControlUsedNowKWh: 0,
    meteredUsedNowKWh: 0,
    exemptUsedNowKWh: 0,
    currentBucketUsage: 0,
    ...overrides,
  };
}
