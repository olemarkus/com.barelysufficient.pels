import type { PlanService } from '../lib/plan/planService';
import {
  initialPlanRebuildThrottleMemory,
  PlanRebuildThrottle,
  type PlanRebuildThrottleDeps,
} from '../lib/plan/rebuildScheduler/throttle';
import type { PlanRebuildScheduler, RebuildIntent } from '../lib/plan/rebuildScheduler/scheduler';
import type { RebuildCadence } from '../lib/plan/rebuildScheduler/rebuildSignal';

/**
 * How often a home's rebuild throttle may rebuild — one cadence for every
 * home. Collapsed under `NODE_ENV=test` so a suite is not paced by it.
 */
export const powerSampleRebuildCadence = (): RebuildCadence => ({
  minIntervalMs: process.env.NODE_ENV === 'test' ? 0 : 2000,
  stableMinIntervalMs: process.env.NODE_ENV === 'test' ? 0 : 15000,
  maxIntervalMs: process.env.NODE_ENV === 'test' ? 100 : 30 * 1000,
});

/** A home's rebuild throttle at the app's cadence, starting from nothing remembered. */
export const createHomePlanRebuildThrottle = (deps: PlanRebuildThrottleDeps): PlanRebuildThrottle => (
  new PlanRebuildThrottle(deps, powerSampleRebuildCadence(), initialPlanRebuildThrottleMemory())
);

const FLOW_REBUILD_COOLDOWN_MS = 1000;
// Leading window before the first flow rebuild runs, so a burst of settings cards in one
// flow (e.g. set deadline -> allow rescue -> allow rescue) coalesces into a single re-solve
// / one plan revision. 0 in tests so the suite is not delayed.
const FLOW_REBUILD_COALESCE_MS = process.env.NODE_ENV === 'test' ? 0 : 1000;

/**
 * Scheduler clock for the app's plan rebuilds. Under `NODE_ENV=test` (and
 * wherever `performance.now` is unavailable) it reads `Date.now()` so a suite
 * driving fake timers advances it — which is why a `createApp` e2e using fake
 * timers MUST fake `'Date'` (see `test/AGENTS.md`).
 */
export const getAppPlanRebuildNowMs = (): number => (
  process.env.NODE_ENV === 'test'
  || typeof performance === 'undefined'
  || typeof performance.now !== 'function'
    ? Date.now()
    : performance.now()
);

export type PlanRebuildIntentPolicyDeps = {
  /** Late-bound: the throttle is constructed after the scheduler this policy serves. */
  getPlanRebuildThrottle: () => PlanRebuildThrottle;
  getPlanService: () => PlanService;
};

/**
 * The two decisions `PlanRebuildScheduler` delegates back to the app: WHEN a
 * queued rebuild intent may run and HOW it is executed. Power-driven intents
 * (`signal`, `hardCap`) are the throttle's — it queued them, it knows their due
 * time and runs them; this policy owns only the flow coalesce/cooldown window.
 */
export class PlanRebuildIntentPolicy {
  constructor(private readonly deps: PlanRebuildIntentPolicyDeps) {}

  resolveDueAtMs(intent: RebuildIntent, state: ReturnType<PlanRebuildScheduler['now']>): number {
    const nowMs = state.nowMs;
    if (intent.kind === 'hardCap' || intent.kind === 'signal') {
      return this.deps.getPlanRebuildThrottle().dueAtMs(intent, nowMs);
    }
    if (intent.kind === 'flow') {
      if (state.activeIntent?.kind === 'flow') {
        return Number.POSITIVE_INFINITY;
      }
      const lastCompletedAtMs = state.lastCompletedAtMsByKind.flow ?? Number.NEGATIVE_INFINITY;
      // Leading coalesce window holds the first rebuild a beat so a multi-card flow collapses
      // into one re-solve; the trailing cooldown still throttles subsequent bursts.
      return Math.max(nowMs + FLOW_REBUILD_COALESCE_MS, lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS);
    }
    return Number.POSITIVE_INFINITY;
  }

  executeIntent(intent: RebuildIntent): Promise<void> {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      return this.deps.getPlanRebuildThrottle().execute();
    }
    return this.deps.getPlanService()
      .rebuildPlanFromCache(intent.reason, { detail: intent.detail })
      .then(() => undefined);
  }
}
