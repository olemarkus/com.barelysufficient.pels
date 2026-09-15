import { describe, expect, it, vi } from 'vitest';

import type { PlanService } from '../../lib/plan/planService';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from '../../lib/plan/rebuildScheduler/policy';
import type { PlanRebuildScheduler, RebuildIntent, SchedulerState } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import { PlanRebuildIntentPolicy } from '../../lib/plan/rebuildScheduler/intentPolicy';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { sampleThrottle, unchangedRebuildOutcome } from '../helpers/powerRebuildScheduler';

// `FLOW_REBUILD_COALESCE_MS` is 0 under NODE_ENV=test (the suite must not be
// delayed); the trailing cooldown is 1 s in every environment.
const FLOW_COOLDOWN_MS = 1000;
const NOW_MS = 10_000;

const hardCap: RebuildIntent = { kind: 'hardCap', reason: 'hard_cap_breach' };
const signal: RebuildIntent = { kind: 'signal', reason: 'power_delta' };
const flow: RebuildIntent = { kind: 'flow', reason: 'flow_card', detail: 'set_deadline' };

const buildSchedulerState = (overrides: Partial<SchedulerState> = {}): SchedulerState => ({
  nowMs: NOW_MS,
  activeIntent: null,
  pendingIntent: null,
  pendingDueMs: null,
  hasTimer: false,
  lastCompletedAtMsByKind: {},
  ...overrides,
});

// The throttle behind the policy, over a scheduler stub that only accepts:
// these cases are about the policy's delegation, so the spec runs a queued
// rebuild by hand when it needs one to have happened. `clock.nowMs` is the
// throttle's clock.
const buildPolicy = () => {
  const clock = { nowMs: NOW_MS };
  const rebuildPlanFromCache = vi.fn(async () => unchangedRebuildOutcome());
  const scheduler = {
    request: () => ({ status: 'accepted' as const, keptIntent: signal }),
  } as unknown as PlanRebuildScheduler;
  const throttle = new PlanRebuildThrottle({
    getScheduler: () => scheduler,
    getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
    getNowMs: () => clock.nowMs,
    rebuildPlanFromCache,
  });
  const policy = new PlanRebuildIntentPolicy({
    getPlanRebuildThrottle: () => throttle,
    getPlanService: () => ({ rebuildPlanFromCache } as unknown as PlanService),
  });
  /** A first rebuild, run by hand at `atMs` for a reading of `powerW`. */
  const rebuildAt = async (atMs: number, powerW = 0): Promise<void> => {
    clock.nowMs = atMs;
    const sample = sampleThrottle(throttle, { currentPowerW: powerW, capacityPaceKw: 20 });
    await throttle.execute();
    await sample;
    rebuildPlanFromCache.mockClear();
  };
  return { policy, throttle, clock, rebuildAt, rebuildPlanFromCache };
};

describe('PlanRebuildIntentPolicy.resolveDueAtMs', () => {
  it('runs a hardCap intent immediately when nothing is holding the floor', () => {
    const { policy } = buildPolicy();
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(NOW_MS);
  });

  it('holds a signal intent until the throttle\'s own queued due time', async () => {
    // Last rebuilt 500 ms ago at a 2 s minimum: the request queues for 1.5 s from now.
    const { policy, throttle, clock, rebuildAt } = buildPolicy();
    await rebuildAt(NOW_MS - 500);
    clock.nowMs = NOW_MS;
    void sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    expect(policy.resolveDueAtMs(signal, buildSchedulerState())).toBe(11_500);
  });

  it('applies the tight-unactionable execution floor to both power-driven kinds', async () => {
    const atMs = 9_000;
    const { policy, throttle, clock, rebuildAt } = buildPolicy();
    await rebuildAt(atMs);
    // An unactionable breach: held, and it leaves the decision unactionable.
    clock.nowMs = NOW_MS;
    await sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });
    const expected = atMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS;
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(expected);
    expect(policy.resolveDueAtMs(signal, buildSchedulerState())).toBe(expected);
  });

  it('does not apply the floor to a throttle that has never rebuilt', () => {
    // Nothing to anchor the floor to: a first rebuild is never deferred, even
    // when the decision that queued it was unactionable.
    const { policy, throttle } = buildPolicy();
    void sampleThrottle(throttle, { currentPowerW: 10_600, capacityPaceKw: 9, unactionable: true });
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(NOW_MS);
  });

  it('drops a flow intent while another flow rebuild is already active', () => {
    const { policy } = buildPolicy();
    const state = buildSchedulerState({ activeIntent: flow });
    expect(policy.resolveDueAtMs(flow, state)).toBe(Number.POSITIVE_INFINITY);
  });

  it('throttles a flow intent by the trailing cooldown after the last flow rebuild', () => {
    const { policy } = buildPolicy();
    const state = buildSchedulerState({ lastCompletedAtMsByKind: { flow: 9_800 } });
    expect(policy.resolveDueAtMs(flow, state)).toBe(9_800 + FLOW_COOLDOWN_MS);
  });

  it('lets a flow intent run at once once the cooldown has elapsed', () => {
    const { policy } = buildPolicy();
    const state = buildSchedulerState({ lastCompletedAtMsByKind: { flow: NOW_MS - 5_000 } });
    expect(policy.resolveDueAtMs(flow, state)).toBe(NOW_MS);
  });
});

describe('PlanRebuildIntentPolicy.executeIntent', () => {
  it('routes a flow intent straight to a cache rebuild carrying its reason', async () => {
    const { policy, rebuildPlanFromCache } = buildPolicy();
    await expect(policy.executeIntent(flow)).resolves.toBeUndefined();
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('flow_card', { detail: 'set_deadline' });
  });

  it('routes power-driven intents to the throttle, which runs what it queued', async () => {
    const { policy, throttle, clock, rebuildAt, rebuildPlanFromCache } = buildPolicy();
    await rebuildAt(0, 4000);
    // A meaningful delta on a calm home past the max interval: queued as a `power_delta` rebuild.
    clock.nowMs = 42_000;
    void sampleThrottle(throttle, { currentPowerW: 5000, capacityPaceKw: 9 });
    await policy.executeIntent(signal);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('power_delta');
    // The throttle stamped the execution time from its own clock: the next
    // boundary sample is due the min interval after it.
    void sampleThrottle(throttle, { currentPowerW: 9500, capacityPaceKw: 9 });
    expect(policy.resolveDueAtMs(signal, buildSchedulerState({ nowMs: 42_000 }))).toBe(44_000);
  });
});
