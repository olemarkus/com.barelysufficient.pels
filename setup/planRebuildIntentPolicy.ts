import type { PlanService } from '../lib/plan/planService';
import {
  executePendingPowerRebuild,
  type PowerSampleRebuildState,
} from '../lib/plan/rebuildScheduler/powerDriven';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from '../lib/plan/rebuildScheduler/policy';
import type { PlanRebuildScheduler, RebuildIntent } from '../lib/plan/rebuildScheduler/scheduler';

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
  getPowerSampleRebuildState: () => PowerSampleRebuildState;
  setPowerSampleRebuildState: (state: PowerSampleRebuildState) => void;
  /**
   * The scheduler's own clock read (`scheduler.now().nowMs`, which resolves back
   * to `getAppPlanRebuildNowMs` above). Injected rather than called directly so
   * a test can stamp a deterministic execution time without faking timers.
   */
  getPlanRebuildNowMs: () => number;
  getPlanService: () => PlanService;
};

/**
 * The two decisions `PlanRebuildScheduler` delegates back to the app: WHEN a
 * queued rebuild intent may run (per-kind due time, including the tight-
 * unactionable execution floor and the flow coalesce/cooldown window), and HOW
 * it is executed (power-driven intents go through the pending-rebuild state
 * machine; a flow intent is a plain cache rebuild).
 */
export class PlanRebuildIntentPolicy {
  constructor(private readonly deps: PlanRebuildIntentPolicyDeps) {}

  resolveDueAtMs(intent: RebuildIntent, state: ReturnType<PlanRebuildScheduler['now']>): number {
    const nowMs = state.nowMs;
    const rebuildState = this.deps.getPowerSampleRebuildState();
    // Execution-side floor: while nothing is actionable, no trigger (signal or
    // hardCap) may execute a rebuild faster than the floor after the last one.
    // Anchored to `lastMs` (set only on a real execution) so `now` deterministically
    // passes it after the interval rather than sliding forward on each recompute.
    // Requires `lastMs > 0`: with a monotonic clock (`performance.now`) an un-run
    // scheduler (`lastMs === 0`) is process start, and `0 + interval` is a real
    // future time that would wrongly defer the very first (initial-sample) rebuild.
    const floorMs = rebuildState.tightUnactionable === true
      && rebuildState.lastMs > 0
      ? rebuildState.lastMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS
      : Number.NEGATIVE_INFINITY;
    if (intent.kind === 'hardCap') return Math.max(nowMs, floorMs);
    if (intent.kind === 'signal') {
      return Math.max(rebuildState.pendingDueMs ?? nowMs, floorMs);
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
      return executePendingPowerRebuild({
        getState: () => this.deps.getPowerSampleRebuildState(),
        setState: (state) => {
          this.deps.setPowerSampleRebuildState(state);
        },
        getNowMs: () => this.deps.getPlanRebuildNowMs(),
        rebuildPlanFromCache: (trigger) => this.deps.getPlanService().rebuildPlanFromCache(trigger),
      });
    }
    return this.deps.getPlanService()
      .rebuildPlanFromCache(intent.reason, { detail: intent.detail })
      .then(() => undefined);
  }
}
