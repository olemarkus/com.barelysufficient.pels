import type CapacityGuard from '../../power/capacityGuard';
import { buildNullCapacityStateSummary } from '../../power/capacityStateSummary';
import { addPerfDuration, incPerfCounter } from '../../utils/perfCounters';
import {
  resetShortfallSuppressionInvalidationWhenRecovered,
  shouldSkipUnrecoverableShortfallRebuild,
} from './shortfallSuppression';
import {
  resolveHardCapBreachFromSignal,
  resolveHeadroomTight,
} from './policy';
import {
  schedulePlanRebuildFromPowerSample,
  type PowerSampleRebuildState,
} from './powerDriven';
import { PlanRebuildScheduler } from './scheduler';

const resolveEffectiveSignalMinIntervalMs = (params: {
  minIntervalMs: number;
  stableMinIntervalMs?: number;
  planConvergenceActive?: boolean;
  headroomTight: boolean;
  isInShortfall: boolean;
  hardCapBreached: boolean;
}): number => {
  const {
    minIntervalMs,
    stableMinIntervalMs,
    planConvergenceActive,
    headroomTight,
    isInShortfall,
    hardCapBreached,
  } = params;
  const stableIntervalMs = typeof stableMinIntervalMs === 'number' ? stableMinIntervalMs : minIntervalMs;
  const effectiveMinIntervalMs = (
    planConvergenceActive === true
    || headroomTight
    || isInShortfall
    || hardCapBreached
  )
    ? minIntervalMs
    : Math.max(minIntervalMs, stableIntervalMs);
  if (effectiveMinIntervalMs > minIntervalMs) {
    incPerfCounter('plan_rebuild_signal_stable_interval_total');
  }
  return effectiveMinIntervalMs;
};

export function schedulePlanRebuildFromSignal(params: {
  scheduler: PlanRebuildScheduler;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs?: () => number;
  minIntervalMs: number;
  stableMinIntervalMs?: number;
  maxIntervalMs: number;
  currentPowerW?: number;
  powerDeltaW?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityGuard: CapacityGuard;
  /**
   * `capacityPaceKw` — the planner's live hourly threshold, resolved by the
   * caller. The scheduler compares the latched total against it to decide how
   * urgently to rebuild, so it must be the same number the planner acts on.
   */
  capacityPaceKw: number;
  /**
   * The tracker's latched whole-home total in kW, resolved by the caller
   * (`resolveLastTotalPowerKw`). `null` = no trustworthy reading, in which case
   * headroom falls back to the incoming sample.
   *
   * Same sample as `currentPowerW`, not an older one: the tracker core calls
   * `saveState` before it awaits the rebuild this path serves
   * (`lib/power/tracker.ts`), so the latch already holds the incoming reading.
   * The two differ in resolution, not in age — this one is finiteness-gated and
   * in kW, which is why the raw watts are only a fallback.
   */
  latchedTotalKw: number | null;
  /**
   * Producer-resolved `computeShortfallThreshold` — a pure function of the
   * hard cap and the tracker, so the caller computes it from data it holds.
   */
  shortfallThresholdKw: number;
  planConvergenceActive?: boolean;
  skipWhileShortfallUnrecoverable?: boolean;
  unactionable?: boolean;
}): Promise<void | string> {
  const rebuildStart = Date.now();
  const {
    scheduler,
    getState,
    setState,
    getNowMs = Date.now,
    minIntervalMs,
    stableMinIntervalMs,
    maxIntervalMs,
    currentPowerW,
    powerDeltaW,
    capacitySettings,
    capacityGuard,
    capacityPaceKw,
    latchedTotalKw,
    shortfallThresholdKw,
    planConvergenceActive,
    skipWhileShortfallUnrecoverable = false,
    unactionable,
  } = params;
  const fallbackHeadroomKw = typeof currentPowerW === 'number' ? capacityPaceKw - currentPowerW / 1000 : null;
  const headroomKw = latchedTotalKw !== null ? capacityPaceKw - latchedTotalKw : fallbackHeadroomKw;
  const isInShortfall = capacityGuard.isInShortfall() ?? false;
  const currentState = resetShortfallSuppressionInvalidationWhenRecovered({
    state: getState(),
    isInShortfall,
    setState,
  });
  const hardCapBreach = resolveHardCapBreachFromSignal({
    currentPowerW,
    latchedTotalKw,
    shortfallThresholdKw,
  });
  const maxIntervalExceeded = maxIntervalMs > 0
    && (getNowMs() - currentState.lastMs) >= maxIntervalMs;
  if (shouldSkipUnrecoverableShortfallRebuild({
    skipWhileShortfallUnrecoverable,
    state: currentState,
    isInShortfall,
    planConvergenceActive,
    maxIntervalExceeded,
  })) {
    incPerfCounter('plan_rebuild_skipped_shortfall_unrecoverable_total');
    return Promise.resolve(capacityGuard.checkShortfall({
      hasCandidates: false,
      deficitKw: hardCapBreach.deficitKw,
      totalKw: latchedTotalKw,
      shortfallThresholdKw,
      capacityStateSummary: buildNullCapacityStateSummary(),
    })).finally(() => {
      addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
    });
  }
  const headroomTight = resolveHeadroomTight(headroomKw);
  const effectiveMinIntervalMs = resolveEffectiveSignalMinIntervalMs({
    minIntervalMs,
    stableMinIntervalMs,
    planConvergenceActive,
    headroomTight,
    isInShortfall,
    hardCapBreached: hardCapBreach.breached,
  });
  return schedulePlanRebuildFromPowerSample({
    scheduler,
    getState,
    setState,
    getNowMs,
    minIntervalMs: effectiveMinIntervalMs,
    maxIntervalMs,
    currentPowerW,
    powerDeltaW,
    limitKw: capacitySettings.limitKw,
    capacityPaceKw,
    headroomKw,
    isInShortfall,
    planConvergenceActive,
    hardCapBreach,
    onTightNoopHardCapBreach: async (deficitKw) => {
      await capacityGuard.checkShortfall({
        hasCandidates: false,
        deficitKw,
        totalKw: latchedTotalKw,
        shortfallThresholdKw,
        capacityStateSummary: buildNullCapacityStateSummary(),
      });
    },
    unactionable,
  }).finally(() => {
    addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
  });
}
