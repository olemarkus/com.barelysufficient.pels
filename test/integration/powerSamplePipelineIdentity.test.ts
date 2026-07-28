// The sampled-meter identity publication contract of the admitted ingest seam
// (`PowerSamplePipeline`): the identity, the watts, and their timestamp move as
// ONE operation. Publication fires at the persisted-watts point of the ingest
// (after the tracker write, before the rebuild it awaits), with the ingest's
// own `nowMs`; a request superseded by coalescing drops its
// identity claim together with its watts; samples that carry no identity field
// (flow, sub-home meters) never publish. This is the seam that makes the fence
// unable to move ahead of — or on different evidence than — the tracker.
import { describe, expect, it, vi } from 'vitest';

const T0 = Date.parse('2026-07-27T10:00:00Z');
import { PowerSamplePipeline } from '../../setup/powerSamplePipeline';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';

const buildPipeline = (
  noteResolvedHomeMeter?: (deviceId: string | null, sampleAtMs: number) => void,
  savedStates: PowerTrackerState[] = [],
  noteHomeMeterArrangement?: (observation: string, sampleAtMs: number) => void,
  onRebuildRequest?: () => void,
) => {
  const powerTracker: PowerTrackerState = {};
  // Power-driven scheduling stages a pending promise on this state and awaits
  // it; the scheduler stub below "executes" each accepted intent immediately by
  // resolving that staged promise, so the ingest path settles like production.
  let rebuildState: { lastMs: number; lastRebuildPowerW: number; pendingResolve?: (r?: string) => void } = {
    lastMs: 0,
    lastRebuildPowerW: 0,
  };
  return new PowerSamplePipeline({
    getPowerTracker: () => powerTracker,
    getCapacitySettings: () => ({ limitKw: 12, marginKw: 0.5 }),
    getCapacityGuard: () => undefined,
    getPlanEngine: () => ({
      state: {
        pendingSheds: new Set<string>(),
        pendingRestores: new Set<string>(),
        pendingTargetCommands: {},
        pendingBinaryCommands: {},
        wasOvershoot: false,
      },
      clearStartupRestoreStabilization: vi.fn(),
    } as unknown as PlanEngine),
    getPlanService: () => ({
      getLatestPlanSnapshot: () => null,
      getLatestPlanSnapshotUpdatedAtMs: () => null,
      rebuildPlanFromCache: vi.fn(async () => ({ failed: false })),
    } as unknown as PlanService),
    getDeviceManager: () => undefined,
    planRebuildScheduler: {
      request: vi.fn(() => {
        onRebuildRequest?.();
        rebuildState.pendingResolve?.('executed');
        return { status: 'accepted' };
      }),
    } as unknown as PlanRebuildScheduler,
    getPowerSampleRebuildState: () => rebuildState,
    setPowerSampleRebuildState: (state) => { rebuildState = state as typeof rebuildState; },
    getLatestTargetSnapshot: () => [],
    getPlanRebuildNowMs: () => Date.now(),
    savePowerTracker: (state) => { savedStates.push(state); },
    getStructuredDebugEmitter: () => vi.fn(),
    ...(noteResolvedHomeMeter === undefined ? {} : { noteResolvedHomeMeter }),
    ...(noteHomeMeterArrangement === undefined ? {} : { noteHomeMeterArrangement }),
  });
};

describe('PowerSamplePipeline resolved-meter identity publication', () => {
  it('publishes the identity with the ingest timestamp, AFTER the watts landed', async () => {
    // The whole point of ingest-time publication: when the fence consumer hears
    // about the identity, the tracker persistence must already carry the watts
    // it belongs to. Captured INSIDE the callback, not asserted after the fact.
    const savedStates: PowerTrackerState[] = [];
    const persistedTimestampAtNote: Array<number | undefined> = [];
    const note = vi.fn(() => {
      persistedTimestampAtNote.push(savedStates.at(-1)?.lastTimestamp);
    });
    const pipeline = buildPipeline(note, savedStates);

    await pipeline.recordPowerSample(4_200, T0, { resolvedHomeMeterDeviceId: 'm-area' });

    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith('m-area', T0);
    expect(persistedTimestampAtNote).toEqual([T0]);
  });

  it('publishes the identity BEFORE the rebuild the sample triggers', async () => {
    // The fence must move before any control consumer runs: the first rebuild
    // an identity-changing sample triggers has to plan under the membership
    // that sample implies. Publication after the awaited rebuild let Main
    // command devices from an area's watts for one full plan cycle.
    const order: string[] = [];
    const pipeline = buildPipeline(
      () => { order.push('note'); },
      [],
      undefined,
      () => { order.push('rebuild'); },
    );

    await pipeline.recordPowerSample(4_200, T0, { resolvedHomeMeterDeviceId: 'm-area' });

    expect(order).toEqual(['note', 'rebuild']);
  });

  it('publishes a NULL identity (unknown provenance) on the same terms', async () => {
    const note = vi.fn();
    const pipeline = buildPipeline(note);

    await pipeline.recordPowerSample(4_200, T0 + 10_000, { resolvedHomeMeterDeviceId: null });

    expect(note).toHaveBeenCalledWith(null, T0 + 10_000);
  });

  it('never publishes meter identity for samples that carry no identity field', async () => {
    const note = vi.fn();
    const pipeline = buildPipeline(note);

    await pipeline.recordPowerSample(4_200, T0);
    await pipeline.recordPowerSample(4_200, T0 + 100, { generationW: 500 });

    expect(note).not.toHaveBeenCalled();
  });

  it('a coalesced-away request drops its identity claim together with its watts', async () => {
    const note = vi.fn();
    const pipeline = buildPipeline(note);

    // Three synchronous requests: the first starts the loop; the second is
    // queued then REPLACED by the third before the loop reruns. The replaced
    // request's identity must never publish — its watts never landed either.
    const first = pipeline.recordPowerSample(4_000, T0, { resolvedHomeMeterDeviceId: 'm-first' });
    const superseded = pipeline.recordPowerSample(4_100, T0 + 100, { resolvedHomeMeterDeviceId: 'm-superseded' });
    const last = pipeline.recordPowerSample(4_200, T0 + 200, { resolvedHomeMeterDeviceId: 'm-last' });
    const outcomes = await Promise.all([first, superseded, last]);

    expect(note.mock.calls).toEqual([
      ['m-first', T0],
      ['m-last', T0 + 200],
    ]);
    expect(outcomes).toEqual([
      { state: 'superseded', revision: 1, latestRevision: 3 },
      { state: 'superseded', revision: 2, latestRevision: 3 },
      { state: 'admitted', revision: 3 },
    ]);
  });

  it('publishes the arrangement with the identity, same stamp, same admitted ingest', async () => {
    const calls: Array<[string, number]> = [];
    const pipeline = buildPipeline(vi.fn(), [], (observation, sampleAtMs) => {
      calls.push([observation, sampleAtMs]);
    });

    await pipeline.recordPowerSample(4_200, T0, {
      resolvedHomeMeterDeviceId: null,
      homeMeterArrangement: 'idless_aggregate_only',
    });

    expect(calls).toEqual([['idless_aggregate_only', T0]]);
  });

  it('never publishes an arrangement for samples that carry none', async () => {
    const note = vi.fn();
    const pipeline = buildPipeline(vi.fn(), [], note);

    await pipeline.recordPowerSample(4_200, T0, { resolvedHomeMeterDeviceId: 'm-1' });

    expect(note).not.toHaveBeenCalled();
  });

  it('contains a publisher throw so it can never break the sample loop', async () => {
    const note = vi.fn(() => { throw new Error('membership exploded'); });
    const pipeline = buildPipeline(note);

    await expect(
      pipeline.recordPowerSample(4_200, T0 + 20_000, { resolvedHomeMeterDeviceId: 'm-area' }),
    ).resolves.toEqual({ state: 'admitted', revision: 1 });
    expect(pipeline.getStableSampleRevision()).toEqual({ state: 'stable', revision: 1 });
  });
});
