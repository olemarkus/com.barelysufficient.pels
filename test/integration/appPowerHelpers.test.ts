import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
const addPerfDurationMock = vi.fn();

vi.mock('../../lib/utils/perfCounters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/utils/perfCounters')>();
  return {
    ...actual,
    addPerfDuration: (...args: unknown[]) => addPerfDurationMock(...args),
  };
});

import CapacityGuard from '../../lib/power/capacityGuard';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';
import {
  recordDailyBudgetCap,
  recordPowerSampleForApp,
  type SumBudgetExemptUsage,
  type UpdateObjectiveProfiles,
} from '../../lib/power/sampleIngest';
import { isPlanActivelyConverging } from '../../lib/plan/planStateHelpers';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import {
  PowerCalibrationStore,
  createCalibrationSnapshotMutationHook,
} from '../../lib/device/devicePowerCalibrationStore';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import {
  createTestPlanRebuildThrottle,
  throttleMemoryFixture,
  schedulePowerSampleForTest,
  scheduleSignalForTest,
} from '../helpers/powerRebuildScheduler';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { sumBudgetExemptProjectedUsageKw } from '../../lib/plan/planUsage';
import { withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';
import { updateObjectiveProfilesFromSnapshot } from '../../lib/objectives/profiles';
import { resolveObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';
import { buildNullCapacityStateSummary } from '../../lib/power/capacityStateSummary';

// The guard no longer resolves the hard-cap budget itself; callers pass it in.
const TEST_SHORTFALL_THRESHOLD_KW = 4.961;

// Mirror the production wiring in `setup/powerSamplePipeline.ts`: raw transport
// snapshots go through `withHeadroomCurrentOn` — the producer boundary that
// resolves `currentDrawKw` and `currentOn` for the projected exemption seam.
// Injecting the bare plan helpers would hand them un-resolved snapshots the
// runtime never produces.
const sumBudgetExemptUsage: SumBudgetExemptUsage = (devices) => (
  sumBudgetExemptProjectedUsageKw(devices.map(withHeadroomCurrentOn))
);

// The guard holds no capacity settings now, so this is just a bare instance;
// the thresholds tests used to configure travel with the calls instead.
const createCapacityGuardMock = (): CapacityGuard => createTestCapacityGuard({ homeId: 'main' });

describe('recordDailyBudgetCap', () => {
  it('returns existing state for invalid snapshots', () => {
    const wrapUiPayload = (day: unknown) => ({
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
      const result = recordDailyBudgetCap({ powerTracker, snapshot: snapshot as unknown as DailyBudgetUiPayload });
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

    const result = recordDailyBudgetCap({ powerTracker, snapshot: snapshot as unknown as DailyBudgetUiPayload });
    expect(result).not.toBe(powerTracker);
    expect(result.dailyBudgetCaps).toEqual({ existing: 1, [bucketKey]: 2.5 });
  });
});

describe('PlanRebuildThrottle — signal-level gates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    addPerfDurationMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds immediately when a control boundary is already crossed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().lastRebuild?.atMs).toBe(Date.now());
    expect(throttle.snapshot().queued).toBeNull();
  });

  it('schedules and coalesces rebuilds when a boundary sample arrives too soon', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const first = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });
    const second = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9700,
      capacityPaceKw: 9,
    });

    expect(second).toBe(first);
    vi.advanceTimersByTime(1000);
    await first;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(throttle.snapshot().queued).toBeNull();
  });

  it('uses the latest coalesced sample values when a timed rebuild fires', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const pending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9700,
      capacityPaceKw: 8.7,
    });

    vi.advanceTimersByTime(1000);
    await pending;

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().lastRebuild?.powerW).toBe(9700);
  });

  it('creates a pending rebuild when a boundary sample arrives within the min interval', () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const pending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    expect(pending).toBe(throttle.snapshot().queued?.promise);
    expect(throttle.snapshot().queued?.dueMs).toBe(Date.now() + 1000);
    vi.clearAllTimers();
  });

  it('resolves the pending promise with the cancel reason when the scheduler cancels a queued rebuild', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle, scheduler } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const pending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    scheduler.cancelAll('test_cancel');

    await expect(pending).resolves.toBe('test_cancel');
    expect(throttle.snapshot().queued).toBeNull();
  });

  it('does not overwrite a queued hard-cap rebuild when a lower-priority signal request is dropped', async () => {
    // A stub scheduler on purpose: this case is about which intent wins the queue,
    // not about what executing one does.
    const scheduler = new PlanRebuildScheduler({
      getNowMs: Date.now,
      resolveDueAtMs: (_intent, currentState) => currentState.nowMs + 1000,
      executeIntent: async () => undefined,
    });
    const throttle = new PlanRebuildThrottle(
      {
        getScheduler: () => scheduler,
        getCapacityGuard: createCapacityGuardMock,
        getNowMs: Date.now,
        rebuildPlanFromCache: async () => undefined,
      },
      { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    );

    const hardCapPending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
    });

    const signalPending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9_200,
      capacityPaceKw: 9,
    });

    expect(signalPending).toBe(hardCapPending);
    expect(throttle.snapshot().queued?.trigger).toBe('hard_cap_breach');
    expect(throttle.snapshot().queued?.signal.hardCapBreach).toEqual({ breached: true, deficitKw: 0.6 });
  });

  it('logs errors from scheduled boundary rebuilds', async () => {
    const rebuildPlanFromCache = vi.fn().mockRejectedValue(new Error('boom'));
    const logError = vi.fn();
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 0, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const pending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('boom');

    expect(logError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('skips rebuild when power change is below threshold and soft limit is stable', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 5050,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild only because the soft limit changes', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 5000,
      capacityPaceKw: 8.2,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild on danger zone entry with a small power delta', async () => {
    // Power crosses the 9 kW danger threshold with only a 30 W delta — below the 100 W
    // meaningful-delta threshold. Without headroom pressure or an exceeded max interval
    // there is no reason to rebuild; the previous plan is still valid.
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 8980, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9010,  // 30 W above danger threshold, but only 30 W delta
      // Pace 10, not 9: these specs pinned a +0.99 kW headroom, which is what a
      // 10 kW pace derives. Against a 9 kW pace the reading is tight (-0.01) and
      // the rebuild they assert against would fire on the control boundary.
      capacityPaceKw: 10,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild when already in danger zone with no meaningful power change', async () => {
    // lastRebuildPowerW in danger zone (9050 W >= 9000 W threshold), so treated as sustained
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 9050, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9060,  // only 10 W delta — below 100 W threshold
      capacityPaceKw: 10,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds when sustained in danger zone after max interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 11000, powerW: 9050, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9060,
      capacityPaceKw: 10,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild while headroom stays safely positive even if power changes meaningfully', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 6200,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds after max interval even if delta is small', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 500, stableMinIntervalMs: 500, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 20000, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 5050,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  // The delta is measured against the last rebuild's own sample. It used to be
  // possible to hand one in as a `powerDeltaW` hint instead, but no producer
  // ever did, so the sample is now the only source.
  it('rebuilds on a meaningful delta from the last rebuild power and stamps the new sample', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 5200,
      capacityPaceKw: 9,
      // Headroom is left to derive (9 - 5.2 = +3.8 kW, NOT tight) so the rebuild
      // can only come from the delta branch, which is gated behind convergence
      // (`shouldRebuildFromDecision`). Pinning a contradictory `headroomKw` here
      // would pass through `controlBoundaryActive` instead and the spec would be
      // asserting a cause that never fired.
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().lastRebuild?.powerW).toBe(5200);
  });

  it('preserves a follow-up pending rebuild when a new boundary sample arrives during a timed rebuild', async () => {
    let resolveRebuild: (() => void) | undefined;
    const rebuildPlanFromCache = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRebuild = resolve;
      }),
    );
    const logError = vi.fn();
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 1000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const first = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    vi.advanceTimersByTime(1000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    const second = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9700,
      capacityPaceKw: 8.7,
    });

    expect(second).not.toBe(first);
    expect(throttle.snapshot().queued?.promise).toBe(second);
    expect(throttle.snapshot().queued?.signal.currentPowerW).toBe(9700);
    expect(throttle.snapshot().queued?.signal.capacityPaceKw).toBe(8.7);

    resolveRebuild?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(throttle.snapshot().queued?.promise).toBe(second);
    await vi.runAllTimersAsync();

    expect(logError).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(throttle.snapshot().queued).toBeNull();
  });

  it('cancels pending timer and performs an immediate rebuild when interval is exceeded', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 10000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 1000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    const first = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    expect(throttle.snapshot().queued).not.toBeNull();
    const remembered = throttle.snapshot().lastRebuild;
    throttle['restore']({
      ...throttle.snapshot(),
      lastRebuild: remembered === null ? null : { ...remembered, atMs: Date.now() - 2000 },
    });

    const second = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9700,
      capacityPaceKw: 8.8,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    await second;
    await first;

    vi.advanceTimersByTime(1000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
    expect(throttle.snapshot().queued).toBeNull();
  });

  it('backs off repeated tight-headroom no-op rebuilds', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 9500, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().noopStreak).toBe(1);
    expect(throttle.snapshot().holdoff?.untilMs).toBe(Date.now() + 15_000);

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('lets meaningful power deltas bypass tight-headroom no-op backoff', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9500, hardCapBreach: { breached: false, deficitKw: 0 } }, noopStreak: 1, holdoff: { untilMs: Date.now() + 15_000, cause: 'noop' } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9700,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('resets tight-headroom no-op backoff when a rebuild applies actions', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: true,
      appliedActions: true,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9500, hardCapBreach: { breached: false, deficitKw: 0 } }, noopStreak: 1, holdoff: { untilMs: Date.now() - 1, cause: 'noop' } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().noopStreak).toBe(0);
    expect(throttle.snapshot().holdoff).toEqual({ untilMs: Date.now() + 15_000, cause: 'mitigation' });
  });

  it('holds off the first unchanged shortfall sample after mitigation applies', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: true,
      appliedActions: true,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 9500, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('lets meaningful power deltas bypass post-mitigation holdoff', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9500, hardCapBreach: { breached: false, deficitKw: 0 } }, holdoff: { untilMs: Date.now() + 15_000, cause: 'mitigation' } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9700,
      capacityPaceKw: 9,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('bypasses tight no-op backoff for hard-cap breaches even once shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9300, hardCapBreach: { breached: false, deficitKw: 0 } }, noopStreak: 1, holdoff: { untilMs: Date.now() + 15_000, cause: 'noop' } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9300,
      capacityPaceKw: 9.5,
      isInShortfall: true,
      hardCapBreach: { breached: true, deficitKw: 0.1 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('shortfall');
  });

  it('bypasses mitigation holdoff for the first hard-cap breach before shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9300, hardCapBreach: { breached: false, deficitKw: 0 } }, holdoff: { untilMs: Date.now() + 15_000, cause: 'mitigation' } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9300,
      capacityPaceKw: 9.5,
      hardCapBreach: { breached: true, deficitKw: 0.1 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
  });

  it('skips unchanged repeated hard-cap breaches before shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 30_000 },
      // The last rebuild ran for this very breach: same deficit, same power.
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9300, hardCapBreach: { breached: true, deficitKw: 0.1 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9300,
      capacityPaceKw: 9.5,
      hardCapBreach: { breached: true, deficitKw: 0.1 },
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(throttle.snapshot().lastRebuild?.hardCapBreach.breached).toBe(true);
  });

  it('rebuilds repeated hard-cap breaches when power changes meaningfully', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 30_000 },
      // Same deficit as the sample: only the power delta can earn this rebuild.
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9300, hardCapBreach: { breached: true, deficitKw: 0.25 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9450,
      capacityPaceKw: 9.5,
      hardCapBreach: { breached: true, deficitKw: 0.25 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(throttle.snapshot().lastRebuild?.hardCapBreach.breached).toBe(true);
  });

  it('clears hard-cap breach state once a sample is no longer breached', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 9300, hardCapBreach: { breached: true, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9000,
      capacityPaceKw: 9.5,
      hardCapBreach: { breached: false, deficitKw: 0 },
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(throttle.snapshot().lastRebuild?.hardCapBreach.breached).toBe(false);
  });

  it('uses shortfall as the rebuild reason while shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 1000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 1000, powerW: 9500, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 9500,
      capacityPaceKw: 9,
      isInShortfall: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('shortfall');
  });

  // Regression: the CPU-watchdog crash-loop. A hard-cap breach with an oscillating
  // (meaningful-delta) uncontrolled load used to force a full ~1.4s rebuild on every
  // power sample even when nothing was actionable, saturating CPU.
  // Also guards the P1 fix: the throttled skip must NOT enter shortfall (calling
  // checkShortfall here without a rebuild would let a stale "unactionable" summary
  // deadlock the unrecoverable-shortfall skip against ever discovering returned load).
  it('throttles an unactionable hard-cap breach without entering shortfall from the skip', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle, checkShortfall } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 5000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0 } } }),
    });
    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600, // 200 W delta vs last — "meaningful", but nothing to shed
      capacityPaceKw: 9,
      isInShortfall: false,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      unactionable: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(checkShortfall).not.toHaveBeenCalled();
  });

  it('still refreshes an unactionable state once the max interval elapses', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 31_000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      unactionable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not throttle a hard-cap breach when there is still something to shed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 5000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0.6 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      unactionable: false,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not throttle an unactionable state while the plan is actively converging', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 5000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0 } } }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      planConvergenceActive: true,
      unactionable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('allows one re-check rebuild when the invalidation latch is set, then clears the latch', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 20_000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0 } }, suppressionInvalidated: true }),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      // A sample outside shortfall spends the latch before deciding (kept from
      // the free-function version), so the re-check is exercised in shortfall.
      isInShortfall: true,
      unactionable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().suppressionInvalidated).toBeFalsy();
  });

  it('clears the invalidation latch when a re-check rebuild rejects (error-path one-shot)', async () => {
    const rebuildPlanFromCache = vi.fn().mockRejectedValue(new Error('boom'));
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 20_000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0 } }, suppressionInvalidated: true }),
    });

    await expect(
      schedulePowerSampleForTest({
        throttle,
        limitKw: 10,
        currentPowerW: 10_600,
        capacityPaceKw: 9,
        hardCapBreach: { breached: true, deficitKw: 0.6 },
        // A sample outside shortfall spends the latch before deciding (kept from
        // the free-function version), so the re-check is exercised in shortfall.
        isInShortfall: true,
        unactionable: true,
      }),
    ).rejects.toThrow('boom');

    expect(throttle.snapshot().suppressionInvalidated).toBeFalsy();
  });

  it('floors executed rebuilds while unactionable — even a hard-cap intent waits out the interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 5000, powerW: 10_400, hardCapBreach: { breached: true, deficitKw: 0 } }, suppressionInvalidated: true }),
    });

    const pending = schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      // A sample outside shortfall spends the latch before deciding (kept from
      // the free-function version), so the re-check is exercised in shortfall.
      isInShortfall: true,
      unactionable: true,
    });

    vi.advanceTimersByTime(9000);
    await Promise.resolve();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    await pending;
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not floor the first rebuild on a monotonic clock', async () => {
    // Reproduces prod: getPlanRebuildNowMs is performance.now() (monotonic, small
    // values) and the throttle starts with no rebuild remembered. Were the floor
    // anchored to a zero timestamp instead of to a rebuild that ran, an
    // unactionable initial sample would floor its due time to 0 + 15_000 and
    // defer the first rebuild to uptime 15s, despite the initial sample being
    // required to rebuild immediately.
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    // The scheduler resolves the due time, so it must be on the SAME monotonic
    // clock as the call — on epoch time the bogus 15_000 floor would compare
    // against `Date.now()`, execute anyway, and hide a regression of the
    // no-rebuild-yet guard this test exists to catch.
    const getNowMs = () => 5000; // uptime 5s on a monotonic clock
    const { throttle } = createTestPlanRebuildThrottle({
      getNowMs,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
      memory: throttleMemoryFixture(),
    });

    await schedulePowerSampleForTest({
      throttle,
      limitKw: 10,
      currentPowerW: 10_600,
      capacityPaceKw: 9,
      hardCapBreach: { breached: true, deficitKw: 0.6 },
      unactionable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });
});

describe('PlanRebuildThrottle — sample-level gates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not rebuild for non-urgent power deltas even after the stable interval elapses', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });

    const pending = scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    vi.advanceTimersByTime(14999);
    await Promise.resolve();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await pending;

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('skips the stable interval when convergence is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('rebuilds convergence samples through the scheduler and preserves shortfall fallback', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 11_000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 10,
      shortfallThresholdKw: 10,
      totalKw: 11,
      currentPowerW: 11_000,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(onShortfall).toHaveBeenCalledWith(1);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('bypasses tight no-op backoff during newly observed hard-cap breaches', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9310, hardCapBreach: { breached: false, deficitKw: 0 } }, holdoff: { untilMs: Date.now() + 60_000, cause: 'noop' } }),
    });
    const beforeSkippedBackoff = getPerfSnapshot().counts.plan_rebuild_skipped_tight_noop_backoff_total ?? 0;

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.2,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(getPerfSnapshot().counts.plan_rebuild_skipped_tight_noop_backoff_total ?? 0).toBe(beforeSkippedBackoff);
  });

  it('skips signal scheduling for unchanged repeated hard-cap breaches', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9300, hardCapBreach: { breached: true, deficitKw: 0.1 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.2,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(throttle.snapshot().lastRebuild?.hardCapBreach.breached).toBe(true);
  });

  it('rebuilds repeated hard-cap breaches when the deficit grows without a power delta', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9300, hardCapBreach: { breached: true, deficitKw: 0.1 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.0,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(throttle.snapshot().lastRebuild?.hardCapBreach.deficitKw).toBeCloseTo(0.3, 6);
  });

  it('still rebuilds repeated hard-cap breaches at the max interval', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 30_000, powerW: 9300, hardCapBreach: { breached: true, deficitKw: 0.1 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.2,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
  });

  it('rebuilds immediately when the hard-cap threshold is breached below the soft limit', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9310, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.2,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(onShortfall).toHaveBeenCalledTimes(1);
    expect(onShortfall.mock.calls[0]?.[0]).toBeCloseTo(0.1, 6);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('coalesces convergence samples within the min interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 1000, stableMinIntervalMs: 1000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });

    const pending = scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      planConvergenceActive: true,
    });

    expect(throttle.snapshot().queued).not.toBeNull();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('power_sample_convergence');
    expect(throttle.snapshot().queued).toBeNull();
  });

  it('does not rebuild convergence samples when the delta is not meaningful', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 5050,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('bypasses the stable interval when headroom is tight', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9300, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('bypasses the stable interval and checks shortfall when the hard-cap threshold is breached', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9310, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.2,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(onShortfall).toHaveBeenCalledTimes(1);
    expect(onShortfall.mock.calls[0]?.[0]).toBeCloseTo(0.1, 6);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('runs immediately when a hard-cap breach preempts a pending stable timer', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now(), powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });
    const pending = scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    void scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 9.2,
      totalKw: 9.3,
      currentPowerW: 9300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    await pending;
  });

  it('enters shortfall when a tight no-op rebuild leaves the hard cap breached', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 11_000, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 10,
      shortfallThresholdKw: 10,
      totalKw: 11,
      currentPowerW: 11_000,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(onShortfall).toHaveBeenCalledWith(1);
    expect(capacityGuard.isInShortfall()).toBe(true);
  });

  it('does not enter shortfall for soft-limit-only no-op rebuilds', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9600, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 10,
      shortfallThresholdKw: 10,
      totalKw: 9.6,
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
    });

    expect(onShortfall).not.toHaveBeenCalled();
    expect(capacityGuard.isInShortfall()).toBe(false);
  });

  it('skips full rebuilds while shortfall is active and no actionable reduction remains', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall: vi.fn() });
    await capacityGuard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.306,
      totalKw: 5.267,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
    const checkShortfallSpy = vi.spyOn(capacityGuard, 'checkShortfall');
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 5267, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 3.9,
      shortfallThresholdKw: 4.961,
      totalKw: 5.267,
      currentPowerW: 5300,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      shortfallUnrecoverable: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(checkShortfallSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      hasCandidates: false,
      deficitKw: expect.closeTo(0.306, 3),
    }));
  });

  // Regression: the 2026-07-06 cpuwarn crash. A persistent unwinnable overshoot
  // (daily allowance clamped to 0, all managed devices shed, remaining draw
  // unmanaged) kept the overshoot incident open, which made the pipeline pass
  // `planConvergenceActive: true` and defeated the unrecoverable-shortfall skip —
  // a ~1.6s rebuild fired on every jittering power sample until Homey killed the
  // app. Composes the pipeline wiring: convergence derived from the plan state
  // WITH the unactionable summary must let the skip engage.
  it('suppresses the rebuild storm when overshoot persists but the plan is unactionable', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall: vi.fn() });
    await capacityGuard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.306,
      totalKw: 5.267,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 5267, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });
    const planState = createPlanEngineState();
    planState.overshoot.enter(Date.now());
    const planUnactionable = true; // summary: nothing actionable, nothing reducible

    // ≥100 W jitter per sample — "meaningful" deltas that used to force a rebuild each time.
    for (const powerW of [5450, 5300, 5480]) {
      await scheduleSignalForTest({
        throttle,
        capacityPaceKw: 3.9,
        shortfallThresholdKw: 4.961,
        totalKw: 5.267,
        currentPowerW: powerW,
        capacitySettings: { limitKw: 10, marginKw: 0.5 },
        planConvergenceActive: isPlanActivelyConverging(planState, { unactionable: planUnactionable }),
        shortfallUnrecoverable: true,
        unactionable: planUnactionable,
      });
    }

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('drives recovery checks during suppression then yields a rebuild at the max interval', async () => {
    const onShortfallCleared = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall: vi.fn(), onShortfallCleared });
    await capacityGuard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.306,
      totalKw: 5.267,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
    const checkShortfallSpy = vi.spyOn(capacityGuard, 'checkShortfall');
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: false,
      appliedActions: false,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 5267, hardCapBreach: { breached: false, deficitKw: 0 } } }),
    });

    // Within the max interval, the unrecoverable-shortfall skip suppresses the full
    // rebuild but still drives `checkShortfall`, so recovery detection stays alive.
    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 3.9,
      shortfallThresholdKw: 4.961,
      totalKw: 4.6,
      currentPowerW: 4600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      shortfallUnrecoverable: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(checkShortfallSpy).toHaveBeenCalled();
    expect(capacityGuard.isInShortfall()).toBe(true);

    // Past the max interval, the escape yields a real rebuild rather than suppressing
    // forever — otherwise a stale "unactionable" summary could deadlock the skip.
    vi.advanceTimersByTime(60_000);
    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 3.9,
      shortfallThresholdKw: 4.961,
      totalKw: 4.6,
      currentPowerW: 4600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      shortfallUnrecoverable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('rebuilds when shortfall suppression was invalidated by newly returned controlled load', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall: vi.fn() });
    await capacityGuard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.306,
      totalKw: 5.267,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({
      actionChanged: true,
      appliedActions: true,
      failed: false,
    });
    const { throttle } = createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 5267, hardCapBreach: { breached: false, deficitKw: 0 } }, suppressionInvalidated: true }),
    });

    await scheduleSignalForTest({
      throttle,
      capacityPaceKw: 3.9,
      shortfallThresholdKw: 4.961,
      totalKw: 6.1,
      currentPowerW: 6100,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
      shortfallUnrecoverable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('shortfall');
    expect(throttle.snapshot().suppressionInvalidated).toBe(false);
  });

  it('records rebuild timing after the async rebuild settles', async () => {
    let resolveRebuild: (() => void) | undefined;
    const rebuildPlanFromCache = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveRebuild = resolve;
    }));
    const { throttle } = createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      cadence: { minIntervalMs: 2000, stableMinIntervalMs: 15000, maxIntervalMs: 30000 },
      memory: throttleMemoryFixture({ lastRebuild: { atMs: Date.now() - 2500, powerW: 9300, hardCapBreach: { breached: false, deficitKw: 0 } } }),
      capacityGuard: createCapacityGuardMock(),
    });

    const pending = scheduleSignalForTest({
      throttle,
      capacityPaceKw: 9.5,
      shortfallThresholdKw: 10,
      currentPowerW: 9600,
      capacitySettings: { limitKw: 10, marginKw: 0.5 },
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
        available: true,
        id: 'dev-budget',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Budget exempt heater',
        targets: [],
        measuredPowerKw: 0.4,
        budgetExempt: true,
      },
      {
        available: true,
        id: 'dev-other',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
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
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

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
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBeCloseTo(0.2, 3);
  });

  it('keeps an OFF exempt device claiming its configured demand on the daily axis', async () => {
    // The exempt projection is a reservation, not a measurement stand-in: the
    // daily-pace add-back has to survive the device's duty cycle. Note the
    // trigger is being observed OFF — a running exempt device measuring 0 books 0.
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'dev-budget',
        name: 'Budget exempt heater',
        targets: [],
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        measuredPowerKw: 0,
        expectedPowerKw: 0.8,
        expectedPowerSource: 'default' as const,
        budgetExempt: true,
      },
    ]);

    await recordPowerSampleForApp({
      currentPowerW: 800,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

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
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

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
        available: true,
        id: 'dev-budget',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
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
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

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
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,

      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.exemptBuckets?.[bucketKey]).toBe(0);
  });

  // Membership in the per-device buckets is a PRESENCE question and nothing
  // else. Homey reports capabilities on change, so an unchanged reading is the
  // current reading however old its timestamp — the per-capability age gate that
  // used to sit here dropped a legitimately-steady device out of its own bucket
  // for as long as it stayed correct (prod thermostat, true 0 W for 16 h). What
  // still must NOT be bucketed is a device with no meter at all: booking it at 0
  // would claim it used nothing, when the truth is PELS cannot see it and its
  // consumption belongs in the "Other" remainder.
  it('records per-device buckets from any present measured reading, and none without one', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    let observedAtMs = start;
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'fresh-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Fresh heater',
        targets: [],
        measuredPowerKw: 1.2,
        measuredPowerObservedAtMs: observedAtMs,
      },
      {
        available: true,
        id: 'steady-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Steady heater (unchanged for over a minute)',
        targets: [],
        measuredPowerKw: 0.8,
        measuredPowerObservedAtMs: observedAtMs - 61_000,
      },
      {
        available: true,
        id: 'timestampless-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Heater whose capability carries no timestamp',
        targets: [],
        measuredPowerKw: 0.9,
      },
      {
        available: true,
        id: 'estimated-heater',
        name: 'Estimated heater',
        targets: [],
        expectedPowerKw: 0.5,
        expectedPowerSource: 'default' as const,
      },
    ]);

    await recordPowerSampleForApp({
      currentPowerW: 2500,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    observedAtMs = start + 30 * 60 * 1000;
    await recordPowerSampleForApp({
      currentPowerW: 2500,
      nowMs: start + 30 * 60 * 1000,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.deviceBuckets?.['fresh-heater']?.[bucketKey]).toBeCloseTo(0.6, 3);
    expect(tracker.deviceBuckets?.['steady-heater']?.[bucketKey]).toBeCloseTo(0.4, 3);
    expect(tracker.deviceBuckets?.['timestampless-heater']?.[bucketKey]).toBeCloseTo(0.45, 3);
    expect(tracker.deviceBuckets?.['estimated-heater']).toBeUndefined();
  });

  it('records measured zero as a per-device bucket', async () => {
    let tracker: PowerTrackerState = {};
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    let observedAtMs = start;
    const getLatestTargetSnapshot = () => ([
      {
        available: true,
        id: 'idle-heater',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Idle heater',
        targets: [],
        measuredPowerKw: 0,
        measuredPowerObservedAtMs: observedAtMs,
      },
    ]);

    await recordPowerSampleForApp({
      currentPowerW: 500,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    observedAtMs = start + 30 * 60 * 1000;
    await recordPowerSampleForApp({
      currentPowerW: 500,
      nowMs: start + 30 * 60 * 1000,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const bucketKey = new Date(start).toISOString();
    expect(tracker.deviceBuckets?.['idle-heater']?.[bucketKey]).toBe(0);
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
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    expect(tracker.lastControlledPowerW).toBeUndefined();
    expect(tracker.lastUncontrolledPowerW).toBeUndefined();
  });

  it('updates objective profiles from compact device samples during power ingestion', async () => {
    let tracker: PowerTrackerState = {};
    const debugStructured = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    let currentTemperature = 50;
    let observedAtMs = start;
    const getLatestTargetSnapshot = () => {
      const target = { id: 'target_temperature' as const, value: 55, unit: '°C' };
      return [{
        available: true,
        id: 'heater-objective',
        expectedPowerKw: 1,
        expectedPowerSource: 'default' as const,
        name: 'Objective heater',
        targets: [target],
        deviceType: 'temperature' as const,
        binaryControl: { on: true },
        temperature: { currentTemperature, target },
        lastFreshDataMs: observedAtMs,
        measuredPowerKw: 2,
      }];
    };

    // Mirrors the production wiring (`setup/powerSamplePipeline.ts`): the raw
    // snapshots go through the producer boundary so the profile sees a resolved
    // `currentDrawKw`, not a raw `measuredPowerKw`, and the objectives seam's
    // `observedAtMs` stamped from the transport's `lastFreshDataMs`.
    const updateProfiles: UpdateObjectiveProfiles = (params) => (
      updateObjectiveProfilesFromSnapshot({
        ...params,
        devices: params.devices.flatMap((device) => {
          const observedQuantity = resolveObjectiveObservedQuantity({
            device,
            deviceObservedAtMs: device.lastFreshDataMs,
          });
          return observedQuantity === null
            ? []
            : [{ ...withHeadroomCurrentOn(device), observedQuantity }];
        }),
        debugStructured,
      })
    );

    await recordPowerSampleForApp({
      currentPowerW: 2000,
      nowMs: start,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: updateProfiles,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    currentTemperature = 52;
    observedAtMs = start + 60 * 60 * 1000;
    await recordPowerSampleForApp({
      currentPowerW: 2000,
      nowMs: observedAtMs,
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot,
      powerTracker: tracker,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: updateProfiles,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    const profile = tracker.objectiveProfiles?.['heater-objective'];
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(1, 3);
    expect(profile?.unitPerHour?.mean).toBeCloseTo(2, 3);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_recorded',
      deviceId: 'heater-objective',
    }));
  });

  // Gross consumption during EXPORT with no co-sampled production reading.
  // `net + generation` cannot resolve gross from a negative net when generation
  // is absent, and `max(0, net)` would assert the home consumed nothing — which
  // zeroes the managed/background split while devices are demonstrably drawing.
  describe('gross consumption on a negative net sample', () => {
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const drawingSnapshot = (observedAtMs: number) => () => ([
      {
        id: 'heater-a',
        expectedPowerKw: 1,
        name: 'Heater A',
        targets: [],
        measuredPowerKw: 1.2,
        measuredPowerObservedAtMs: observedAtMs,
      },
      {
        id: 'heater-b',
        expectedPowerKw: 1,
        name: 'Heater B',
        targets: [],
        measuredPowerKw: 0.8,
        measuredPowerObservedAtMs: observedAtMs,
      },
    ]);

    const record = async (params: {
      currentPowerW: number;
      generationW?: number;
      getLatestTargetSnapshot: () => never[] | ReturnType<ReturnType<typeof drawingSnapshot>>;
    }): Promise<PowerTrackerState> => {
      let tracker: PowerTrackerState = {};
      await recordPowerSampleForApp({
        currentPowerW: params.currentPowerW,
        ...(params.generationW !== undefined ? { generationW: params.generationW } : {}),
        nowMs: start,
        capacitySettings: { limitKw: 10, marginKw: 0.2 },
        getLatestTargetSnapshot: params.getLatestTargetSnapshot as never,
        powerTracker: {},
        sumBudgetExemptUsage,
        updateObjectiveProfiles: ({ state }) => state,
        schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
        saveState: (nextState) => {
          tracker = nextState;
        },
      });
      return tracker;
    };

    it('attributes the measured device draw instead of reporting a 0 kW home', async () => {
      const tracker = await record({
        currentPowerW: -1500,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      // 1.2 + 0.8 kW of measured managed draw survives the export sample.
      expect(tracker.lastControlledPowerW).toBe(2000);
      // Background load is genuinely unobservable without a production reading,
      // so it stays 0 — a floor, not a claim.
      expect(tracker.lastUncontrolledPowerW).toBe(0);
      // The billed total keeps net, floored — export is not negative energy.
      expect(tracker.lastPowerW).toBe(-1500);
    });

    it('never attributes a non-controllable device\'s draw to a managed device', async () => {
      // The floor must be summed over the SAME set the split attributes over.
      // A home battery is real draw but `controllable: false`, so it is excluded
      // from the controlled sum — while the controllable heater contributes its
      // own measured 2 kW. A floor built from raw measured device draw would hand
      // the battery's 2 kW to the split, which would then record it as 2 kW of
      // HEATER usage with 0 background: the wrong device credited for watts it
      // never drew.
      const tracker = await record({
        currentPowerW: -1000,
        getLatestTargetSnapshot: () => ([
          {
            id: 'home-battery',
            expectedPowerKw: 1,
            name: 'Home battery',
            targets: [],
            controllable: false,
            measuredPowerKw: 2,
            measuredPowerObservedAtMs: start,
          },
          {
            id: 'heater-estimated',
            name: 'Heater',
            targets: [],
            measuredPowerKw: 2,
            expectedPowerKw: 2,
          },
        ]) as never,
      });

      // Only the heater's own measured 2 kW is attributed — the battery's draw
      // is not laundered into the managed bucket.
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(0);
    });

    it('reports 0 when no fresh measured draw is available to floor at', async () => {
      const tracker = await record({
        currentPowerW: -1500,
        getLatestTargetSnapshot: () => [],
      });
      expect(tracker.lastControlledPowerW).toBeUndefined();
      expect(tracker.lastPowerW).toBe(-1500);
    });

    it('still prefers net + generation when a production reading is co-sampled', async () => {
      const tracker = await record({
        currentPowerW: -1500,
        generationW: 4000,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      // gross = -1500 + 4000 = 2500 W, so the split measures against 2.5 kW and
      // the 2 kW of managed draw leaves 0.5 kW of background — NOT the 2 kW
      // floor, proving the floor never displaces an authoritative reading.
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(500);
    });

    it('falls back when a co-sampled production reading cannot explain the export', async () => {
      // A solar home carries generation on EVERY sample now, including `0` at
      // night. `0` is still a reading, so a presence check would send this home
      // back to "consumed nothing" — the exact answer the fallback exists to
      // prevent — on the source that just gained production. Exporting under
      // zero reported production is real: a battery discharging to grid after
      // dark, or a second inverter Homey cannot see.
      const tracker = await record({
        currentPowerW: -1500,
        generationW: 0,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(0);
    });

    it('still prefers net + generation when the two together are positive', async () => {
      // Partial cover: 3 kW of production against a 1.5 kW export means the home
      // really is drawing 1.5 kW, and that authoritative figure must win over
      // the measured-draw floor.
      const tracker = await record({
        currentPowerW: -1500,
        generationW: 3000,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      expect(tracker.lastControlledPowerW).toBe(1500);
      expect(tracker.lastUncontrolledPowerW).toBe(0);
    });

    it('leaves a positive net sample byte-identical', async () => {
      const tracker = await record({
        currentPowerW: 2500,
        getLatestTargetSnapshot: drawingSnapshot(start),
      });
      expect(tracker.lastControlledPowerW).toBe(2000);
      expect(tracker.lastUncontrolledPowerW).toBe(500);
    });
  });

});

describe('createCalibrationSnapshotMutationHook', () => {
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const makeSnapshot = (
    overrides: Partial<
      TargetDeviceSnapshot & MeasuredPowerObservedProbe
      & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
    > = {},
  ): TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe => ({
    id: 'hoiax-1',
    expectedPowerKw: 1,
    name: 'Connected 300',
    targets: [],
    controlModel: 'stepped_load',
    steppedLoadProfile: {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
        { id: 'medium', planningPowerW: 1750 },
      ],
    },
    reportedStepId: 'low',
    measuredPowerKw: 1.1,
    binaryControl: { on: true },
    lastFreshDataMs: start,
    ...overrides,
  } as TargetDeviceSnapshot);

  it('emits a per-sample accepted event when the sample lands inside the band', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
    });
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_accepted',
      deviceId: 'hoiax-1',
      stepId: 'low',
      measuredPowerKw: 1.1,
    }));
  });

  it('emits a per-sample skipped event when the sample exceeds the configured step', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
    });
    hook(makeSnapshot({ measuredPowerKw: 1.81 }), start);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_skipped',
      deviceId: 'hoiax-1',
      reason: 'above_step_ceiling',
    }));
  });

  it('stays silent when the snapshot is ineligible for calibration', () => {
    const store = new PowerCalibrationStore();
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
    });
    hook(makeSnapshot({ reportedStepId: undefined }), start);
    expect(debugStructured).not.toHaveBeenCalled();
  });

  it('debounces repeat samples for the same (device, step) inside the cadence floor', () => {
    // EV chargers and inverter heaters can publish measure_power every 1-2 s;
    // without this debounce, EMA `alpha` would saturate to MIN_ALPHA within
    // ~30 s of operation and stop responding to legitimate drift.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start);
    hook(makeSnapshot({ measuredPowerKw: 1.12 }), start + 1_000);
    hook(makeSnapshot({ measuredPowerKw: 1.15 }), start + 5_000);
    expect(debugStructured).toHaveBeenCalledTimes(1);
    hook(makeSnapshot({ measuredPowerKw: 1.2 }), start + 31_000);
    expect(debugStructured).toHaveBeenCalledTimes(2);
  });

  it('does not debounce after an ineligible call — first eligible sample still lands', () => {
    // Regression: previously the debounce cursor was advanced before the
    // eligibility check, so an ineligible first call (e.g. stepCommandPending,
    // assumed step) would swallow the next valid sample for up to
    // minIntervalMs — exactly the startup/step-change transitions this hook
    // is meant to capture.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    hook(makeSnapshot({ reportedStepId: undefined, measuredPowerKw: 1.1 }), start);
    expect(debugStructured).not.toHaveBeenCalled();
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start + 1_000);
    expect(debugStructured).toHaveBeenCalledTimes(1);
  });

  it('does not debounce after a rejected sample — first accepted sample still lands', () => {
    // Regression: a rejected outcome (stale_observation, above_step_ceiling,
    // etc.) leaves the store untouched, so advancing the debounce cursor
    // would swallow the next valid sample without protecting anything in
    // return. The debounce exists only to stop accepted-sample chatter from
    // saturating EMA `alpha`.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    // First call: above-step-ceiling rejection.
    hook(makeSnapshot({ measuredPowerKw: 1.81 }), start);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_skipped',
      reason: 'above_step_ceiling',
    }));
    debugStructured.mockClear();
    // Second call: valid sample 1 s later. Must not be debounced.
    hook(makeSnapshot({ measuredPowerKw: 1.1 }), start + 1_000);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_calibration_sample_accepted',
    }));
  });

  it('debounces per (device, step) independently', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const debugStructured = vi.fn();
    const hook = createCalibrationSnapshotMutationHook({
      getStore: () => store,
      debugStructured,
      minIntervalMs: 30_000,
    });
    hook(makeSnapshot({ reportedStepId: 'low', measuredPowerKw: 1.1 }), start);
    hook(makeSnapshot({ reportedStepId: 'medium', measuredPowerKw: 1.6 }), start + 1_000);
    expect(debugStructured).toHaveBeenCalledTimes(2);
  });
});
