import { vi, type MockInstance } from 'vitest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { RebuildOutcome } from '../../lib/plan/rebuildScheduler/policy';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import { createTestCapacityGuard, planVerdictSummaryFixture } from './createTestCapacityGuard';

/**
 * What `PlanService.rebuildPlanFromCache` resolves for a build that changed
 * nothing — the outcome a stub that builds no plan honestly stands for.
 */
export const unchangedRebuildOutcome = (): RebuildOutcome => ({
  actionChanged: false,
  appliedActions: false,
  failed: false,
});

/** The outcome of a build that acted: a tight rebuild that did so arms the mitigation holdoff. */
export const actedRebuildOutcome = (): RebuildOutcome => ({
  actionChanged: true,
  appliedActions: true,
  failed: false,
});

/**
 * One whole-home reading as the power pipeline hands it to the throttle, with
 * the plan posture beside it. Everything the throttle derives — headroom, the
 * hard-cap breach, whether an incident is latched — it derives itself from
 * these and from its guard, exactly as in production; a spec cannot state a
 * breach or a shortfall its own reading would not produce.
 */
export type ThrottleSampleForTest = {
  currentPowerW: number;
  /** Defaults to the sample's own watts: what the tracker latches for it. */
  totalKw?: number;
  limitKw?: number;
  /** Defaults to `limitKw`. */
  capacityPaceKw?: number;
  /** Defaults to `limitKw`. */
  shortfallThresholdKw?: number;
  planConvergenceActive?: boolean;
  unactionable?: boolean;
  shortfallUnrecoverable?: boolean;
};

export const sampleThrottle = (
  throttle: PlanRebuildThrottle,
  sample: ThrottleSampleForTest,
): Promise<void | string> => {
  const limitKw = sample.limitKw ?? 10;
  return throttle.onSample(
    {
      currentPowerW: sample.currentPowerW,
      totalKw: sample.totalKw ?? sample.currentPowerW / 1000,
      limitKw,
      capacityPaceKw: sample.capacityPaceKw ?? limitKw,
      shortfallThresholdKw: sample.shortfallThresholdKw ?? limitKw,
    },
    {
      planConvergenceActive: sample.planConvergenceActive ?? false,
      unactionable: sample.unactionable ?? false,
      shortfallUnrecoverable: sample.shortfallUnrecoverable ?? false,
    },
  );
};

type PlanRebuildSchedulerDeps = ConstructorParameters<typeof PlanRebuildScheduler>[0];

/**
 * A scheduler for a spec that states only when intents are due and what runs
 * them: real timers and the performance clock, and callbacks that report
 * nothing unless the spec passes its own.
 */
export const createTestPlanRebuildScheduler = (
  deps: Pick<PlanRebuildSchedulerDeps, 'resolveDueAtMs' | 'executeIntent'> & Partial<PlanRebuildSchedulerDeps>,
): PlanRebuildScheduler => new PlanRebuildScheduler({
  getNowMs: () => performance.now(),
  setTimeoutFn: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeoutFn: (handle) => clearTimeout(handle),
  onIntentDropped: () => undefined,
  onPendingIntentReplaced: () => undefined,
  onIntentCancelled: () => undefined,
  onIntentError: () => undefined,
  ...deps,
});

/** A capacity guard whose hard-cap incident is already open: the planner found nothing left to shed. */
export const createGuardInShortfall = async (
  options: Parameters<typeof createTestCapacityGuard>[0] = { homeId: 'main' },
): Promise<CapacityGuard> => {
  const guard = createTestCapacityGuard(options);
  await guard.recordPlanVerdict(99, 1, planVerdictSummaryFixture({ actionableLoadRemains: false }));
  return guard;
};

/**
 * A throttle and the scheduler it queues into, wired as production wires them
 * (`lib/plan/rebuildScheduler/homeRebuildRuntime.ts`): due times and execution
 * come back to the throttle, and a cancelled intent releases the rebuild queued
 * for it. The throttle starts from nothing remembered, at the production
 * cadence, so a spec reaches any state the way production does — readings,
 * time, rebuild outcomes and observations — and asserts on what it rebuilds.
 *
 * `lastRebuild` is the one shortcut, and it is not a back door: it sends
 * `reading` through the throttle as its first sample (answered by a build that
 * changed nothing, so the spec's own rebuild stub sees only what follows), then
 * lets `msAgo` of fake time pass. Requires fake timers when `msAgo` is non-zero.
 *
 * `recordReading` is a pass-through spy on the guard, so a spec can assert what
 * reading the throttle handed it without stubbing the guard away.
 */
export const createTestPlanRebuildThrottle = async (params: {
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome>;
  getNowMs?: () => number;
  logError?: (error: Error) => void;
  capacityGuard?: CapacityGuard;
  lastRebuild?: { msAgo: number; reading: ThrottleSampleForTest };
}): Promise<{ throttle: PlanRebuildThrottle; scheduler: PlanRebuildScheduler; recordReading: MockInstance }> => {
  const getNowMs = params.getNowMs ?? Date.now;
  const guard = params.capacityGuard ?? createTestCapacityGuard({ homeId: 'main' });
  const recordReading = vi.spyOn(guard, 'recordReading');
  let priming = params.lastRebuild !== undefined;
  const throttle: PlanRebuildThrottle = new PlanRebuildThrottle({
    getScheduler: () => scheduler,
    getCapacityGuard: () => guard,
    getNowMs,
    rebuildPlanFromCache: (trigger) => (
      priming ? Promise.resolve(unchangedRebuildOutcome()) : params.rebuildPlanFromCache(trigger)
    ),
  });
  const scheduler: PlanRebuildScheduler = createTestPlanRebuildScheduler({
    getNowMs,
    resolveDueAtMs: (intent, atMs) => throttle.dueAtMs(intent, atMs),
    executeIntent: () => throttle.execute(),
    onIntentCancelled: (_intent, reason) => throttle.cancel(reason),
    onIntentError: (_intent, error) => {
      params.logError?.(error);
    },
  });
  if (params.lastRebuild !== undefined) {
    await sampleThrottle(throttle, params.lastRebuild.reading);
    priming = false;
    recordReading.mockClear();
    if (params.lastRebuild.msAgo > 0) vi.advanceTimersByTime(params.lastRebuild.msAgo);
  }
  return { throttle, scheduler, recordReading };
};

/** A throttle for a context stub that never samples: a sample reaching it is a spec bug. */
export const createInertPlanRebuildThrottle = (): PlanRebuildThrottle => new PlanRebuildThrottle({
  getScheduler: () => createTestPlanRebuildScheduler({
    resolveDueAtMs: (_intent, atMs) => atMs,
    executeIntent: async () => {
      throw new Error('createInertPlanRebuildThrottle: this context stub was never meant to sample');
    },
    onIntentError: (_intent, error) => {
      throw error;
    },
  }),
  getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
  getNowMs: Date.now,
  rebuildPlanFromCache: async () => unchangedRebuildOutcome(),
});
