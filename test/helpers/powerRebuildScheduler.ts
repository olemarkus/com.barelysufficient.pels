import {
  cancelPendingPowerRebuild,
  executePendingPowerRebuild,
  type PowerSampleRebuildState,
} from '../../lib/plan/rebuildScheduler/powerDriven';
import type { RebuildOutcome } from '../../lib/plan/rebuildScheduler/policy';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from '../../lib/plan/rebuildScheduler/policy';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';

/**
 * The power-sample scheduler these specs used to get for free.
 *
 * `schedulePlanRebuildFromPowerSample` used to build one lazily and memoize it on
 * `PowerSampleRebuildState.legacyScheduler` when no scheduler was injected. Production
 * never took that path — `setup/powerSamplePipeline.ts` always injects the app's
 * `planRebuildScheduler` — so it existed only for these tests, and the field it
 * memoized into sat on a production state type for their benefit.
 *
 * The wiring is reproduced verbatim (same due-time floor, same execute/cancel/error
 * hooks) so the coalescing and back-off assertions keep measuring what they measured.
 * `setup/homeRuntime/createHomeCapacityBundle.ts` builds the production equivalent with
 * the same `resolveDueAtMs` shape plus `ctx.timers` wiring; the two are deliberately
 * separate — a test double that borrowed the bundle's timer registry would not be one.
 */
export const createTestPowerRebuildScheduler = (params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  getNowMs?: () => number;
  logError?: (error: Error) => void;
}): PlanRebuildScheduler => {
  const {
    getState,
    setState,
    rebuildPlanFromCache,
    getNowMs = Date.now,
    logError,
  } = params;
  return new PlanRebuildScheduler({
    getNowMs,
    resolveDueAtMs: (intent, state) => {
      const st = getState();
      // Execution-side floor: while nothing is actionable, no trigger (signal or
      // hardCap) may execute a rebuild faster than the floor after the last one.
      // Anchored to `lastMs` (set only on a real execution). Requires `lastMs > 0`:
      // an un-run scheduler is process start, and `0 + interval` is a real future
      // time that would wrongly defer the very first (initial-sample) rebuild.
      const floorMs = st.tightUnactionable === true && st.lastMs > 0
        ? st.lastMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS
        : Number.NEGATIVE_INFINITY;
      if (intent.kind === 'hardCap') return Math.max(state.nowMs, floorMs);
      if (intent.kind === 'signal') return Math.max(st.pendingDueMs ?? state.nowMs, floorMs);
      return Number.POSITIVE_INFINITY;
    },
    executeIntent: (intent) => {
      if (intent.kind !== 'signal' && intent.kind !== 'hardCap') return undefined;
      return executePendingPowerRebuild({
        getState,
        setState,
        getNowMs,
        rebuildPlanFromCache,
      });
    },
    onIntentCancelled: (_intent, reason) => {
      cancelPendingPowerRebuild({ getState, setState, reason });
    },
    onIntentError: (_intent, error) => {
      logError?.(error);
    },
  });
};
