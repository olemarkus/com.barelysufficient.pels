import { describe, expect, it, vi } from 'vitest';
import type { SubHomeMembershipReadyEdge } from '../../lib/home/subHomeMembershipReadyEdge';
import { SubHomeOwnershipGeneration } from '../../lib/home/subHomeOwnershipGeneration';
import type { SubHomeSampleRevision } from '../../lib/home/subHomeRecovery';
import { SubHomeRuntime } from '../../lib/home/subHomeRuntime';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { PlanRebuildRequestOptions, PlanRebuildTrigger } from '../../lib/plan/planRebuildTrigger';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { partialDouble } from '../helpers/partialDouble';

const home = { homeId: 'h_a', name: 'Annex', rootZoneId: 'zone-annex', meterDeviceId: 'meter-annex' };

type SampleLedgerWrite = (next: SubHomeSampleRevision) => void;

// One area's ownership-generation lane over a scripted sample ledger. The
// rebuild double runs the caller's point-of-use abort exactly as the plan
// service does, and `onRebuild` lets a spec move the ledger mid-rebuild.
const buildLane = (onRebuild: (setSample: SampleLedgerWrite) => void = () => {}) => {
  const runtime = new SubHomeRuntime(home, () => true, () => true, () => false);
  let sample: SubHomeSampleRevision = { state: 'stable', revision: 7 };
  const setSample: SampleLedgerWrite = (next) => { sample = next; };
  const rebuildPlanFromCache = vi.fn(async (_trigger: PlanRebuildTrigger, options?: PlanRebuildRequestOptions) => {
    onRebuild(setSample);
    if (options?.shouldAbort?.()) options.onAbort?.();
    return { failed: false, gated: false };
  });
  const endPreparedReconcile = vi.fn();
  const beginPreparedReconcile = vi.fn(() => endPreparedReconcile);
  const flushDeferredShortfallSideEffect = vi.fn().mockResolvedValue(true);
  const markPreparedOwnershipGenerationReconciled = vi.fn();
  const logError = vi.fn();
  const lane = new SubHomeOwnershipGeneration(
    {
      runtime,
      timers: new TimerRegistry(),
      timerKey: (suffix) => `home:h_a:${suffix}`,
      getLogger: () => partialDouble<PinoLogger>({ error: logError }),
      planService: { rebuildPlanFromCache },
      pipeline: { getStableSampleRevision: () => sample },
      beginPreparedReconcile,
      flushDeferredShortfallSideEffect,
    },
    partialDouble<SubHomeMembershipReadyEdge>({ markPreparedOwnershipGenerationReconciled }),
  );
  return {
    lane,
    runtime,
    setSample,
    rebuildPlanFromCache,
    beginPreparedReconcile,
    endPreparedReconcile,
    flushDeferredShortfallSideEffect,
    markPreparedOwnershipGenerationReconciled,
    logError,
  };
};

describe('sub-home ownership-generation lane', () => {
  it('prepares nothing while a sample is still being ingested', async () => {
    const rig = buildLane();
    rig.setSample({ state: 'pending' });
    await expect(rig.lane.prepare()).resolves.toEqual({ state: 'pending' });
    expect(rig.rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('prepares at the stable revision, and not once a newer sample lands mid-rebuild', async () => {
    const rig = buildLane();
    await expect(rig.lane.prepare()).resolves.toEqual({ state: 'stable', revision: 7 });
    expect(rig.rebuildPlanFromCache).toHaveBeenCalledWith('home_membership_changed');
    expect(rig.lane.isPreparedCurrent(7)).toBe(true);

    const moved = buildLane((setSample) => setSample({ state: 'stable', revision: 8 }));
    await expect(moved.lane.prepare()).resolves.toEqual({ state: 'pending' });
    expect(moved.lane.isPreparedCurrent(7)).toBe(false);
  });

  it('prepares nothing when the membership rebuild fails, and logs a thrown one', async () => {
    const contained = buildLane();
    contained.rebuildPlanFromCache.mockResolvedValueOnce({ failed: true, gated: false });
    await expect(contained.lane.prepare()).resolves.toEqual({ state: 'pending' });
    expect(contained.logError).not.toHaveBeenCalled();

    const thrown = buildLane();
    thrown.rebuildPlanFromCache.mockRejectedValueOnce(new Error('planner exploded'));
    await expect(thrown.lane.prepare()).resolves.toEqual({ state: 'pending' });
    expect(thrown.logError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_membership_bundle_rebuild_failed',
      homeId: 'h_a',
    }));
  });

  it('applies a current prepared plan behind the fence, flushes, and consumes the ready edge', async () => {
    const rig = buildLane();
    await expect(rig.lane.reconcilePrepared(7)).resolves.toBe(true);
    expect(rig.rebuildPlanFromCache).toHaveBeenCalledWith(
      'home_ownership_generation_prepared',
      expect.objectContaining({ shouldAbort: expect.any(Function), onAbort: expect.any(Function) }),
    );
    expect(rig.beginPreparedReconcile).toHaveBeenCalledWith(7);
    expect(rig.endPreparedReconcile).toHaveBeenCalledOnce();
    expect(rig.flushDeferredShortfallSideEffect).toHaveBeenCalledOnce();
    expect(rig.markPreparedOwnershipGenerationReconciled).toHaveBeenCalledOnce();
  });

  it('holds the side effects and the ready edge when the prepared plan went stale or failed', async () => {
    const stale = buildLane((setSample) => setSample({ state: 'stable', revision: 8 }));
    await expect(stale.lane.reconcilePrepared(7)).resolves.toBe(false);
    expect(stale.endPreparedReconcile).toHaveBeenCalledOnce();
    expect(stale.flushDeferredShortfallSideEffect).not.toHaveBeenCalled();
    expect(stale.markPreparedOwnershipGenerationReconciled).not.toHaveBeenCalled();

    const failed = buildLane();
    failed.rebuildPlanFromCache.mockResolvedValueOnce({ failed: true, gated: false });
    await expect(failed.lane.reconcilePrepared(7)).resolves.toBe(false);
    expect(failed.flushDeferredShortfallSideEffect).not.toHaveBeenCalled();

    const unflushed = buildLane();
    unflushed.flushDeferredShortfallSideEffect.mockResolvedValueOnce(false);
    await expect(unflushed.lane.reconcilePrepared(7)).resolves.toBe(false);
    expect(unflushed.markPreparedOwnershipGenerationReconciled).not.toHaveBeenCalled();
  });

  it('treats a torn-down area as never current and never rebuilds it for a membership change', async () => {
    const rig = buildLane();
    rig.runtime.markTornDown();
    expect(rig.lane.isPreparedCurrent(7)).toBe(false);
    await expect(rig.lane.rebuildForMembershipChange()).resolves.toBe(false);
    expect(rig.rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});
