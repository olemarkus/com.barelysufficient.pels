const addPerfDurationMock = vi.fn();

vi.mock('../../lib/utils/perfCounters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/utils/perfCounters')>();
  return {
    ...actual,
    addPerfDuration: (...args: unknown[]) => addPerfDurationMock(...args),
  };
});

import { createTestCapacityGuard, planVerdictSummaryFixture } from '../helpers/createTestCapacityGuard';
import { isPlanActivelyConverging } from '../../lib/plan/planStateHelpers';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import type { RebuildOutcome } from '../../lib/plan/rebuildScheduler/policy';
import {
  actedRebuildOutcome,
  createGuardInShortfall,
  createTestPlanRebuildScheduler,
  createTestPlanRebuildThrottle,
  sampleThrottle,
  unchangedRebuildOutcome,
} from '../helpers/powerRebuildScheduler';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';

// The throttle runs at the production cadence (`POWER_SAMPLE_REBUILD_CADENCE`):
// 2 s between rebuilds at a capacity boundary, 15 s away from one, a refresh at
// least every 30 s. Every state below is reached the way production reaches it —
// readings, fake time, rebuild outcomes and observations — and every assertion is
// on what the throttle rebuilds. The limit is 10 kW unless a sample says otherwise.

const SHORTFALL_THRESHOLD_KW = 4.961;

describe('PlanRebuildThrottle — rebuild gates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:05:00.000Z'));
    addPerfDurationMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds immediately when a control boundary is already crossed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 0 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('headroom_tight');
  });

  it('schedules and coalesces rebuilds when a boundary sample arrives too soon', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const logError = vi.fn();
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 0 } },
    });

    const first = sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    const second = sampleThrottle(throttle, { currentPowerW: 9700, capacityPaceKw: 9 });
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('uses the latest coalesced sample values when a timed rebuild fires', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 0 } },
    });

    const pending = sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    void sampleThrottle(throttle, { currentPowerW: 9700, capacityPaceKw: 8.7 });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // The rebuild ran for the later sample: judged against 9700 W, 9750 W is no
    // meaningful change, where against 9500 W it would be.
    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, { currentPowerW: 9750, capacityPaceKw: 20, planConvergenceActive: true });
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('creates a pending rebuild when a boundary sample arrives within the min interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 0 } },
    });

    const pending = sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });

    await vi.advanceTimersByTimeAsync(1999);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('resolves the pending promise with the cancel reason when the scheduler cancels a queued rebuild', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle, scheduler } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 0 } },
    });

    const pending = sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    scheduler.cancelAll('test_cancel');

    await expect(pending).resolves.toBe('test_cancel');
    await vi.advanceTimersByTimeAsync(2000);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not overwrite a queued hard-cap rebuild when a lower-priority signal request is dropped', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    // A stub scheduler on purpose: this case is about which intent wins the
    // queue, so nothing runs until the spec runs it.
    const scheduler = createTestPlanRebuildScheduler({
      getNowMs: Date.now,
      resolveDueAtMs: (_intent, atMs) => atMs + 1000,
      executeIntent: async () => undefined,
    });
    const throttle = new PlanRebuildThrottle({
      getScheduler: () => scheduler,
      getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
      getNowMs: Date.now,
      rebuildPlanFromCache,
    });
    // A first rebuild, run by hand, so the samples below are judged against one.
    const initial = sampleThrottle(throttle, { currentPowerW: 0 });
    await throttle.execute();
    await initial;
    rebuildPlanFromCache.mockClear();

    const hardCapPending = sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9 });
    const signalPending = sampleThrottle(throttle, { currentPowerW: 9_200, capacityPaceKw: 9 });
    await throttle.execute();
    await Promise.all([hardCapPending, signalPending]);

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');
  });

  it('skips rebuild when power change is below threshold and soft limit is stable', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 1000, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 5050, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild only because the soft limit changes', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 1000, reading: { currentPowerW: 5000, capacityPaceKw: 9 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 5000, capacityPaceKw: 8.2 });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild on danger zone entry with a small power delta', async () => {
    // Power crosses the 9 kW danger threshold with only a 30 W delta — below the 100 W
    // meaningful-delta threshold. Without headroom pressure or an exceeded max interval
    // there is no reason to rebuild; the previous plan is still valid.
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 1000, reading: { currentPowerW: 8980 } },
    });

    // Pace 10, not 9: against a 9 kW pace the reading is tight (-0.01 kW) and
    // would rebuild on the control boundary.
    await sampleThrottle(throttle, { currentPowerW: 9010, capacityPaceKw: 10 });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not rebuild when already in danger zone with no meaningful power change', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 1000, reading: { currentPowerW: 9050 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9060, capacityPaceKw: 10 });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds when sustained in danger zone after max interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 30_000, reading: { currentPowerW: 9050 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9060, capacityPaceKw: 10 });

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('max_interval');
  });

  it('does not rebuild while headroom stays safely positive even if power changes meaningfully', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 1000, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 6200, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds after max interval even if delta is small', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 30_000, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 5050, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  // The delta is measured against the last rebuild's own sample.
  it('rebuilds on a meaningful delta from the last rebuild power and stamps the new sample', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 5000 } },
    });

    // Headroom derives to +3.8 kW (not tight), so the rebuild can only come from
    // the delta branch, which is gated behind convergence.
    await sampleThrottle(throttle, { currentPowerW: 5200, capacityPaceKw: 9, planConvergenceActive: true });
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('power_sample_convergence');

    // Stamped: 5250 W is no meaningful change from 5200 W, where it would be from 5000 W.
    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, { currentPowerW: 5250, capacityPaceKw: 9, planConvergenceActive: true });
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('preserves a follow-up pending rebuild when a new boundary sample arrives during a timed rebuild', async () => {
    let resolveRebuild: ((outcome: RebuildOutcome) => void) | undefined;
    const rebuildPlanFromCache = vi.fn().mockImplementation(
      () => new Promise<RebuildOutcome>((resolve) => {
        resolveRebuild = resolve;
      }),
    );
    const logError = vi.fn();
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 1000 } },
    });

    const first = sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // Arrives while the first rebuild is in flight, so it queues behind it.
    const second = sampleThrottle(throttle, { currentPowerW: 9700, capacityPaceKw: 8.7 });
    resolveRebuild?.(unchangedRebuildOutcome());
    await first;
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    resolveRebuild?.(unchangedRebuildOutcome());
    await second;

    expect(logError).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('cancels pending timer and performs an immediate rebuild when interval is exceeded', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const logError = vi.fn();
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      logError,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 1000 } },
    });

    const first = sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    // The due time passes without the timer having run — a busy event loop.
    vi.setSystemTime(Date.now() + 2000);
    const second = sampleThrottle(throttle, { currentPowerW: 9700, capacityPaceKw: 8.8 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    await Promise.all([first, second]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('backs off repeated tight-headroom no-op rebuilds', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500, capacityPaceKw: 20 } },
    });
    const tightSample = { currentPowerW: 9500, capacityPaceKw: 9 };

    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // The no-op armed a 15 s backoff: nothing inside it rebuilds.
    await sampleThrottle(throttle, tightSample);
    await vi.advanceTimersByTimeAsync(14_999);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);

    // A second no-op in a row doubles it to 30 s.
    await vi.advanceTimersByTimeAsync(29_999);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(3);
  });

  // Nothing rebuilds on a price or budget period boundary by itself; the next
  // reading decides. A no-op backoff carried over from the old period must not
  // make that reading wait, or a sparse flow feed keeps the old period's
  // price-shifted setpoints through the new one.
  it('rebuilds the first reading in a new quarter-hour even inside no-op backoff', async () => {
    vi.setSystemTime(new Date('2024-01-01T00:14:50.000Z'));
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500, capacityPaceKw: 20 } },
    });
    const tightSample = { currentPowerW: 9500, capacityPaceKw: 9 };

    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // The no-op armed a 15 s backoff; 00:14:55 is inside it and inside the quarter.
    await vi.advanceTimersByTimeAsync(5_000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // 00:15:01 is still inside the backoff, but it is the first reading of the new quarter.
    await vi.advanceTimersByTimeAsync(6_000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(rebuildPlanFromCache).toHaveBeenLastCalledWith('headroom_tight');
  });

  it('lets meaningful power deltas bypass tight-headroom no-op backoff', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500, capacityPaceKw: 20 } },
    });
    await sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, { currentPowerW: 9700, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('resets tight-headroom no-op backoff when a rebuild applies actions', async () => {
    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce(unchangedRebuildOutcome())
      .mockResolvedValueOnce(actedRebuildOutcome())
      .mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500, capacityPaceKw: 20 } },
    });
    const tightSample = { currentPowerW: 9500, capacityPaceKw: 9 };

    await sampleThrottle(throttle, tightSample);
    await vi.advanceTimersByTimeAsync(15_000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);

    // The acting rebuild armed the 15 s mitigation holdoff…
    await vi.advanceTimersByTimeAsync(14_999);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(3);

    // …and reset the streak: the next no-op backs off 15 s, not the 30 s a
    // continued streak would.
    await vi.advanceTimersByTimeAsync(15_000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(4);
  });

  it('holds off the first unchanged shortfall sample after mitigation applies', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(actedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500 } },
    });
    const shortfallSample = { currentPowerW: 9500, capacityPaceKw: 9 };

    await sampleThrottle(throttle, shortfallSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('shortfall');

    await sampleThrottle(throttle, shortfallSample);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('lets meaningful power deltas bypass post-mitigation holdoff', async () => {
    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce(actedRebuildOutcome())
      .mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500 } },
    });
    await sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });

    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, { currentPowerW: 9700, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('bypasses tight no-op backoff for hard-cap breaches even once shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9300, capacityPaceKw: 9.5 } },
    });
    // A no-op in shortfall arms the backoff.
    await sampleThrottle(throttle, { currentPowerW: 9300, capacityPaceKw: 9.5 });

    // The same watts against a 9.2 kW threshold: a new hard-cap breach.
    await sampleThrottle(throttle, { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(rebuildPlanFromCache).toHaveBeenNthCalledWith(2, 'shortfall');
  });

  it('bypasses mitigation holdoff for the first hard-cap breach before shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce(actedRebuildOutcome())
      .mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9300, capacityPaceKw: 20 } },
    });
    // A tight rebuild that acted arms the mitigation holdoff.
    await sampleThrottle(throttle, { currentPowerW: 9300, capacityPaceKw: 9 });

    await sampleThrottle(throttle, { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(rebuildPlanFromCache).toHaveBeenNthCalledWith(2, 'hard_cap_breach');
  });

  it('skips unchanged repeated hard-cap breaches before shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const breach = { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 };
    // The last rebuild ran for this very breach: same deficit, same power.
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: breach },
    });

    await sampleThrottle(throttle, breach);
    // A skip keeps the breach remembered, so the repeat is still a repeat.
    await sampleThrottle(throttle, breach);

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds repeated hard-cap breaches when power changes meaningfully', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    // A 0.25 kW deficit both times: only the power delta can earn this rebuild.
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.05 } },
    });
    const movedBreach = { currentPowerW: 9450, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 };

    await sampleThrottle(throttle, movedBreach);
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');

    // The rebuild stamped the breach it ran for: repeating it is not new.
    await sampleThrottle(throttle, movedBreach);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('clears hard-cap breach state once a sample is no longer breached', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const breach = { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 };
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: breach },
    });

    await sampleThrottle(throttle, { currentPowerW: 9000, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 });
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    // The breach was forgotten, so the same breach again is a new one.
    await sampleThrottle(throttle, breach);
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');
  });

  it('uses shortfall as the rebuild reason while shortfall is active', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('shortfall');
  });

  // Regression: the CPU-watchdog crash-loop. A hard-cap breach with an oscillating
  // (meaningful-delta) uncontrolled load used to force a full ~1.4s rebuild on every
  // power sample even when nothing was actionable, saturating CPU.
  // Also guards the P1 fix: the throttled skip must NOT tell the guard anything
  // (entering shortfall here without a rebuild would let a stale "unactionable"
  // summary deadlock the unrecoverable-shortfall skip against ever discovering
  // returned load).
  it('throttles an unactionable hard-cap breach without entering shortfall from the skip', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle, recordReading } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 5000, reading: { currentPowerW: 10_400 } },
    });

    // 200 W delta vs last — "meaningful", but nothing to shed.
    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(recordReading).not.toHaveBeenCalled();
  });

  it('still refreshes an unactionable state once the max interval elapses', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 31_000, reading: { currentPowerW: 10_400 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not throttle a hard-cap breach when there is still something to shed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 5000, reading: { currentPowerW: 10_400 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: false });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not throttle an unactionable state while the plan is actively converging', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 5000, reading: { currentPowerW: 10_400 } },
    });

    await sampleThrottle(throttle, {
      currentPowerW: 10_600, capacityPaceKw: 9, planConvergenceActive: true, unactionable: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('allows one re-check rebuild when the invalidation latch is set, then clears the latch', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 20_000, reading: { currentPowerW: 10_400 } },
    });
    throttle.onObservation();

    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // Spent: a grown breach 16 s later (past any backoff, inside the max interval)
    // is held by the unactionable throttle again instead of rebuilding.
    await vi.advanceTimersByTimeAsync(16_000);
    await sampleThrottle(throttle, { currentPowerW: 10_800, capacityPaceKw: 9, unactionable: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  // A plan built before a device's state was known can read as unactionable.
  // The observation that reveals the device must survive the calm readings that
  // follow it, or the breach that device then causes waits out the max interval.
  it('keeps the invalidation latch across a reading that rebuilt nothing', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 500, limitKw: 1 } },
    });
    throttle.onObservation();

    await sampleThrottle(throttle, { currentPowerW: 500, limitKw: 1, unactionable: true, shortfallUnrecoverable: true });
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    // The breach decides: it waits out the 15 s execution floor, not the 30 s max interval.
    await vi.advanceTimersByTimeAsync(10_000);
    const breach = sampleThrottle(throttle, { currentPowerW: 10_000, limitKw: 1, unactionable: true, shortfallUnrecoverable: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await breach;
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');
  });

  it('clears the invalidation latch when a re-check rebuild fails (one-shot)', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ ...unchangedRebuildOutcome(), failed: true });
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 20_000, reading: { currentPowerW: 10_400 } },
    });
    throttle.onObservation();

    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(16_000);
    await sampleThrottle(throttle, { currentPowerW: 10_800, capacityPaceKw: 9, unactionable: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  // The plan queue resolves a failed build as `failed: true` rather than
  // rejecting, so this is the failure production actually delivers. It must back
  // off, or a planner failing on every build re-runs at the minimum cadence for
  // as long as the house stays tight.
  it('backs a failed tight rebuild off like a no-op', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ ...unchangedRebuildOutcome(), failed: true });
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 0 } },
    });
    const tightSample = { currentPowerW: 9500, capacityPaceKw: 9 };

    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('headroom_tight');

    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(13_000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('floors executed rebuilds while unactionable — even a hard-cap intent waits out the interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 5000, reading: { currentPowerW: 10_400 } },
    });
    throttle.onObservation();

    const pending = sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });

    await vi.advanceTimersByTimeAsync(9000);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('does not floor the first rebuild on a monotonic clock', async () => {
    // Reproduces prod: the rebuild clock is performance.now() (monotonic, small
    // values) and the throttle starts with no rebuild remembered. Were the floor
    // anchored to a zero timestamp instead of to a rebuild that ran, an
    // unactionable initial sample would floor its due time to 0 + 15_000 and
    // defer the first rebuild to uptime 15s, despite the initial sample being
    // required to rebuild immediately.
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    // The scheduler resolves the due time, so it must be on the SAME monotonic
    // clock as the call — on epoch time the bogus 15_000 floor would compare
    // against `Date.now()`, execute anyway, and hide a regression of the
    // no-rebuild-yet guard this test exists to catch.
    const { throttle } = await createTestPlanRebuildThrottle({
      getNowMs: () => 5000, // uptime 5s on a monotonic clock
      rebuildPlanFromCache,
    });

    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });
});

describe('PlanRebuildThrottle — intervals, breaches and the shortfall gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:05:00.000Z'));
    addPerfDurationMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds a calm house for a power delta only once the max interval has passed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 5000 } },
    });

    await vi.advanceTimersByTimeAsync(29_999);
    await sampleThrottle(throttle, { currentPowerW: 5300, capacityPaceKw: 9.5 });
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await sampleThrottle(throttle, { currentPowerW: 5300, capacityPaceKw: 9.5 });
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('power_delta');
  });

  it('rebuilds a converging plan on a power delta once the min interval has passed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 5300, capacityPaceKw: 9.5, planConvergenceActive: true });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('rebuilds convergence samples through the scheduler', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 11_000, shortfallThresholdKw: 12 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 11_000, planConvergenceActive: true });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    // The stub builds no plan, so no verdict reached the guard.
    expect(onShortfall).not.toHaveBeenCalled();
  });

  it('bypasses tight no-op backoff during newly observed hard-cap breaches', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9310, capacityPaceKw: 20 } },
    });
    // A tight no-op arms the backoff.
    await sampleThrottle(throttle, { currentPowerW: 9310, capacityPaceKw: 9 });
    const beforeSkippedBackoff = getPerfSnapshot().counts.plan_rebuild_skipped_tight_noop_backoff_total ?? 0;

    await sampleThrottle(throttle, {
      currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2, planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(rebuildPlanFromCache).toHaveBeenNthCalledWith(2, 'hard_cap_breach');
    expect(getPerfSnapshot().counts.plan_rebuild_skipped_tight_noop_backoff_total ?? 0).toBe(beforeSkippedBackoff);
  });

  it('skips signal scheduling for unchanged repeated hard-cap breaches', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const breach = { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 };
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: breach },
    });

    await sampleThrottle(throttle, breach);
    await sampleThrottle(throttle, breach);

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds repeated hard-cap breaches when the deficit grows without a power delta', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 } },
    });
    const grownBreach = { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.0 };

    await sampleThrottle(throttle, grownBreach);
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');

    // The 0.3 kW deficit is now the one remembered: repeating it has not grown.
    await sampleThrottle(throttle, grownBreach);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('still rebuilds repeated hard-cap breaches at the max interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const breach = { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 };
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 30_000, reading: breach },
    });

    await sampleThrottle(throttle, breach);

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');
  });

  it('rebuilds immediately when the hard-cap threshold is breached below the soft limit', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9310, capacityPaceKw: 9.5 } },
    });

    await sampleThrottle(throttle, {
      currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2, planConvergenceActive: true,
    });

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');
    // The stub builds no plan, so no verdict reached the guard.
    expect(onShortfall).not.toHaveBeenCalled();
  });

  it('coalesces convergence samples within the min interval', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 5000 } },
    });

    const pending = sampleThrottle(throttle, { currentPowerW: 5300, capacityPaceKw: 9.5, planConvergenceActive: true });
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('power_sample_convergence');
  });

  it('does not rebuild convergence samples when the delta is not meaningful', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 5050, capacityPaceKw: 9.5, planConvergenceActive: true });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rebuilds on tight headroom once the min interval has passed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9300, capacityPaceKw: 20 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9600, capacityPaceKw: 9.5 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('rebuilds on a hard-cap breach once the min interval has passed', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9310, capacityPaceKw: 9.5 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 });

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    // The stub builds no plan, so no verdict reached the guard.
    expect(onShortfall).not.toHaveBeenCalled();
  });

  it('runs immediately when a hard-cap breach preempts a pending timer', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 0, reading: { currentPowerW: 5000 } },
    });
    // A convergence rebuild queued behind the 2 s min interval.
    const pending = sampleThrottle(throttle, { currentPowerW: 5300, capacityPaceKw: 9.5, planConvergenceActive: true });

    await vi.advanceTimersByTimeAsync(1000);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    void sampleThrottle(throttle, { currentPowerW: 9300, capacityPaceKw: 9.5, shortfallThresholdKw: 9.2 });

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('hard_cap_breach');
    await pending;
  });

  // The throttle holds no device list, so a rebuild that changed nothing is not
  // evidence that nothing is left to shed: the planner also changes nothing
  // while it waits out a shed grace. The plan build tells the guard itself
  // (`reportShortfallToGuard`); this stub builds no plan, so the guard hears nothing.
  it('opens no incident from a rebuild that changed nothing, even over the hard cap', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 11_000, shortfallThresholdKw: 12 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 11_000 });

    expect(rebuildPlanFromCache).toHaveBeenCalledWith('hard_cap_breach');
    expect(onShortfall).not.toHaveBeenCalled();
    expect(capacityGuard.isInShortfall()).toBe(false);
  });

  it('does not enter shortfall for soft-limit-only no-op rebuilds', async () => {
    const onShortfall = vi.fn();
    const capacityGuard = createTestCapacityGuard({ homeId: 'main', onShortfall });
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9600, capacityPaceKw: 20 } },
    });

    await sampleThrottle(throttle, { currentPowerW: 9600, capacityPaceKw: 9 });

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('headroom_tight');
    expect(onShortfall).not.toHaveBeenCalled();
    expect(capacityGuard.isInShortfall()).toBe(false);
  });

  it('skips full rebuilds while shortfall is active and no actionable reduction remains', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    await capacityGuard.recordPlanVerdict(5.267, SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle, recordReading } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 5267 } },
    });

    await sampleThrottle(throttle, {
      currentPowerW: 5300, totalKw: 5.267, capacityPaceKw: 3.9, shortfallThresholdKw: SHORTFALL_THRESHOLD_KW, shortfallUnrecoverable: true,
    });

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(recordReading).toHaveBeenLastCalledWith(5.267, SHORTFALL_THRESHOLD_KW);
  });

  // Regression: the 2026-07-06 cpuwarn crash. A persistent unwinnable overshoot
  // (daily allowance clamped to 0, all managed devices shed, remaining draw
  // unmanaged) kept the overshoot incident open, which made the pipeline pass
  // `planConvergenceActive: true` and defeated the unrecoverable-shortfall skip —
  // a ~1.6s rebuild fired on every jittering power sample until Homey killed the
  // app. Composes the pipeline wiring: convergence derived from the plan state
  // WITH the unactionable summary must let the skip engage.
  it('suppresses the rebuild storm when overshoot persists but the plan is unactionable', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    await capacityGuard.recordPlanVerdict(5.267, SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 5267 } },
    });
    const planState = createPlanEngineState();
    planState.overshoot.enter(Date.now());
    const planUnactionable = true; // summary: nothing actionable, nothing reducible

    // ≥100 W jitter per sample — "meaningful" deltas that used to force a rebuild each time.
    for (const powerW of [5450, 5300, 5480]) {
      await sampleThrottle(throttle, {
        currentPowerW: powerW,
        totalKw: 5.267,
        capacityPaceKw: 3.9,
        shortfallThresholdKw: SHORTFALL_THRESHOLD_KW,
        planConvergenceActive: isPlanActivelyConverging(planState, { unactionable: planUnactionable }),
        shortfallUnrecoverable: true,
        unactionable: planUnactionable,
      });
    }

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('drives recovery checks during suppression then yields a rebuild at the max interval', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    await capacityGuard.recordPlanVerdict(5.267, SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle, recordReading } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 5267 } },
    });
    const recovering = {
      currentPowerW: 4600, capacityPaceKw: 3.9, shortfallThresholdKw: SHORTFALL_THRESHOLD_KW, shortfallUnrecoverable: true,
    };

    // Within the max interval, the unrecoverable-shortfall skip suppresses the full
    // rebuild but still hands the guard the reading, so recovery detection stays alive.
    await sampleThrottle(throttle, recovering);

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(recordReading).toHaveBeenCalledWith(4.6, SHORTFALL_THRESHOLD_KW);
    expect(capacityGuard.isInShortfall()).toBe(true);

    // Past the max interval, the escape yields a real rebuild rather than suppressing
    // forever — otherwise a stale "unactionable" summary could deadlock the skip.
    await vi.advanceTimersByTimeAsync(60_000);
    await sampleThrottle(throttle, recovering);

    expect(rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('rebuilds when shortfall suppression was invalidated by newly returned controlled load', async () => {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    await capacityGuard.recordPlanVerdict(5.267, SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(actedRebuildOutcome());
    const { throttle, recordReading } = await createTestPlanRebuildThrottle({
      capacityGuard,
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 5267 } },
    });
    const returnedLoad = {
      currentPowerW: 6100, capacityPaceKw: 3.9, shortfallThresholdKw: SHORTFALL_THRESHOLD_KW, shortfallUnrecoverable: true,
    };
    throttle.onObservation();

    await sampleThrottle(throttle, returnedLoad);
    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('shortfall');
    expect(recordReading).not.toHaveBeenCalled();

    // The re-check spent the latch: the next sample is held by the gate again.
    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, returnedLoad);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(recordReading).toHaveBeenCalledWith(6.1, SHORTFALL_THRESHOLD_KW);
  });

  it('records rebuild timing after the async rebuild settles', async () => {
    let resolveRebuild: ((outcome: RebuildOutcome) => void) | undefined;
    const rebuildPlanFromCache = vi.fn().mockImplementation(() => new Promise<RebuildOutcome>((resolve) => {
      resolveRebuild = resolve;
    }));
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2500, reading: { currentPowerW: 9300, capacityPaceKw: 20 } },
    });
    addPerfDurationMock.mockClear();

    const pending = sampleThrottle(throttle, { currentPowerW: 9600, capacityPaceKw: 9.5 });

    expect(addPerfDurationMock).not.toHaveBeenCalledWith('power_sample_rebuild_ms', expect.any(Number));

    vi.advanceTimersByTime(25);
    resolveRebuild?.(unchangedRebuildOutcome());
    await pending;

    expect(addPerfDurationMock).toHaveBeenCalledWith('power_sample_rebuild_ms', 25);
  });
});

// What a device observation may do to the throttle — and what it must leave alone.
describe('PlanRebuildThrottle.onObservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:05:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tightSample = { currentPowerW: 9500, capacityPaceKw: 9 };

  it('clears the no-op backoff built from a now-stale "nothing is actionable" verdict', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500, capacityPaceKw: 20 } },
    });
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    throttle.onObservation();

    // The 15 s backoff is gone: the next tight sample rebuilds at the min interval.
    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    // And so is the streak: this no-op backs off 15 s again, not 30 s.
    await vi.advanceTimersByTimeAsync(15_000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(3);
  });

  // The asymmetry is the point: a mitigation holdoff waits for a rebuild that
  // DID act to take effect before PELS decides again — and an observation is
  // frequently that action landing. Clearing it would make PELS re-decide on its
  // own command.
  it('leaves the post-mitigation holdoff alone', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(actedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 9500, capacityPaceKw: 20 } },
    });
    await sampleThrottle(throttle, tightSample);

    throttle.onObservation();

    await vi.advanceTimersByTimeAsync(2000);
    await sampleThrottle(throttle, tightSample);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the last rebuild untouched', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      lastRebuild: { msAgo: 2000, reading: { currentPowerW: 5000 } },
    });

    throttle.onObservation();

    // Still judged against the 5000 W rebuild: a 50 W change is not meaningful.
    await sampleThrottle(throttle, { currentPowerW: 5050, capacityPaceKw: 9, planConvergenceActive: true });
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});

// The unrecoverable-shortfall gate: a plan that proved nothing more can be shed
// holds a house in shortfall to the max-interval cadence. A held sample
// rebuilds nothing and instead hands the guard the reading it would otherwise
// only get from the rebuild — a reading, never a verdict that nothing is left.
describe('PlanRebuildThrottle — the unrecoverable-shortfall gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:05:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const heldSample = { currentPowerW: 5000, capacityPaceKw: 9, shortfallUnrecoverable: true };

  it('holds the rebuild while the shortfall is unrecoverable and unchanged, and hands the guard the reading', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle, recordReading } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 1000, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, heldSample);

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(recordReading).toHaveBeenCalledExactlyOnceWith(5, 10);
  });

  // The max-interval escape: a stale "unactionable" summary must never suppress
  // rebuilds forever — a returned load (e.g. a non-measure_power binary device
  // turned on externally, so the invalidation latch never fires) has to be
  // re-discovered.
  it('does NOT hold once the max interval has elapsed', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
      lastRebuild: { msAgo: 30_000, reading: { currentPowerW: 5000 } },
    });

    await sampleThrottle(throttle, heldSample);

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('shortfall');
  });

  it('never holds a first rebuild', async () => {
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
    const { throttle } = await createTestPlanRebuildThrottle({
      rebuildPlanFromCache,
      capacityGuard: await createGuardInShortfall(),
    });

    await sampleThrottle(throttle, heldSample);

    expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('initial');
  });

  it('does not hold when not in shortfall, latch-invalidated, converging, or recoverable', async () => {
    const throttleAfterRebuild = async (capacityGuard: Awaited<ReturnType<typeof createGuardInShortfall>>) => {
      const rebuildPlanFromCache = vi.fn().mockResolvedValue(unchangedRebuildOutcome());
      const { throttle } = await createTestPlanRebuildThrottle({
        rebuildPlanFromCache,
        capacityGuard,
        lastRebuild: { msAgo: 2000, reading: { currentPowerW: 5000 } },
      });
      return { throttle, rebuildPlanFromCache };
    };

    // Out of shortfall the gate does not apply; a tight sample then rebuilds as usual.
    const outOfShortfall = await throttleAfterRebuild(createTestCapacityGuard({ homeId: 'main' }));
    await sampleThrottle(outOfShortfall.throttle, { ...heldSample, capacityPaceKw: 5 });
    expect(outOfShortfall.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    const invalidated = await throttleAfterRebuild(await createGuardInShortfall());
    invalidated.throttle.onObservation();
    await sampleThrottle(invalidated.throttle, heldSample);
    expect(invalidated.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    const converging = await throttleAfterRebuild(await createGuardInShortfall());
    await sampleThrottle(converging.throttle, { ...heldSample, planConvergenceActive: true });
    expect(converging.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    const recoverable = await throttleAfterRebuild(await createGuardInShortfall());
    await sampleThrottle(recoverable.throttle, { ...heldSample, shortfallUnrecoverable: false });
    expect(recoverable.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });
});
