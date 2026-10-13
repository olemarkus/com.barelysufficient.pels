import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubHomeSampleRevision } from '../../lib/home/subHomeRecovery';
import { SubHomeSourceRecovery } from '../../lib/home/subHomeSourceRecovery';
import { SubHomeRuntime } from '../../lib/home/subHomeRuntime';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { PlanRebuildRequestOptions, PlanRebuildTrigger } from '../../lib/plan/planRebuildTrigger';

const RETRY_TIMER_KEY = 'home:h_a:sourceActuationRetry';
const timerKey = (suffix: string): string => `home:h_a:${suffix}`;
const home = { homeId: 'h_a', name: 'Annex', rootZoneId: 'zone-annex', meterDeviceId: 'meter-annex' };

describe('sub-home source-authority actuation recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for an authoritative source and stable sample, then rebuilds once', async () => {
    const timers = new TimerRegistry();
    let sourceAuthorized = false;
    let sample: SubHomeSampleRevision = { state: 'pending' };
    const abortDecisions: boolean[] = [];
    const rebuildPlanFromCache = vi.fn().mockImplementation(async (
      _trigger: PlanRebuildTrigger,
      options?: PlanRebuildRequestOptions,
    ) => {
      abortDecisions.push(options?.shouldAbort?.() ?? false);
      return { failed: false, appliedActions: false };
    });
    const endPreparedReconcile = vi.fn();
    const beginPreparedReconcile = vi.fn(() => endPreparedReconcile);
    const flushDeferredShortfallSideEffect = vi.fn().mockResolvedValue(true);
    const recovery = new SubHomeSourceRecovery({
      runtime: new SubHomeRuntime(home, () => true, () => sourceAuthorized, () => false),
      timers,
      timerKey,
      getLogger: () => undefined,
      planService: { rebuildPlanFromCache },
      pipeline: { getStableSampleRevision: () => sample },
      beginPreparedReconcile,
      flushDeferredShortfallSideEffect,
    });

    recovery.schedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(timers.has(RETRY_TIMER_KEY)).toBe(true);

    sourceAuthorized = true;
    sample = { state: 'stable', revision: 7 };
    await vi.advanceTimersByTimeAsync(2_000);

    expect(rebuildPlanFromCache).toHaveBeenCalledOnce();
    expect(rebuildPlanFromCache).toHaveBeenCalledWith(
      'home_source_authority_recovered',
      expect.objectContaining({
        shouldAbort: expect.any(Function),
        onAbort: expect.any(Function),
      }),
    );
    expect(beginPreparedReconcile).toHaveBeenCalledWith(7);
    // The rebuild ran behind a clean fence — one convergence, not a rebuild
    // followed by a separate re-assert of the plan it just built.
    expect(abortDecisions).toEqual([false]);
    expect(endPreparedReconcile).toHaveBeenCalledOnce();
    expect(flushDeferredShortfallSideEffect).toHaveBeenCalledOnce();
    expect(timers.has(RETRY_TIMER_KEY)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rebuildPlanFromCache).toHaveBeenCalledOnce();
  });

  it('does not release a held shortfall transition after a failed fresh rebuild', async () => {
    const timers = new TimerRegistry();
    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce({ failed: true })
      .mockResolvedValue({ failed: false });
    const flushDeferredShortfallSideEffect = vi.fn().mockResolvedValue(true);
    const recovery = new SubHomeSourceRecovery({
      runtime: new SubHomeRuntime(home, () => true, () => true, () => false),
      timers,
      timerKey,
      getLogger: () => undefined,
      planService: { rebuildPlanFromCache },
      pipeline: { getStableSampleRevision: () => ({ state: 'stable', revision: 7 }) },
      beginPreparedReconcile: () => () => undefined,
      flushDeferredShortfallSideEffect,
    });

    recovery.schedule();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(flushDeferredShortfallSideEffect).not.toHaveBeenCalled();
    expect(timers.has(RETRY_TIMER_KEY)).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(flushDeferredShortfallSideEffect).toHaveBeenCalledOnce();
    expect(timers.has(RETRY_TIMER_KEY)).toBe(false);
  });
});
