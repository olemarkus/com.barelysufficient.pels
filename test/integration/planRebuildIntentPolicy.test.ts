import { describe, expect, it, vi } from 'vitest';

import type { PlanService } from '../../lib/plan/planService';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from '../../lib/plan/rebuildScheduler/policy';
import type { PlanRebuildScheduler, RebuildIntent, SchedulerState } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildThrottle, type PlanRebuildThrottleMemory } from '../../lib/plan/rebuildScheduler/throttle';
import { PlanRebuildIntentPolicy } from '../../setup/planRebuildIntentPolicy';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { schedulePowerSampleForTest, throttleMemoryFixture } from '../helpers/powerRebuildScheduler';

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

const rebuiltAt = (atMs: number, powerW = 0): PlanRebuildThrottleMemory['lastRebuild'] => ({
  atMs, powerW, hardCapBreach: { breached: false, deficitKw: 0 },
});

// The throttle behind the policy, over a scheduler stub that only accepts:
// these cases are about the policy's delegation, not about executing.
const buildPolicy = (options: {
  memory?: Partial<PlanRebuildThrottleMemory>;
  planRebuildNowMs?: number;
} = {}) => {
  const rebuildPlanFromCache = vi.fn(async () => undefined);
  const scheduler = {
    request: () => ({ status: 'accepted' as const, keptIntent: signal }),
  } as unknown as PlanRebuildScheduler;
  const throttle = new PlanRebuildThrottle(
    {
      getScheduler: () => scheduler,
      getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
      getNowMs: () => options.planRebuildNowMs ?? NOW_MS,
      rebuildPlanFromCache,
    },
    { minIntervalMs: 2000, stableMinIntervalMs: 2000, maxIntervalMs: 30_000 },
    throttleMemoryFixture(options.memory),
  );
  const policy = new PlanRebuildIntentPolicy({
    getPlanRebuildThrottle: () => throttle,
    getPlanService: () => ({ rebuildPlanFromCache } as unknown as PlanService),
  });
  return { policy, throttle, rebuildPlanFromCache };
};

describe('PlanRebuildIntentPolicy.resolveDueAtMs', () => {
  it('runs a hardCap intent immediately when nothing is holding the floor', () => {
    const { policy } = buildPolicy();
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(NOW_MS);
  });

  it('holds a signal intent until the throttle\'s own queued due time', async () => {
    // Last rebuilt 500 ms ago at a 2 s minimum: the request queues for 1.5 s from now.
    const { policy, throttle } = buildPolicy({ memory: { lastRebuild: rebuiltAt(NOW_MS - 500) } });
    void schedulePowerSampleForTest({ throttle, limitKw: 10, currentPowerW: 9500, capacityPaceKw: 9 });
    expect(throttle.snapshot().queued?.dueMs).toBe(11_500);
    expect(policy.resolveDueAtMs(signal, buildSchedulerState())).toBe(11_500);
  });

  it('applies the tight-unactionable execution floor to both power-driven kinds', () => {
    const atMs = 9_000;
    const { policy } = buildPolicy({ memory: { lastRebuild: rebuiltAt(atMs), lastDecisionUnactionable: true } });
    const expected = atMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS;
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(expected);
    expect(policy.resolveDueAtMs(signal, buildSchedulerState())).toBe(expected);
  });

  it('does not apply the floor to a throttle that has never rebuilt', () => {
    // Nothing to anchor the floor to: a first rebuild is never deferred.
    const { policy } = buildPolicy({ memory: { lastRebuild: null, lastDecisionUnactionable: true } });
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
    const { policy, throttle, rebuildPlanFromCache } = buildPolicy({
      memory: { lastRebuild: rebuiltAt(NOW_MS - 20_000, 4000) },
      planRebuildNowMs: 42_000,
    });
    // A meaningful delta on a calm home: queued as a `power_delta` rebuild.
    void schedulePowerSampleForTest({ throttle, limitKw: 10, currentPowerW: 5000, capacityPaceKw: 9 });
    expect(throttle.snapshot().queued?.trigger).toBe('power_delta');
    await policy.executeIntent(signal);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('power_delta');
    // The throttle stamped the execution time from its own clock.
    expect(throttle.snapshot().lastRebuild?.atMs).toBe(42_000);
  });
});
