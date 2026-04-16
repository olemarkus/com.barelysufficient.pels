import type CapacityGuard from '../core/capacityGuard';
import { addPerfDuration, incPerfCounter, incPerfCounters } from '../utils/perfCounters';
import {
  isFutureMs,
  isTightNoopOutcome,
  resolveHardCapBreachFromSignal,
  resolveHeadroomTight,
  resolveRebuildDecision,
  resolveRebuildReason,
  resolveTightNoopBackoffMs,
  shouldApplyTightMitigationHoldoff,
  shouldApplyTightNoopBackoff,
  TIGHT_MITIGATION_HOLDOFF_MS,
  type HardCapBreach,
  type RebuildDecision,
  type RebuildOutcome,
} from './appPowerRebuildPolicy';

export type PowerSampleRebuildState = {
  lastMs: number;
  lastRebuildPowerW?: number;
  lastSoftLimitKw?: number;
  tightNoopStreak?: number;
  backoffUntilMs?: number;
  mitigationHoldoffUntilMs?: number;
  pending?: Promise<void>;
  pendingResolve?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  pendingPowerW?: number;
  pendingSoftLimitKw?: number;
  pendingReason?: string;
  pendingDueMs?: number;
};

const hasTightNoopBackoffState = (state: PowerSampleRebuildState): boolean => (
  (state.tightNoopStreak ?? 0) > 0
  || state.backoffUntilMs !== undefined
  || state.mitigationHoldoffUntilMs !== undefined
);

const handleSkippedRebuildDecision = (params: {
  state: PowerSampleRebuildState;
  decision: RebuildDecision;
  now: number;
  hardCapBreach?: HardCapBreach;
  isInShortfall?: boolean;
  setState: (state: PowerSampleRebuildState) => void;
}): void => {
  const {
    state,
    decision,
    now,
    hardCapBreach,
    isInShortfall,
    setState,
  } = params;
  if (!decision.headroomTight && !isInShortfall && !hardCapBreach?.breached && hasTightNoopBackoffState(state)) {
    setState(resetTightNoopBackoff(state));
  }
  incPerfCounters([
    'plan_rebuild_skipped_total',
    decision.deltaMeaningful
      ? 'plan_rebuild_skipped_non_boundary_delta_total'
      : 'plan_rebuild_skipped_insignificant_total',
  ]);
  if (decision.backoffActive) {
    incPerfCounter('plan_rebuild_skipped_tight_noop_backoff_total');
    if (isFutureMs(state.mitigationHoldoffUntilMs, now)) {
      incPerfCounter('plan_rebuild_skipped_tight_mitigation_holdoff_total');
    }
  }
};

const updateTightRebuildSuppression = (
  snapshot: PowerSampleRebuildState,
  reason: string,
  outcome: RebuildOutcome | void,
  nowMs: number,
): PowerSampleRebuildState => {
  if (shouldApplyTightMitigationHoldoff(reason, outcome)) {
    return {
      ...resetTightNoopBackoff(snapshot),
      mitigationHoldoffUntilMs: nowMs + TIGHT_MITIGATION_HOLDOFF_MS,
    };
  }
  if (!shouldApplyTightNoopBackoff(reason, outcome)) {
    return resetTightNoopBackoff(snapshot);
  }
  const tightNoopStreak = (snapshot.tightNoopStreak ?? 0) + 1;
  const backoffMs = resolveTightNoopBackoffMs(tightNoopStreak);
  incPerfCounter('plan_rebuild_tight_noop_total');
  incPerfCounter(`plan_rebuild_tight_noop_streak.${Math.min(tightNoopStreak, 4)}_total`);
  return {
    ...snapshot,
    tightNoopStreak,
    backoffUntilMs: nowMs + backoffMs,
    mitigationHoldoffUntilMs: undefined,
  };
};

function resetTightNoopBackoff(snapshot: PowerSampleRebuildState): PowerSampleRebuildState {
  if (hasTightNoopBackoffState(snapshot)) {
    incPerfCounter('plan_rebuild_tight_noop_backoff_reset_total');
  }
  return {
    ...snapshot,
    tightNoopStreak: 0,
    backoffUntilMs: undefined,
    mitigationHoldoffUntilMs: undefined,
  };
}

const incReasonCounter = (base: string, reason: string): void => {
  incPerfCounter(`${base}.${reason}_total`);
};

const resolvePendingPowerW = (
  snapshot: PowerSampleRebuildState,
  currentPowerW?: number,
): number | undefined => {
  if (typeof snapshot.pendingPowerW === 'number') return snapshot.pendingPowerW;
  if (typeof currentPowerW === 'number') return currentPowerW;
  return snapshot.lastRebuildPowerW;
};

const resolvePendingSoftLimitKw = (
  snapshot: PowerSampleRebuildState,
  softLimitKw?: number,
): number | undefined => {
  if (typeof snapshot.pendingSoftLimitKw === 'number') return snapshot.pendingSoftLimitKw;
  if (typeof softLimitKw === 'number') return softLimitKw;
  return snapshot.lastSoftLimitKw;
};

const buildPostRebuildState = (
  snapshot: PowerSampleRebuildState,
  nextPowerW: number | undefined,
  nextSoftLimitKw: number | undefined,
): PowerSampleRebuildState => ({
  ...snapshot,
  lastRebuildPowerW: typeof nextPowerW === 'number' ? nextPowerW : snapshot.lastRebuildPowerW,
  lastSoftLimitKw: typeof nextSoftLimitKw === 'number' ? nextSoftLimitKw : snapshot.lastSoftLimitKw,
  pendingPowerW: undefined,
  pendingSoftLimitKw: undefined,
  pendingReason: undefined,
});

const withPendingInputs = (
  snapshot: PowerSampleRebuildState,
  currentPowerW: number | undefined,
  softLimitKw: number | undefined,
  pendingReason: string,
): PowerSampleRebuildState => ({
  ...snapshot,
  pendingPowerW: typeof currentPowerW === 'number' ? currentPowerW : snapshot.pendingPowerW,
  pendingSoftLimitKw: typeof softLimitKw === 'number' ? softLimitKw : snapshot.pendingSoftLimitKw,
  pendingReason,
});

const clearPendingState = (snapshot: PowerSampleRebuildState): PowerSampleRebuildState => ({
  ...snapshot,
  pending: undefined,
  pendingResolve: undefined,
  timer: undefined,
  pendingDueMs: undefined,
  pendingReason: undefined,
  pendingPowerW: undefined,
  pendingSoftLimitKw: undefined,
});

const clearPendingExecutionHandleState = (snapshot: PowerSampleRebuildState): PowerSampleRebuildState => ({
  ...snapshot,
  pending: undefined,
  pendingResolve: undefined,
  timer: undefined,
  pendingDueMs: undefined,
});

type PerformRebuildFn = (
  snapshot: PowerSampleRebuildState,
  reason: string,
) => Promise<void>;

const armPendingTimer = (params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  dueMs: number;
  fallbackReason: string;
  performRebuild: PerformRebuildFn;
  logError: (error: Error) => void;
  resolve: () => void;
}): ReturnType<typeof setTimeout> => {
  const {
    getState,
    setState,
    dueMs,
    fallbackReason,
    performRebuild,
    logError,
    resolve,
  } = params;
  return setTimeout(() => {
    const latest = getState();
    const reason = latest.pendingReason ?? fallbackReason;
    const nextState = {
      ...clearPendingExecutionHandleState(latest),
      lastMs: Date.now(),
    };
    setState(nextState);
    performRebuild(nextState, reason)
      .catch((error) => {
        logError(error as Error);
      })
      .finally(() => {
        resolve();
      });
  }, Math.max(0, dueMs - Date.now()));
};

const createPendingRebuild = (params: {
  state: PowerSampleRebuildState;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  currentPowerW: number | undefined;
  softLimitKw: number | undefined;
  triggerReason: string;
  minIntervalMs: number;
  performRebuild: PerformRebuildFn;
  logError: (error: Error) => void;
}): Promise<void> => {
  const {
    state,
    getState,
    setState,
    currentPowerW,
    softLimitKw,
    triggerReason,
    minIntervalMs,
    performRebuild,
    logError,
  } = params;
  const dueMs = state.lastMs + minIntervalMs;
  let pendingResolve!: () => void;
  const pending = new Promise<void>((resolve) => {
    pendingResolve = resolve;
  });
  const timer = armPendingTimer({
    getState,
    setState,
    dueMs,
    fallbackReason: triggerReason,
    performRebuild,
    logError,
    resolve: pendingResolve,
  });
  const latest = getState();
  setState({
    ...withPendingInputs(latest, currentPowerW, softLimitKw, triggerReason),
    pending,
    timer,
    pendingDueMs: dueMs,
    pendingResolve,
  });
  return pending;
};

const coalescePendingRebuild = (params: {
  latest: PowerSampleRebuildState;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  currentPowerW: number | undefined;
  softLimitKw: number | undefined;
  triggerReason: string;
  minIntervalMs: number;
  performRebuild: PerformRebuildFn;
  logError: (error: Error) => void;
}): Promise<void> => {
  const {
    latest,
    getState,
    setState,
    currentPowerW,
    softLimitKw,
    triggerReason,
    minIntervalMs,
    performRebuild,
    logError,
  } = params;
  const nextState = withPendingInputs(latest, currentPowerW, softLimitKw, triggerReason);
  const nextDueMs = latest.lastMs + minIntervalMs;
  if (
    typeof latest.pendingDueMs === 'number'
    && nextDueMs < latest.pendingDueMs
    && latest.pendingResolve
  ) {
    if (latest.timer) {
      clearTimeout(latest.timer);
    }
    incPerfCounter('plan_rebuild_pending_rescheduled_total');
    const timer = armPendingTimer({
      getState,
      setState,
      dueMs: nextDueMs,
      fallbackReason: triggerReason,
      performRebuild,
      logError,
      resolve: latest.pendingResolve,
    });
    setState({
      ...nextState,
      timer,
      pendingDueMs: nextDueMs,
    });
    return getState().pending ?? Promise.resolve();
  }
  setState(nextState);
  return getState().pending ?? Promise.resolve();
};

const recordPowerSampleRebuildRequest = (reason: string): void => {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.power_sample_total',
  ]);
  incReasonCounter('plan_rebuild_requested.power_sample_reason', reason);
};

const recordPowerSampleRebuildExecution = (reason: string): void => {
  incPerfCounters([
    'plan_rebuild_execute_total',
    'plan_rebuild_execute.power_sample_total',
  ]);
  incReasonCounter('plan_rebuild_execute.power_sample_reason', reason);
};

export function schedulePlanRebuildFromPowerSample(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  minIntervalMs: number;
  maxIntervalMs: number;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  logError: (error: Error) => void;
  currentPowerW?: number;
  powerDeltaW?: number;
  limitKw: number;
  softLimitKw?: number;
  headroomKw?: number | null;
  isInShortfall?: boolean;
  planConvergenceActive?: boolean;
  hardCapBreach?: HardCapBreach;
  onTightNoopHardCapBreach?: (deficitKw: number) => Promise<void>;
}): Promise<void> {
  const {
    getState,
    setState,
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
  const state = getState();
  const now = Date.now();
  const elapsedMs = now - state.lastMs;

  const decision = resolveRebuildDecision({
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
  const triggerReason = resolveRebuildReason({
    state,
    decision,
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
    // Skip rebuild, but don't update lastMs or state, so we stay ready.
    return Promise.resolve();
  }
  if (decision.deltaMeaningful && hasTightNoopBackoffState(state)) {
    setState(resetTightNoopBackoff(state));
  }
  recordPowerSampleRebuildRequest(triggerReason);

  const performRebuild = async (snapshot: PowerSampleRebuildState, reason: string): Promise<void> => {
    recordPowerSampleRebuildExecution(reason);
    const nextPowerW = resolvePendingPowerW(snapshot, currentPowerW);
    const nextSoftLimitKw = resolvePendingSoftLimitKw(snapshot, softLimitKw);
    const postRebuildState = buildPostRebuildState(snapshot, nextPowerW, nextSoftLimitKw);
    setState(postRebuildState);
    try {
      const outcome = await rebuildPlanFromCache(reason);
      if (
        isTightNoopOutcome(reason, outcome)
        && hardCapBreach?.breached
        && !isInShortfall
      ) {
        await onTightNoopHardCapBreach?.(hardCapBreach.deficitKw);
      }
      setState(updateTightRebuildSuppression(getState(), reason, outcome, Date.now()));
    } catch (error) {
      setState(resetTightNoopBackoff(getState()));
      throw error;
    }
  };

  if (elapsedMs >= minIntervalMs) {
    const latest = getState();
    const pendingResolve = latest.pendingResolve;
    if (latest.timer) {
      clearTimeout(latest.timer);
    }
    const nextState = {
      ...clearPendingState(latest),
      lastMs: now,
    };
    setState(nextState);
    return performRebuild(nextState, triggerReason)
      .finally(() => {
        pendingResolve?.();
      });
  }

  if (!state.pending) {
    incPerfCounter('plan_rebuild_pending_created_total');
    return createPendingRebuild({
      state,
      getState,
      setState,
      currentPowerW,
      softLimitKw,
      triggerReason,
      minIntervalMs,
      performRebuild,
      logError,
    });
  }
  incPerfCounter('plan_rebuild_pending_coalesced_total');
  const latest = getState();
  return coalescePendingRebuild({
    latest,
    getState,
    setState,
    currentPowerW,
    softLimitKw,
    triggerReason,
    minIntervalMs,
    performRebuild,
    logError,
  });
}

export function schedulePlanRebuildFromSignal(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  minIntervalMs: number;
  stableMinIntervalMs?: number;
  maxIntervalMs: number;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  logError: (error: Error) => void;
  currentPowerW?: number;
  powerDeltaW?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityGuard?: CapacityGuard;
  planConvergenceActive?: boolean;
}): Promise<void> {
  const rebuildStart = Date.now();
  const {
    getState,
    setState,
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
  } = params;
  const softLimitKw = capacityGuard?.getSoftLimit()
    ?? Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  // Derive headroom from the already-fetched softLimit to avoid a second provider call.
  const guardPower = capacityGuard?.getLastTotalPower() ?? null;
  const fallbackHeadroomKw = typeof currentPowerW === 'number' ? softLimitKw - currentPowerW / 1000 : null;
  const headroomKw = guardPower !== null ? softLimitKw - guardPower : fallbackHeadroomKw;
  const isInShortfall = capacityGuard?.isInShortfall() ?? false;
  const hardCapBreach = resolveHardCapBreachFromSignal({
    capacityGuard,
    capacitySettings,
    currentPowerW,
    guardPower,
  });
  const headroomTight = resolveHeadroomTight(headroomKw);
  const stableIntervalMs = typeof stableMinIntervalMs === 'number' ? stableMinIntervalMs : minIntervalMs;
  const effectiveMinIntervalMs = (
    planConvergenceActive === true
    || headroomTight
    || isInShortfall
    || hardCapBreach.breached
  )
    ? minIntervalMs
    : Math.max(minIntervalMs, stableIntervalMs);
  if (effectiveMinIntervalMs > minIntervalMs) {
    incPerfCounter('plan_rebuild_signal_stable_interval_total');
  }
  return schedulePlanRebuildFromPowerSample({
    getState,
    setState,
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
