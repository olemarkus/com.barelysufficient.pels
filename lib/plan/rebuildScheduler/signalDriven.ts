import type CapacityGuard from '../../power/capacityGuard';
import { addPerfDuration, incPerfCounter } from '../../utils/perfCounters';
import {
  resetShortfallSuppressionInvalidationWhenRecovered,
  shouldSkipUnrecoverableShortfallRebuild,
} from './shortfallSuppression';
import {
  resolveHardCapBreachFromSignal,
  resolveHeadroomTight,
  type RebuildOutcome,
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
  scheduler?: PlanRebuildScheduler;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs?: () => number;
  minIntervalMs: number;
  stableMinIntervalMs?: number;
  maxIntervalMs: number;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  logError?: (error: Error) => void;
  currentPowerW?: number;
  powerDeltaW?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityGuard?: CapacityGuard;
  planConvergenceActive?: boolean;
  skipWhileShortfallUnrecoverable?: boolean;
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
    rebuildPlanFromCache,
    logError,
    currentPowerW,
    powerDeltaW,
    capacitySettings,
    capacityGuard,
    planConvergenceActive,
    skipWhileShortfallUnrecoverable = false,
  } = params;
  const softLimitKw = capacityGuard?.getSoftLimit()
    ?? Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const guardPower = capacityGuard?.getLastTotalPower() ?? null;
  const fallbackHeadroomKw = typeof currentPowerW === 'number' ? softLimitKw - currentPowerW / 1000 : null;
  const headroomKw = guardPower !== null ? softLimitKw - guardPower : fallbackHeadroomKw;
  const isInShortfall = capacityGuard?.isInShortfall() ?? false;
  const currentState = resetShortfallSuppressionInvalidationWhenRecovered({
    state: getState(),
    isInShortfall,
    setState,
  });
  const hardCapBreach = resolveHardCapBreachFromSignal({
    capacityGuard,
    capacitySettings,
    currentPowerW,
    guardPower,
  });
  if (shouldSkipUnrecoverableShortfallRebuild({
    skipWhileShortfallUnrecoverable,
    state: currentState,
    isInShortfall,
    planConvergenceActive,
  })) {
    incPerfCounter('plan_rebuild_skipped_shortfall_unrecoverable_total');
    return Promise.resolve(capacityGuard?.checkShortfall(false, hardCapBreach.deficitKw)).finally(() => {
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
    rebuildPlanFromCache,
    logError,
    currentPowerW,
    powerDeltaW,
    limitKw: capacitySettings.limitKw,
    softLimitKw,
    headroomKw,
    isInShortfall,
    planConvergenceActive,
    hardCapBreach,
    onTightNoopHardCapBreach: async (deficitKw) => {
      await capacityGuard?.checkShortfall(false, deficitKw);
    },
  }).finally(() => {
    addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
  });
}
