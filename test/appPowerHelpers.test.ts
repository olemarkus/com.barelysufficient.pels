import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PowerSampleRebuildState } from '../lib/app/appPowerHelpers';
import CapacityGuard from '../lib/core/capacityGuard';
import { applyPowerDeltaToTracker, recordDailyBudgetCap, schedulePlanRebuildFromPowerSample } from '../lib/app/appPowerHelpers';

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
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 1000,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 8,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastMs).toBe(Date.now());
    expect(state.pending).toBeUndefined();
  });

  it('schedules and coalesces rebuilds when called too soon', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);
    const logError = jest.fn();

    const first = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 1000,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 8,
    });
    const second = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 1200,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 7.8,
    });

    expect(second).toBe(first);
    jest.advanceTimersByTime(1000);
    await first;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(state.pending).toBeUndefined();
  });

  it('creates a pending rebuild when within the min interval', () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 1000,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 8,
    });

    expect(pending).toBe(state.pending);
    expect(state.timer).toBeDefined();
    jest.clearAllTimers();
  });

  it('logs errors from scheduled rebuilds', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = jest.fn().mockRejectedValue(new Error('boom'));
    const logError = jest.fn();

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 1000,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 8,
    });

    jest.advanceTimersByTime(1000);
    await pending;

    expect(logError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('skips rebuild when power change is below threshold and soft limit is stable', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 5050,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 3.95,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds when soft limit changes meaningfully', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 8 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 5000,
      limitKw: 10,
      softLimitKw: 8.2,
      headroomKw: 3.2,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastSoftLimitKw).toBe(8.2);
  });

  it('rebuilds in danger zone regardless of delta', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 9000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 9050,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 0.95,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastRebuildPowerW).toBe(9050);
  });

  it('rebuilds after max interval even if delta is small', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 20000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 5050,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 3.95,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('uses last rebuild power when current power is missing', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      powerDeltaW: 200,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 4,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastRebuildPowerW).toBe(5000);
  });

  it('keeps last soft limit when soft limit is missing', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 8 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 5200,
      powerDeltaW: 200,
      limitKw: 10,
      headroomKw: 2.8,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastSoftLimitKw).toBe(8);
  });
});

describe('applyPowerDeltaToTracker', () => {
  it('returns the same state when delta is invalid', () => {
    const state: PowerTrackerState = { lastPowerW: 1000 };
    const result = applyPowerDeltaToTracker({ powerTracker: state, deltaKw: Number.NaN });
    expect(result).toBe(state);
  });

  it('uses lastPowerW when available', () => {
    const state: PowerTrackerState = { lastPowerW: 5000 };
    const guard = new CapacityGuard({ limitKw: 10, softMarginKw: 0.5, log: jest.fn() });
    const result = applyPowerDeltaToTracker({ powerTracker: state, capacityGuard: guard, deltaKw: -1 });
    expect(result).not.toBe(state);
    expect(result.lastPowerW).toBe(4000);
    expect(guard.getLastTotalPower()).toBeCloseTo(4, 5);
  });

  it('falls back to capacity guard total power when tracker is missing', () => {
    const state: PowerTrackerState = {};
    const guard = new CapacityGuard({ limitKw: 10, softMarginKw: 0.5, log: jest.fn() });
    guard.reportTotalPower(3);
    const result = applyPowerDeltaToTracker({ powerTracker: state, capacityGuard: guard, deltaKw: 0.25 });
    expect(result.lastPowerW).toBe(3250);
    expect(guard.getLastTotalPower()).toBeCloseTo(3.25, 5);
  });

  it('returns the same state when no base power is available', () => {
    const state: PowerTrackerState = {};
    const result = applyPowerDeltaToTracker({ powerTracker: state, deltaKw: 1 });
    expect(result).toBe(state);
  });
});
