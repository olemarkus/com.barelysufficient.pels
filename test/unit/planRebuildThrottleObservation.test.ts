import { describe, expect, it } from 'vitest';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { throttleMemoryFixture } from '../helpers/powerRebuildScheduler';

// What a device observation may do to the throttle's memory — and what it must
// leave alone. The scheduler stub never executes; only `onObservation` runs.
const suppressedThrottle = (holdoffCause: 'noop' | 'mitigation'): PlanRebuildThrottle => new PlanRebuildThrottle(
  {
    getScheduler: () => ({ request: () => ({ status: 'accepted' }) }) as unknown as PlanRebuildScheduler,
    getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
    getNowMs: () => 10_000,
    rebuildPlanFromCache: async () => undefined,
  },
  { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 30_000 },
  throttleMemoryFixture({
    lastRebuild: { atMs: 1_000, powerW: 4_000, hardCapBreach: { breached: false, deficitKw: 0 } },
    noopStreak: 3,
    holdoff: { untilMs: 120_000, cause: holdoffCause },
    observationSeq: 7,
  }),
);

describe('PlanRebuildThrottle.onObservation', () => {
  it('clears the two suppressions built from a now-stale "nothing is actionable" verdict', () => {
    const throttle = suppressedThrottle('noop');
    throttle.onObservation();
    expect(throttle.snapshot()).toMatchObject({
      suppressionInvalidated: true,
      noopStreak: 0,
      holdoff: null,
    });
  });

  // The asymmetry is the point: a mitigation holdoff waits for a rebuild that
  // DID act to take effect before PELS decides again — and an observation is
  // frequently that action landing. Clearing it would make PELS re-decide on its
  // own command.
  it('leaves the post-mitigation holdoff alone', () => {
    const throttle = suppressedThrottle('mitigation');
    throttle.onObservation();
    expect(throttle.snapshot().holdoff).toEqual({ untilMs: 120_000, cause: 'mitigation' });
  });

  it('bumps the observation counter and leaves the last rebuild untouched', () => {
    const throttle = suppressedThrottle('noop');
    throttle.onObservation();
    expect(throttle.snapshot().observationSeq).toBe(8);
    expect(throttle.snapshot().lastRebuild).toEqual({
      atMs: 1_000, powerW: 4_000, hardCapBreach: { breached: false, deficitKw: 0 },
    });
  });
});
