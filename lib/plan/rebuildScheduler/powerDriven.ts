import type { PlanRebuildScheduler } from './scheduler';
import type { HardCapBreach, RebuildOutcome } from './policy';
import {
  getLegacyPowerScheduler,
  handleSkippedRebuildDecision,
  requestPowerSampleRebuild,
  resolvePowerSampleDecision,
} from './powerDrivenScheduling';

export {
  cancelPendingPowerRebuild,
  executePendingPowerRebuild,
} from './powerDrivenScheduling';

export type PowerSampleRebuildState = {
  lastMs: number;
  legacyScheduler?: PlanRebuildScheduler;
  lastRebuildPowerW?: number;
  lastSoftLimitKw?: number;
  lastHardCapBreached?: boolean;
  lastHardCapDeficitKw?: number;
  shortfallSuppressionInvalidated?: boolean;
  tightNoopStreak?: number;
  backoffUntilMs?: number;
  mitigationHoldoffUntilMs?: number;
  inFlight?: Promise<void | string>;
  pending?: Promise<void | string>;
  pendingResolve?: (reason?: string) => void;
  pendingReject?: (error: Error) => void;
  pendingPowerW?: number;
  pendingSoftLimitKw?: number;
  pendingReason?: string;
  pendingDueMs?: number;
  pendingHardCapBreach?: HardCapBreach;
  pendingIsInShortfall?: boolean;
  pendingOnTightNoopHardCapBreach?: (deficitKw: number) => Promise<void>;
};

export function schedulePlanRebuildFromPowerSample(params: {
  scheduler?: PlanRebuildScheduler;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs?: () => number;
  minIntervalMs: number;
  maxIntervalMs: number;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  logError?: (error: Error) => void;
  currentPowerW?: number;
  powerDeltaW?: number;
  limitKw: number;
  softLimitKw?: number;
  headroomKw?: number | null;
  isInShortfall?: boolean;
  planConvergenceActive?: boolean;
  hardCapBreach?: HardCapBreach;
  onTightNoopHardCapBreach?: (deficitKw: number) => Promise<void>;
}): Promise<void | string> {
  const {
    scheduler,
    getState,
    setState,
    getNowMs = Date.now,
    minIntervalMs,
    maxIntervalMs,
    rebuildPlanFromCache,
    logError,
    currentPowerW,
    powerDeltaW,
    limitKw,
    softLimitKw,
    headroomKw,
    isInShortfall,
    planConvergenceActive,
    hardCapBreach,
    onTightNoopHardCapBreach,
  } = params;
  const resolvedScheduler = scheduler ?? getLegacyPowerScheduler({
    getState,
    setState,
    getNowMs,
    rebuildPlanFromCache,
    logError,
  });
  const state = getState();
  const now = getNowMs();
  const elapsedMs = now - state.lastMs;

  const { decision, triggerReason } = resolvePowerSampleDecision({
    state,
    nowMs: now,
    elapsedMs,
    maxIntervalMs,
    limitKw,
    currentPowerW,
    powerDeltaW,
    headroomKw,
    isInShortfall,
    hardCapBreach,
    planConvergenceActive,
  });

  if (!decision.shouldRebuild) {
    handleSkippedRebuildDecision({
      state,
      decision,
      now,
      hardCapBreach,
      isInShortfall,
      setState,
    });
    return Promise.resolve();
  }

  return requestPowerSampleRebuild({
    resolvedScheduler,
    getState,
    setState,
    fallbackState: state,
    decision,
    nowMs: now,
    minIntervalMs,
    currentPowerW,
    softLimitKw,
    triggerReason,
    hardCapBreach,
    isInShortfall,
    onTightNoopHardCapBreach,
  });
}
