import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PowerSampleRebuildState } from '../lib/app/appPowerHelpers';
import { recordDailyBudgetCap, schedulePlanRebuildFromPowerSample } from '../lib/app/appPowerHelpers';

describe('recordDailyBudgetCap', () => {
  it('returns existing state for invalid snapshots', () => {
    const wrapUiPayload = (day: any) => ({
      days: { '2024-01-01': day },
      todayKey: '2024-01-01',
    });
    const cases = [
      null,
      wrapUiPayload({ budget: { enabled: false } }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: 'nope', startUtc: [] }, currentBucketIndex: 0 }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: [1], startUtc: ['2024-01-01T00:00:00.000Z'] }, currentBucketIndex: 2 }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: [Number.NaN], startUtc: ['2024-01-01T00:00:00.000Z'] }, currentBucketIndex: 0 }),
      wrapUiPayload({ budget: { enabled: true }, buckets: { plannedKWh: [1], startUtc: [123] }, currentBucketIndex: 0 }),
    ];

    cases.forEach((snapshot) => {
      const powerTracker: PowerTrackerState = { dailyBudgetCaps: { existing: 1 } };
      const result = recordDailyBudgetCap({ powerTracker, snapshot: snapshot as any });
      expect(result).toBe(powerTracker);
    });
  });

  it('stores the planned cap for the current bucket', () => {
    const bucketKey = '2024-01-01T00:00:00.000Z';
    const powerTracker: PowerTrackerState = { dailyBudgetCaps: { existing: 1 } };
    const snapshot = {
      days: {
        '2024-01-01': {
          budget: { enabled: true },
          buckets: { plannedKWh: [2.5], startUtc: [bucketKey] },
          currentBucketIndex: 0,
        },
      },
      todayKey: '2024-01-01',
    };

    const result = recordDailyBudgetCap({ powerTracker, snapshot: snapshot as any });
    expect(result).not.toBe(powerTracker);
    expect(result.dailyBudgetCaps).toEqual({ existing: 1, [bucketKey]: 2.5 });
  });
});

describe('schedulePlanRebuildFromPowerSample', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rebuilds immediately when interval has elapsed', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      minPowerDeltaW: 0,
      maxIntervalMs: 10000,
      currentPowerW: 1000,
      rebuildPlanFromCache,
      logError: jest.fn(),
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastMs).toBe(Date.now());
    expect(state.pending).toBeUndefined();
  });

  it('schedules and coalesces rebuilds when called too soon', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);
    const logError = jest.fn();

    const first = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      minPowerDeltaW: 0,
      maxIntervalMs: 10000,
      currentPowerW: 1000,
      rebuildPlanFromCache,
      logError,
    });
    const second = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      minPowerDeltaW: 0,
      maxIntervalMs: 10000,
      currentPowerW: 1000,
      rebuildPlanFromCache,
      logError,
    });

    expect(second).toBe(first);
    jest.advanceTimersByTime(1000);
    await first;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(state.pending).toBeUndefined();
  });

  it('logs errors from scheduled rebuilds', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() };
    const rebuildPlanFromCache = jest.fn().mockRejectedValue(new Error('boom'));
    const logError = jest.fn();

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      minPowerDeltaW: 0,
      maxIntervalMs: 10000,
      currentPowerW: 1000,
      rebuildPlanFromCache,
      logError,
    });

    jest.advanceTimersByTime(1000);
    await pending;

    expect(logError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('skips rebuild when power change is below threshold', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastPowerW: 1000 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      minPowerDeltaW: 200,
      maxIntervalMs: 10000,
      currentPowerW: 1100,
      rebuildPlanFromCache,
      logError: jest.fn(),
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});
