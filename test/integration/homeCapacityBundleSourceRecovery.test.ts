import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanService } from '../../lib/plan/planService';
import { installHomeCapacityBundleSourceRecovery } from '../../setup/homeRuntime/homeCapacityBundleSourceRecovery';
import type { StableSampleRevision } from '../../setup/powerSamplePipeline';
import { createAppContextMock } from '../helpers/appContextTestHelpers';

describe('sub-home source-authority actuation recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for an authoritative source and stable sample, then rebuilds once', async () => {
    const ctx = createAppContextMock();
    let sourceAuthorized = false;
    let sample: StableSampleRevision = { state: 'pending' };
    const abortDecisions: boolean[] = [];
    const rebuildPlanFromCache = vi.fn().mockImplementation(async (
      _reason?: string,
      shouldAbort?: () => boolean,
    ) => {
      abortDecisions.push(shouldAbort?.() ?? false);
      return { failed: false, appliedActions: false };
    });
    const endPreparedReconcile = vi.fn();
    const beginPreparedReconcile = vi.fn(() => endPreparedReconcile);
    const flushDeferredShortfallSideEffect = vi.fn().mockResolvedValue(true);
    const recovery = installHomeCapacityBundleSourceRecovery({
      ctx,
      homeId: 'h_a',
      timerKey: 'source-retry',
      planService: { rebuildPlanFromCache } as unknown as PlanService,
      isTornDown: () => false,
      isMembershipReady: () => true,
      isMeterSourceAuthorized: () => sourceAuthorized,
      isMeterSourceEpochDiscarded: () => false,
      getStableSampleRevision: () => sample,
      beginPreparedReconcile,
      flushDeferredShortfallSideEffect,
    });

    recovery.schedule();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(ctx.timers.has('source-retry')).toBe(true);

    sourceAuthorized = true;
    sample = { state: 'stable', revision: 7 };
    await vi.advanceTimersByTimeAsync(2_000);

    expect(rebuildPlanFromCache).toHaveBeenCalledOnce();
    expect(rebuildPlanFromCache).toHaveBeenCalledWith(
      'home_source_authority_recovered',
      expect.any(Function),
      expect.any(Function),
    );
    expect(beginPreparedReconcile).toHaveBeenCalledWith(7);
    // The rebuild ran behind a clean fence — one convergence, not a rebuild
    // followed by a separate re-assert of the plan it just built.
    expect(abortDecisions).toEqual([false]);
    expect(endPreparedReconcile).toHaveBeenCalledOnce();
    expect(flushDeferredShortfallSideEffect).toHaveBeenCalledOnce();
    expect(ctx.timers.has('source-retry')).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rebuildPlanFromCache).toHaveBeenCalledOnce();
  });

  it('does not release a held shortfall transition after a failed fresh rebuild', async () => {
    const ctx = createAppContextMock();
    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce({ failed: true })
      .mockResolvedValue({ failed: false });
    const flushDeferredShortfallSideEffect = vi.fn().mockResolvedValue(true);
    const recovery = installHomeCapacityBundleSourceRecovery({
      ctx,
      homeId: 'h_a',
      timerKey: 'source-retry',
      planService: { rebuildPlanFromCache } as unknown as PlanService,
      isTornDown: () => false,
      isMembershipReady: () => true,
      isMeterSourceAuthorized: () => true,
      isMeterSourceEpochDiscarded: () => false,
      getStableSampleRevision: () => ({ state: 'stable', revision: 7 }),
      beginPreparedReconcile: () => () => undefined,
      flushDeferredShortfallSideEffect,
    });

    recovery.schedule();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(flushDeferredShortfallSideEffect).not.toHaveBeenCalled();
    expect(ctx.timers.has('source-retry')).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(flushDeferredShortfallSideEffect).toHaveBeenCalledOnce();
    expect(ctx.timers.has('source-retry')).toBe(false);
  });
});
