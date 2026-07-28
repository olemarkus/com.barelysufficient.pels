import { describe, expect, it, vi } from 'vitest';

import type { PlanService } from '../../lib/plan/planService';
import type { PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from '../../lib/plan/rebuildScheduler/policy';
import type { RebuildIntent, SchedulerState } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildIntentPolicy } from '../../setup/planRebuildIntentPolicy';

// `FLOW_REBUILD_COALESCE_MS` is 0 under NODE_ENV=test (the suite must not be
// delayed); the trailing cooldown is 1 s in every environment.
const FLOW_COOLDOWN_MS = 1000;
const NOW_MS = 10_000;

const hardCap: RebuildIntent = { kind: 'hardCap', reason: 'hard_cap' };
const signal: RebuildIntent = { kind: 'signal', reason: 'power_sample' };
const flow: RebuildIntent = { kind: 'flow', reason: 'flow_card:set_deadline' };

const buildSchedulerState = (overrides: Partial<SchedulerState> = {}): SchedulerState => ({
  nowMs: NOW_MS,
  activeIntent: null,
  pendingIntent: null,
  pendingDueMs: null,
  hasTimer: false,
  lastCompletedAtMsByKind: {},
  ...overrides,
});

const buildPolicy = (options: {
  rebuildState?: PowerSampleRebuildState;
  planRebuildNowMs?: number;
} = {}) => {
  let rebuildState: PowerSampleRebuildState = options.rebuildState ?? { lastMs: 0 };
  const rebuildPlanFromCache = vi.fn(async () => undefined);
  const policy = new PlanRebuildIntentPolicy({
    getPowerSampleRebuildState: () => rebuildState,
    setPowerSampleRebuildState: (state) => { rebuildState = state; },
    getPlanRebuildNowMs: () => options.planRebuildNowMs ?? NOW_MS,
    getPlanService: () => ({ rebuildPlanFromCache } as unknown as PlanService),
  });
  return { policy, rebuildPlanFromCache, getRebuildState: () => rebuildState };
};

describe('PlanRebuildIntentPolicy.resolveDueAtMs', () => {
  it('runs a hardCap intent immediately when nothing is holding the floor', () => {
    const { policy } = buildPolicy();
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(NOW_MS);
  });

  it('holds a signal intent until its own pending due time', () => {
    const { policy } = buildPolicy({ rebuildState: { lastMs: 0, pendingDueMs: 12_500 } });
    expect(policy.resolveDueAtMs(signal, buildSchedulerState())).toBe(12_500);
  });

  it('applies the tight-unactionable execution floor to both power-driven kinds', () => {
    const lastMs = 9_000;
    const { policy } = buildPolicy({ rebuildState: { lastMs, tightUnactionable: true } });
    const expected = lastMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS;
    expect(policy.resolveDueAtMs(hardCap, buildSchedulerState())).toBe(expected);
    expect(policy.resolveDueAtMs(signal, buildSchedulerState())).toBe(expected);
  });

  it('does not apply the floor to a scheduler that has never run (lastMs === 0)', () => {
    // With a monotonic clock `lastMs === 0` is process start, so `0 + interval`
    // is a real future time that would wrongly defer the very first rebuild.
    const { policy } = buildPolicy({ rebuildState: { lastMs: 0, tightUnactionable: true } });
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
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('flow_card:set_deadline');
  });

  it('routes power-driven intents through the pending-rebuild state machine', async () => {
    const { policy, rebuildPlanFromCache, getRebuildState } = buildPolicy({
      rebuildState: { lastMs: 0, pendingReason: 'power_sample' },
      planRebuildNowMs: 42_000,
    });
    await policy.executeIntent(signal);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('power_sample');
    // The state machine stamped the execution time through the injected setter.
    expect(getRebuildState().lastMs).toBe(42_000);
  });
});
