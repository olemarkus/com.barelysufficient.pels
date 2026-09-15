/**
 * The race that decides whether an observation has any effect at all.
 *
 * With the device-observation rebuild trigger gone, an observation's ONLY
 * remaining influence on the planner is clearing the rebuild suppressions so the
 * next reading is not throttled away (`PlanRebuildThrottle.onObservation`).
 *
 * A rebuild reads its devices at the start of its body and finishes hundreds of
 * milliseconds to seconds later. An observation landing inside that window is
 * about a house the in-flight rebuild never saw — so that rebuild's
 * "nothing is actionable" verdict must not be allowed to install a backoff or
 * clear the latch. At a ~1.4 s build against a 10 s poll this is a routine race.
 *
 * Each case runs one `shortfall` rebuild in an open incident, then probes what it
 * left behind with the next readings: a backoff shows as a tight reading that
 * does not rebuild, and a live latch as an unactionable reading that still does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RebuildOutcome } from '../../lib/plan/rebuildScheduler/policy';
import type { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import {
  actedRebuildOutcome,
  createGuardInShortfall,
  createTestPlanRebuildThrottle,
  sampleThrottle,
  unchangedRebuildOutcome,
} from '../helpers/powerRebuildScheduler';

const SHORTFALL_SAMPLE = { currentPowerW: 9_500, capacityPaceKw: 9 };

const runRebuild = async (params: {
  onFlight?: (throttle: PlanRebuildThrottle) => void;
  beforeDispatch?: (throttle: PlanRebuildThrottle) => void;
  outcome?: RebuildOutcome;
}) => {
  const rebuildPlanFromCache = vi.fn(async () => {
    const first = rebuildPlanFromCache.mock.calls.length === 1;
    // Mid-flight: the observation lands after the rebuild read its devices. The
    // stub only runs once the throttle below exists.
    if (first) params.onFlight?.(throttle);
    return first ? params.outcome ?? unchangedRebuildOutcome() : unchangedRebuildOutcome();
  });
  const { throttle } = await createTestPlanRebuildThrottle({
    rebuildPlanFromCache,
    capacityGuard: await createGuardInShortfall(),
    lastRebuild: { msAgo: 0, reading: { currentPowerW: 9_500, capacityPaceKw: 20 } },
  });
  // Queued behind the 2 s min interval, so there is a moment before dispatch.
  const sample = sampleThrottle(throttle, SHORTFALL_SAMPLE);
  params.beforeDispatch?.(throttle);
  await vi.advanceTimersByTimeAsync(2000);
  await sample;
  expect(rebuildPlanFromCache).toHaveBeenCalledExactlyOnceWith('shortfall');
  return { throttle, rebuildPlanFromCache };
};

/** A reading the unactionable throttle holds unless the latch is live; floored, so time is let pass. */
const probeUnactionable = async (throttle: PlanRebuildThrottle): Promise<void> => {
  const probe = sampleThrottle(throttle, { ...SHORTFALL_SAMPLE, unactionable: true });
  await vi.advanceTimersByTimeAsync(15_000);
  await probe;
};

describe('a device observation landing during an in-flight rebuild', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps its suppression clear instead of having it overwritten on completion', async () => {
    const { throttle, rebuildPlanFromCache } = await runRebuild({ onFlight: (t) => t.onObservation() });

    // Without the in-flight guard, the tight-noop outcome re-armed the backoff
    // and cleared the latch — on a verdict about the pre-observation house. Only
    // with neither does an unactionable reading still rebuild.
    await probeUnactionable(throttle);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  // The narrow exception: an observation must not cost a rebuild that ACTED its
  // settling window. That window is armed in the same step the in-flight guard
  // skips, and PELS's own command echo is exactly the observation that lands
  // mid-flight.
  it('still arms the post-mitigation holdoff when the overtaken rebuild acted', async () => {
    const { throttle, rebuildPlanFromCache } = await runRebuild({
      outcome: actedRebuildOutcome(),
      onFlight: (t) => t.onObservation(),
    });

    await sampleThrottle(throttle, SHORTFALL_SAMPLE);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    // …without paying for it with the latch the observation set.
    await vi.advanceTimersByTimeAsync(13_000);
    await probeUnactionable(throttle);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('does the same when the in-flight rebuild fails', async () => {
    const { throttle, rebuildPlanFromCache } = await runRebuild({
      outcome: { ...unchangedRebuildOutcome(), failed: true },
      onFlight: (t) => t.onObservation(),
    });

    await probeUnactionable(throttle);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  // The guard must not disarm the throttle generally: with no observation, a
  // tight no-op still installs its backoff exactly as before.
  it('still arms the backoff when no observation landed', async () => {
    const { throttle, rebuildPlanFromCache } = await runRebuild({});

    await sampleThrottle(throttle, SHORTFALL_SAMPLE);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(13_000);
    await sampleThrottle(throttle, SHORTFALL_SAMPLE);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('still clears the latch when the observation landed BEFORE dispatch', async () => {
    // The rebuild did see it, so the latch is a one-shot and must be spent here.
    const { throttle, rebuildPlanFromCache } = await runRebuild({ beforeDispatch: (t) => t.onObservation() });

    // Past the no-op backoff, an unactionable reading is held again.
    await vi.advanceTimersByTimeAsync(15_000);
    await probeUnactionable(throttle);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });
});
