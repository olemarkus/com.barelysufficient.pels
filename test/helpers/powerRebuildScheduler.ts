import {
  cancelPendingPowerRebuild,
  executePendingPowerRebuild,
  schedulePlanRebuildFromPowerSample,
  type PowerSampleRebuildState,
} from '../../lib/plan/rebuildScheduler/powerDriven';
import { schedulePlanRebuildFromSignal } from '../../lib/plan/rebuildScheduler/signalDriven';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { HardCapBreach } from '../../lib/plan/rebuildScheduler/rebuildSignal';
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
      return executePendingPowerRebuild({ getState, setState }, getNowMs, rebuildPlanFromCache);
    },
    onIntentCancelled: (_intent, reason) => {
      cancelPendingPowerRebuild({ getState, setState }, reason);
    },
    onIntentError: (_intent, error) => {
      logError?.(error);
    },
  });
};

/**
 * Test-only adapter onto `schedulePlanRebuildFromPowerSample`.
 *
 * The production signature takes a resolved `PowerRebuildSignal` — every field
 * present — because the seam that builds one always has them. Specs care about
 * one or two fields at a time, so this fills the rest with neutral values and
 * keeps each case readable. It is a fixture builder, not a second code path:
 * the function under test is the real one.
 */
export const schedulePowerSampleForTest = (options: {
  scheduler: PlanRebuildScheduler;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs?: () => number;
  minIntervalMs: number;
  maxIntervalMs: number;
  limitKw: number;
  currentPowerW?: number;
  capacityPaceKw?: number;
  shortfallThresholdKw?: number;
  isInShortfall?: boolean;
  hardCapBreach?: HardCapBreach;
  planConvergenceActive?: boolean;
  unactionable?: boolean;
  onTightNoopHardCapBreach?: (deficitKw: number) => Promise<void>;
}): Promise<void | string> => {
  const currentPowerW = options.currentPowerW ?? 0;
  const capacityPaceKw = options.capacityPaceKw ?? options.limitKw;
  const totalKw = currentPowerW / 1000;
  return schedulePlanRebuildFromPowerSample(
    {
      scheduler: options.scheduler,
      getState: options.getState,
      setState: options.setState,
      getNowMs: options.getNowMs ?? Date.now,
    },
    {
      currentPowerW,
      totalKw,
      limitKw: options.limitKw,
      capacityPaceKw,
      // Always derived. An override let a spec state a headroom its own pace and
      // power could not produce, which is how five of them came to assert a cause
      // that never fired.
      headroomKw: capacityPaceKw - totalKw,
      shortfallThresholdKw: options.shortfallThresholdKw ?? options.limitKw,
      isInShortfall: options.isInShortfall ?? false,
      hardCapBreach: options.hardCapBreach ?? { breached: false, deficitKw: 0 },
      planConvergenceActive: options.planConvergenceActive ?? false,
      unactionable: options.unactionable ?? false,
    },
    options.minIntervalMs,
    options.maxIntervalMs,
    options.onTightNoopHardCapBreach ?? (async () => {}),
  );
};

/**
 * Test-only adapter onto `schedulePlanRebuildFromSignal`. Same rationale as
 * `schedulePowerSampleForTest`: the seam resolves a complete reading, specs
 * vary one field at a time. `totalKw` defaults to the sample's own watts
 * because that is what the tracker latches for it — a fixture convenience, not
 * a copy of production policy (the producer passes the latch and nothing else).
 */
export const scheduleSignalForTest = (options: {
  scheduler: PlanRebuildScheduler;
  capacityGuard: CapacityGuard;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs?: () => number;
  minIntervalMs: number;
  stableMinIntervalMs: number;
  maxIntervalMs: number;
  currentPowerW: number;
  totalKw?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityPaceKw?: number;
  shortfallThresholdKw?: number;
  planConvergenceActive?: boolean;
  skipWhileShortfallUnrecoverable?: boolean;
  unactionable?: boolean;
}): Promise<void | string> => schedulePlanRebuildFromSignal(
  {
    scheduler: options.scheduler,
    getState: options.getState,
    setState: options.setState,
    getNowMs: options.getNowMs ?? Date.now,
  },
  {
    minIntervalMs: options.minIntervalMs,
    stableMinIntervalMs: options.stableMinIntervalMs,
    maxIntervalMs: options.maxIntervalMs,
  },
  {
    currentPowerW: options.currentPowerW,
    totalKw: options.totalKw ?? options.currentPowerW / 1000,
    limitKw: options.capacitySettings.limitKw,
    capacityPaceKw: options.capacityPaceKw ?? options.capacitySettings.limitKw,
    shortfallThresholdKw: options.shortfallThresholdKw ?? options.capacitySettings.limitKw,
  },
  {
    planConvergenceActive: options.planConvergenceActive ?? false,
    unactionable: options.unactionable ?? false,
  },
  options.skipWhileShortfallUnrecoverable ?? false,
  options.capacityGuard,
);
