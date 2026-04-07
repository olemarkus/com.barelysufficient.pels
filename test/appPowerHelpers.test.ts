const addPerfDurationMock = jest.fn();

jest.mock('../lib/utils/perfCounters', () => {
  const actual = jest.requireActual('../lib/utils/perfCounters');
  return {
    ...actual,
    addPerfDuration: (...args: unknown[]) => addPerfDurationMock(...args),
  };
});

import CapacityGuard from '../lib/core/capacityGuard';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PowerSampleRebuildState } from '../lib/app/appPowerHelpers';
import {
  recordDailyBudgetCap,
  recordPowerSampleForApp,
  schedulePlanRebuildFromPowerSample,
  schedulePlanRebuildFromSignal,
} from '../lib/app/appPowerHelpers';

const createCapacityGuardMock = (params: {
  limitKw?: number;
  marginKw?: number;
  softLimitKw?: number;
  totalPowerKw?: number;
} = {}): CapacityGuard => {
  const {
    limitKw = 10,
    marginKw = 0.5,
    softLimitKw = limitKw - marginKw,
    totalPowerKw,
  } = params;
  const capacityGuard = new CapacityGuard({ limitKw, softMarginKw: marginKw });
  capacityGuard.setSoftLimitProvider(() => softLimitKw);
  if (typeof totalPowerKw === 'number') {
    capacityGuard.reportTotalPower(totalPowerKw);
  }
  return capacityGuard;
};

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
    addPerfDurationMock.mockReset();
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

  it('does not rebuild only because the soft limit changes', async () => {
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

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(state.lastSoftLimitKw).toBe(8);
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

  it('clears pending sample values after timed rebuild completes', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 1000, lastSoftLimitKw: 9 };
    let resolveRebuild: (() => void) | undefined;
    const rebuildPlanFromCache = jest.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRebuild = resolve;
      }),
    );
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
      currentPowerW: 1100,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 7.9,
    });

    jest.advanceTimersByTime(1000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    const second = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 1300,
      limitKw: 10,
      softLimitKw: 8.7,
      headroomKw: 7.4,
    });

    expect(second).toBe(first);
    expect(state.pendingPowerW).toBe(1300);
    expect(state.pendingSoftLimitKw).toBe(8.7);

    resolveRebuild?.();
    await first;

    expect(logError).not.toHaveBeenCalled();
    expect(state.pending).toBeUndefined();
    expect(state.pendingReason).toBeUndefined();
    expect(state.pendingPowerW).toBeUndefined();
    expect(state.pendingSoftLimitKw).toBeUndefined();
  });

  it('cancels pending timer and performs an immediate rebuild when interval is exceeded', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 1000, lastSoftLimitKw: 9 };
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
      currentPowerW: 1100,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 7.9,
    });

    expect(state.pending).toBeDefined();
    state = { ...state, lastMs: Date.now() - 2000 };

    const second = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 1300,
      limitKw: 10,
      softLimitKw: 8.8,
      headroomKw: 7.4,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    await second;
    await first;

    jest.advanceTimersByTime(1000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(state.pending).toBeUndefined();
    expect(state.timer).toBeUndefined();
  });
});

describe('schedulePlanRebuildFromSignal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the stable interval for non-urgent power deltas', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 5000, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 5.3 }),
    });

    jest.advanceTimersByTime(14999);
    await Promise.resolve();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await pending;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('bypasses the stable interval when headroom is tight', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9300, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = jest.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 9.6 }),
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('records rebuild timing after the async rebuild settles', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9300, lastSoftLimitKw: 9.5 };
    let resolveRebuild: (() => void) | undefined;
    const rebuildPlanFromCache = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveRebuild = resolve;
    }));

    const pending = schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: jest.fn(),
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 9.6 }),
    });

    expect(addPerfDurationMock).not.toHaveBeenCalledWith('power_sample_rebuild_ms', expect.any(Number));

    jest.advanceTimersByTime(25);
    resolveRebuild?.();
    await pending;

    expect(addPerfDurationMock).toHaveBeenCalledWith('power_sample_rebuild_ms', 25);
  });
});

describe('recordPowerSampleForApp', () => {
  it('records measured budget exempt usage into exempt buckets', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        id: 'dev-budget',
        name: 'Budget exempt heater',
        targets: [],
        measuredPowerKw: 0.4,
        budgetExempt: true,
      },
      {
        id: 'dev-other',
        name: 'Other heater',
        targets: [],
        measuredPowerKw: 0.6,
        budgetExempt: false,
      },
    ]);

    await recordPowerSampleForApp({
      currentPowerW: 1000,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,

      schedulePlanRebuild: jest.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    await recordPowerSampleForApp({
      currentPowerW: 1000,
      nowMs: start + 30 * 60 * 1000,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,

      schedulePlanRebuild: jest.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBeCloseTo(0.2, 3);
  });

  it('falls back to expected power for live budget exempt usage when measured power is unavailable', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        id: 'dev-budget',
        name: 'Budget exempt heater',
        targets: [],
        expectedPowerKw: 0.8,
        budgetExempt: true,
      },
    ]);

    await recordPowerSampleForApp({
      currentPowerW: 800,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,

      schedulePlanRebuild: jest.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    await recordPowerSampleForApp({
      currentPowerW: 800,
      nowMs: start + 30 * 60 * 1000,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,

      schedulePlanRebuild: jest.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBeCloseTo(0.4, 3);
  });

  it('does not record budget-exempt buckets for devices with capacity control disabled', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        id: 'dev-budget',
        name: 'Budget exempt heater',
        targets: [],
        measuredPowerKw: 0.8,
        budgetExempt: true,
        controllable: false,
      },
    ]);

    await recordPowerSampleForApp({
      currentPowerW: 800,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,

      schedulePlanRebuild: jest.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    await recordPowerSampleForApp({
      currentPowerW: 800,
      nowMs: start + 30 * 60 * 1000,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,

      schedulePlanRebuild: jest.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBe(0);
  });
});
