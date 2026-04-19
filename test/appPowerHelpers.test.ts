const addPerfDurationMock = vi.fn();

vi.mock('../lib/utils/perfCounters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/utils/perfCounters')>();
  return {
    ...actual,
    addPerfDuration: (...args: unknown[]) => addPerfDurationMock(...args),
  };
});

import CapacityGuard from '../lib/core/capacityGuard';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import {
  recordDailyBudgetCap,
  recordPowerSampleForApp,
  type PowerSampleRebuildState,
  schedulePlanRebuildFromPowerSample,
  schedulePlanRebuildFromSignal,
} from '../lib/app/appPowerHelpers';
import { PlanRebuildScheduler } from '../lib/app/planRebuildScheduler';
import { getPerfSnapshot } from '../lib/utils/perfCounters';

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    addPerfDurationMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds immediately when a control boundary is already crossed', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastMs).toBe(Date.now());
    expect(state.pending).toBeUndefined();
  });

  it('schedules and coalesces rebuilds when a boundary sample arrives too soon', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();

    const first = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
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
      currentPowerW: 9700,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.7,
    });

    expect(second).toBe(first);
    vi.advanceTimersByTime(1000);
    await first;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(state.pending).toBeUndefined();
  });

  it('uses the latest coalesced sample values when a timed rebuild fires', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9700,
      limitKw: 10,
      softLimitKw: 8.7,
      headroomKw: -0.7,
    });

    vi.advanceTimersByTime(1000);
    await pending;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastRebuildPowerW).toBe(9700);
    expect(state.lastSoftLimitKw).toBe(8.7);
  });

  it('creates a pending rebuild when a boundary sample arrives within the min interval', () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    expect(pending).toBe(state.pending);
    expect(state.pendingDueMs).toBe(Date.now() + 1000);
    vi.clearAllTimers();
  });

  it('resolves the pending promise with the cancel reason when the scheduler cancels a queued rebuild', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    state.legacyScheduler?.cancelAll('test_cancel');

    await expect(pending).resolves.toBe('test_cancel');
    expect(state.pending).toBeUndefined();
    expect(state.pendingDueMs).toBeUndefined();
  });

  it('does not overwrite a queued hard-cap rebuild when a lower-priority signal request is dropped', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const scheduler = new PlanRebuildScheduler({
      getNowMs: Date.now,
      resolveDueAtMs: (_intent, currentState) => currentState.nowMs + 1000,
      executeIntent: async () => undefined,
    });

    const hardCapPending = schedulePlanRebuildFromPowerSample({
      scheduler,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 10_600,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -1.6,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
    });

    const signalPending = schedulePlanRebuildFromPowerSample({
      scheduler,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9_200,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.2,
    });

    expect(signalPending).toBe(hardCapPending);
    expect(state.pending).toBe(hardCapPending);
    expect(state.pendingReason).toBe('hard_cap_breach');
    expect(state.pendingHardCapBreach).toEqual({ breached: true, deficitKw: 0.6 });
  });

  it('logs errors from scheduled boundary rebuilds', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 0 };
    const rebuildPlanFromCache = vi.fn().mockRejectedValue(new Error('boom'));
    const logError = vi.fn();

    const pending = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('boom');

    expect(logError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('skips rebuild when power change is below threshold and soft limit is stable', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5050,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 3.95,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild only because the soft limit changes', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 8 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5000,
      limitKw: 10,
      softLimitKw: 8.2,
      headroomKw: 3.2,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(state.lastSoftLimitKw).toBe(8);
  });

  it('does not rebuild on danger zone entry with a small power delta', async () => {
    // Power crosses the 9 kW danger threshold with only a 30 W delta — below the 100 W
    // meaningful-delta threshold. Without headroom pressure or an exceeded max interval
    // there is no reason to rebuild; the previous plan is still valid.
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 8980, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9010,  // 30 W above danger threshold, but only 30 W delta
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 0.99,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild when already in danger zone with no meaningful power change', async () => {
    // lastRebuildPowerW in danger zone (9050 W >= 9000 W threshold), so treated as sustained
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 9050, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9060,  // only 10 W delta — below 100 W threshold
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 0.94,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds when sustained in danger zone after max interval', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 11000, lastRebuildPowerW: 9050, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 10000,  // 10 s elapsed > 10 s max
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9060,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 0.94,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild while headroom stays safely positive even if power changes meaningfully', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 6200,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 2.8,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds after max interval even if delta is small', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 20000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 500,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5050,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: 3.95,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('uses last rebuild power when current power is missing', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      powerDeltaW: 200,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.2,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastRebuildPowerW).toBe(5000);
  });

  it('keeps last soft limit when soft limit is missing', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 5000, lastSoftLimitKw: 8 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5200,
      powerDeltaW: 200,
      limitKw: 10,
      headroomKw: -0.2,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.lastSoftLimitKw).toBe(8);
  });

  it('preserves a follow-up pending rebuild when a new boundary sample arrives during a timed rebuild', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 1000, lastSoftLimitKw: 9 };
    let resolveRebuild: (() => void) | undefined;
    const rebuildPlanFromCache = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRebuild = resolve;
      }),
    );
    const logError = vi.fn();

    const first = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    vi.advanceTimersByTime(1000);
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
      currentPowerW: 9700,
      limitKw: 10,
      softLimitKw: 8.7,
      headroomKw: -0.7,
    });

    expect(second).not.toBe(first);
    expect(state.pending).toBe(second);
    expect(state.pendingPowerW).toBe(9700);
    expect(state.pendingSoftLimitKw).toBe(8.7);

    resolveRebuild?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.pending).toBe(second);
    await vi.runAllTimersAsync();

    expect(logError).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(state.pending).toBeUndefined();
    expect(state.pendingReason).toBeUndefined();
    expect(state.pendingPowerW).toBeUndefined();
    expect(state.pendingSoftLimitKw).toBeUndefined();
  });

  it('cancels pending timer and performs an immediate rebuild when interval is exceeded', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 1000, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();

    const first = schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      maxIntervalMs: 10000,
      rebuildPlanFromCache,
      logError,
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
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
      currentPowerW: 9700,
      limitKw: 10,
      softLimitKw: 8.8,
      headroomKw: -0.7,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    await second;
    await first;

    vi.advanceTimersByTime(1000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(state.pending).toBeUndefined();
    expect(state.pendingDueMs).toBeUndefined();
  });

  it('backs off repeated tight-headroom no-op rebuilds', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 9500, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.tightNoopStreak).toBe(1);
    expect(state.backoffUntilMs).toBe(Date.now() + 15_000);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('lets meaningful power deltas bypass tight-headroom no-op backoff', async () => {
    let state: PowerSampleRebuildState = {
      lastMs: Date.now(),
      lastRebuildPowerW: 9500,
      lastSoftLimitKw: 9,
      tightNoopStreak: 1,
      backoffUntilMs: Date.now() + 15_000,
    };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9700,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.7,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('resets tight-headroom no-op backoff when a rebuild applies actions', async () => {
    let state: PowerSampleRebuildState = {
      lastMs: Date.now(),
      lastRebuildPowerW: 9500,
      lastSoftLimitKw: 9,
      tightNoopStreak: 1,
      backoffUntilMs: Date.now() - 1,
    };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: true,
      appliedActions: true,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(state.tightNoopStreak).toBe(0);
    expect(state.backoffUntilMs).toBeUndefined();
    expect(state.mitigationHoldoffUntilMs).toBe(Date.now() + 15_000);
  });

  it('holds off the first unchanged shortfall sample after mitigation applies', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 9500, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: true,
      appliedActions: true,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('lets meaningful power deltas bypass post-mitigation holdoff', async () => {
    let state: PowerSampleRebuildState = {
      lastMs: Date.now(),
      lastRebuildPowerW: 9500,
      lastSoftLimitKw: 9,
      mitigationHoldoffUntilMs: Date.now() + 15_000,
    };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9700,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.7,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('bypasses tight no-op backoff for hard-cap breaches even once shortfall is active', async () => {
    let state: PowerSampleRebuildState = {
      lastMs: Date.now(),
      lastRebuildPowerW: 9300,
      lastSoftLimitKw: 9.5,
      tightNoopStreak: 1,
      backoffUntilMs: Date.now() + 15_000,
    };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9300,
      limitKw: 10,
      softLimitKw: 9.5,
      headroomKw: 0.2,
      isInShortfall: true,
      hardCapBreach: { breached: true, deficitKw: 0.1 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('shortfall');
  });

  it('bypasses mitigation holdoff for hard-cap breaches before shortfall is active', async () => {
    let state: PowerSampleRebuildState = {
      lastMs: Date.now(),
      lastRebuildPowerW: 9300,
      lastSoftLimitKw: 9.5,
      mitigationHoldoffUntilMs: Date.now() + 15_000,
    };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9300,
      limitKw: 10,
      softLimitKw: 9.5,
      headroomKw: 0.2,
      hardCapBreach: { breached: true, deficitKw: 0.1 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
  });

  it('uses shortfall as the rebuild reason while shortfall is active', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 1000, lastRebuildPowerW: 9500, lastSoftLimitKw: 9 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromPowerSample({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 0,
      maxIntervalMs: 1000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9500,
      limitKw: 10,
      softLimitKw: 9,
      headroomKw: -0.5,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('shortfall');
  });
});

describe('schedulePlanRebuildFromSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not rebuild for non-urgent power deltas even after the stable interval elapses', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 5000, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 5.3 }),
    });

    vi.advanceTimersByTime(14999);
    await Promise.resolve();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await pending;

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('skips the stable interval when convergence is active', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 5000, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 5.3 }),
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('rebuilds convergence samples through the scheduler and preserves shortfall fallback', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 11_000, lastSoftLimitKw: 9.5 };
    const onShortfall = vi.fn();
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall,
    });
    capacityGuard.reportTotalPower(11);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 11_000,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(onShortfall).toHaveBeenCalledWith(1);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('bypasses tight no-op backoff during repeated hard-cap breaches', async () => {
    let state: PowerSampleRebuildState = {
      lastMs: Date.now() - 2500,
      lastRebuildPowerW: 9310,
      lastSoftLimitKw: 9.5,
      backoffUntilMs: Date.now() + 60_000,
    };
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
    });
    capacityGuard.setSoftLimitProvider(() => 9.5);
    capacityGuard.setShortfallThresholdProvider(() => 9.2);
    capacityGuard.reportTotalPower(9.3);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const beforeSkippedBackoff = getPerfSnapshot().counts.plan_rebuild_skipped_tight_noop_backoff_total ?? 0;

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(getPerfSnapshot().counts.plan_rebuild_skipped_tight_noop_backoff_total ?? 0).toBe(beforeSkippedBackoff);
  });

  it('rebuilds immediately when the hard-cap threshold is breached below the soft limit', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9310, lastSoftLimitKw: 9.5 };
    const onShortfall = vi.fn();
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall,
    });
    capacityGuard.setSoftLimitProvider(() => 9.5);
    capacityGuard.setShortfallThresholdProvider(() => 9.2);
    capacityGuard.reportTotalPower(9.3);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(onShortfall).toHaveBeenCalledTimes(1);
    expect(onShortfall.mock.calls[0]?.[0]).toBeCloseTo(0.1, 6);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('coalesces convergence samples within the min interval', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 5000, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    const pending = schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 1000,
      stableMinIntervalMs: 1000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 5.3 }),
      planConvergenceActive: true,
    });

    expect(state.pending).toBeDefined();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('power_sample_convergence');
    expect(state.pending).toBeUndefined();
  });

  it('does not rebuild convergence samples when the delta is not meaningful', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 5000, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5050,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 5.05 }),
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('bypasses the stable interval when headroom is tight', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9300, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 9.6 }),
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('bypasses the stable interval and checks shortfall when the hard-cap threshold is breached', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9310, lastSoftLimitKw: 9.5 };
    const onShortfall = vi.fn();
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall,
    });
    capacityGuard.setSoftLimitProvider(() => 9.5);
    capacityGuard.setShortfallThresholdProvider(() => 9.2);
    capacityGuard.reportTotalPower(9.3);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(onShortfall).toHaveBeenCalledTimes(1);
    expect(onShortfall.mock.calls[0]?.[0]).toBeCloseTo(0.1, 6);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('runs immediately when a hard-cap breach preempts a pending stable timer', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now(), lastRebuildPowerW: 5000, lastSoftLimitKw: 9.5 };
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const firstCapacityGuard = createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 5.3 });

    const pending = schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: firstCapacityGuard,
    });

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const urgentCapacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall: vi.fn(),
    });
    urgentCapacityGuard.setSoftLimitProvider(() => 9.5);
    urgentCapacityGuard.setShortfallThresholdProvider(() => 9.2);
    urgentCapacityGuard.reportTotalPower(9.3);

    void schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: urgentCapacityGuard,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    await pending;
  });

  it('enters shortfall when a tight no-op rebuild leaves the hard cap breached', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 11_000, lastSoftLimitKw: 9.5 };
    const onShortfall = vi.fn();
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall,
    });
    capacityGuard.reportTotalPower(11);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 11_000,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
    });

    expect(onShortfall).toHaveBeenCalledWith(1);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('does not enter shortfall for soft-limit-only no-op rebuilds', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9600, lastSoftLimitKw: 9.5 };
    const onShortfall = vi.fn();
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall,
    });
    capacityGuard.reportTotalPower(9.6);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
    });

    expect(onShortfall).not.toHaveBeenCalled();
    expect(capacityGuard.isInShortfall()).toBe(false);
  });

  it('skips full rebuilds while shortfall is active and no actionable reduction remains', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 5267, lastSoftLimitKw: 3.9 };
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall: vi.fn(),
    });
    capacityGuard.setSoftLimitProvider(() => 3.9);
    capacityGuard.setShortfallThresholdProvider(() => 4.961);
    capacityGuard.reportTotalPower(5.267);
    await capacityGuard.checkShortfall(false, 0.306);
    const checkShortfallSpy = vi.spyOn(capacityGuard, 'checkShortfall');
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
      skipWhileShortfallUnrecoverable: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(checkShortfallSpy).toHaveBeenLastCalledWith(false, expect.closeTo(0.306, 3));
  });

  it('keeps shortfall recovery checks alive while full rebuilds are suppressed', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 5267, lastSoftLimitKw: 3.9 };
    const onShortfallCleared = vi.fn();
    const capacityGuard = new CapacityGuard({
      limitKw: 10,
      softMarginKw: 0.5,
      onShortfall: vi.fn(),
      onShortfallCleared,
    });
    capacityGuard.setSoftLimitProvider(() => 3.9);
    capacityGuard.setShortfallThresholdProvider(() => 4.961);
    capacityGuard.reportTotalPower(5.267);
    await capacityGuard.checkShortfall(false, 0.306);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });

    capacityGuard.reportTotalPower(4.6);
    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 4600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
      skipWhileShortfallUnrecoverable: true,
    });

    expect(capacityGuard.isInShortfall()).toBe(true);
    expect(onShortfallCleared).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    await schedulePlanRebuildFromSignal({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      minIntervalMs: 2000,
      stableMinIntervalMs: 15000,
      maxIntervalMs: 30000,
      rebuildPlanFromCache,
      logError: vi.fn(),
      currentPowerW: 4600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard,
      skipWhileShortfallUnrecoverable: true,
    });

    expect(capacityGuard.isInShortfall()).toBe(false);
    expect(onShortfallCleared).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('records rebuild timing after the async rebuild settles', async () => {
    let state: PowerSampleRebuildState = { lastMs: Date.now() - 2500, lastRebuildPowerW: 9300, lastSoftLimitKw: 9.5 };
    let resolveRebuild: (() => void) | undefined;
    const rebuildPlanFromCache = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
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
      logError: vi.fn(),
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      capacityGuard: createCapacityGuardMock({ softLimitKw: 9.5, totalPowerKw: 9.6 }),
    });

    expect(addPerfDurationMock).not.toHaveBeenCalledWith('power_sample_rebuild_ms', expect.any(Number));

    vi.advanceTimersByTime(25);
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

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
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

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
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

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
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

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
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

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
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

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBe(0);
  });

  it('leaves controlled power unknown when no snapshot devices are available', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSampleForApp({
      currentPowerW: 1000,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot: () => [],
      powerTracker: tracker,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    expect(tracker.lastControlledPowerW).toBeUndefined();
    expect(tracker.lastUncontrolledPowerW).toBeUndefined();
  });
});
