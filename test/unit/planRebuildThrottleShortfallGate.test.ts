import { describe, expect, it, vi } from 'vitest';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PowerRebuildSignal } from '../../lib/plan/rebuildScheduler/rebuildSignal';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { throttleMemoryFixture } from '../helpers/powerRebuildScheduler';

const signalWith = (overrides: Partial<PowerRebuildSignal> = {}): PowerRebuildSignal => ({
  currentPowerW: 5000,
  totalKw: 5,
  limitKw: 10,
  capacityPaceKw: 9,
  headroomKw: 4,
  shortfallThresholdKw: 10,
  isInShortfall: true,
  hardCapBreach: { breached: false, deficitKw: 0 },
  planConvergenceActive: false,
  unactionable: false,
  ...overrides,
});

// The unrecoverable-shortfall gate: a plan that proved nothing more can be shed
// holds a house in shortfall to the max-interval cadence. `request` counts what
// reached the scheduler (a stub that accepts and never executes, so a sample
// that got through is left un-awaited); a gated sample reaches nothing and
// instead hands the guard the deficit it would otherwise only learn from the
// rebuild.
const buildThrottle = (options: { lastRebuiltAtMs: number | null; suppressionInvalidated?: boolean }) => {
  const request = vi.fn(() => ({ status: 'accepted' as const, keptIntent: { kind: 'signal' as const, reason: 'shortfall' as const } }));
  const guard = createTestCapacityGuard({ homeId: 'main' });
  const checkShortfall = vi.spyOn(guard, 'checkShortfall');
  const throttle = new PlanRebuildThrottle(
    {
      getScheduler: () => ({ request }) as unknown as PlanRebuildScheduler,
      getCapacityGuard: () => guard,
      getNowMs: () => 10_000,
      rebuildPlanFromCache: async () => undefined,
    },
    { minIntervalMs: 0, stableMinIntervalMs: 0, maxIntervalMs: 30_000 },
    throttleMemoryFixture({
      lastRebuild: options.lastRebuiltAtMs === null
        ? null
        : { atMs: options.lastRebuiltAtMs, powerW: 5000, hardCapBreach: { breached: false, deficitKw: 0 } },
      suppressionInvalidated: options.suppressionInvalidated ?? false,
    }),
  );
  return { throttle, request, checkShortfall };
};

const sample = (
  throttle: PlanRebuildThrottle,
  signal: PowerRebuildSignal,
  shortfallUnrecoverable = true,
): void => {
  void throttle.onSignal(signal, {
    planConvergenceActive: signal.planConvergenceActive,
    unactionable: signal.unactionable,
    shortfallUnrecoverable,
  });
};

describe('PlanRebuildThrottle — the unrecoverable-shortfall gate', () => {
  it('holds the rebuild while the shortfall is unrecoverable and unchanged, and reports the deficit', () => {
    const { throttle, request, checkShortfall } = buildThrottle({ lastRebuiltAtMs: 9_000 });
    sample(throttle, signalWith());
    expect(request).not.toHaveBeenCalled();
    expect(checkShortfall).toHaveBeenCalledTimes(1);
  });

  // The max-interval escape: a stale "unactionable" summary must never suppress
  // rebuilds forever — a returned load (e.g. a non-measure_power binary device
  // turned on externally, so the invalidation latch never fires) has to be
  // re-discovered.
  it('does NOT hold once the max interval has elapsed', () => {
    const { throttle, request } = buildThrottle({ lastRebuiltAtMs: 10_000 - 30_000 });
    sample(throttle, signalWith());
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never holds a first rebuild', () => {
    const { throttle, request } = buildThrottle({ lastRebuiltAtMs: null });
    sample(throttle, signalWith());
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not hold when not in shortfall, latch-invalidated, converging, or recoverable', () => {
    // Out of shortfall the gate does not apply; a tight sample then rebuilds as usual.
    const outOfShortfall = buildThrottle({ lastRebuiltAtMs: 9_000 });
    sample(outOfShortfall.throttle, signalWith({ isInShortfall: false, capacityPaceKw: 5, headroomKw: 0 }));
    expect(outOfShortfall.request).toHaveBeenCalledTimes(1);

    const invalidated = buildThrottle({ lastRebuiltAtMs: 9_000, suppressionInvalidated: true });
    sample(invalidated.throttle, signalWith());
    expect(invalidated.request).toHaveBeenCalledTimes(1);

    const converging = buildThrottle({ lastRebuiltAtMs: 9_000 });
    sample(converging.throttle, signalWith({ planConvergenceActive: true }));
    expect(converging.request).toHaveBeenCalledTimes(1);

    const recoverable = buildThrottle({ lastRebuiltAtMs: 9_000 });
    sample(recoverable.throttle, signalWith(), false);
    expect(recoverable.request).toHaveBeenCalledTimes(1);
  });
});
