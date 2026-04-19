import type CapacityGuard from '../core/capacityGuard';
import { addPerfDuration, incPerfCounter, incPerfCounters } from '../utils/perfCounters';
import { PlanRebuildScheduler, type RebuildIntent } from './planRebuildScheduler';
import {
  clearShortfallSuppressionInvalidation,
  resetShortfallSuppressionInvalidationWhenRecovered,
  shouldSkipUnrecoverableShortfallRebuild,
} from './appPowerRebuildShortfallSuppression';
import {
  resolvePendingOrInFlight,
  resolvePendingPowerW,
  resolvePendingSoftLimitKw,
} from './appPowerRebuildStateHelpers';
import {
  isFutureMs,
  isTightNoopOutcome,
  isTightReason,
  resolveHardCapBreachFromSignal,
  resolveHeadroomTight,
  resolveRebuildDecision,
  resolveRebuildIntentKind,
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
  legacyScheduler?: PlanRebuildScheduler;
  lastRebuildPowerW?: number;
  lastSoftLimitKw?: number;
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

const updateTightRebuildSuppressionAfterError = (
  snapshot: PowerSampleRebuildState,
  reason: string,
  nowMs: number,
): PowerSampleRebuildState => {
  if (!isTightReason(reason)) {
    return resetTightNoopBackoff(snapshot);
  }
  const tightNoopStreak = Math.max(1, snapshot.tightNoopStreak ?? 0);
  const backoffMs = resolveTightNoopBackoffMs(tightNoopStreak);
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

const clearPendingState = (snapshot: PowerSampleRebuildState): PowerSampleRebuildState => ({
  ...snapshot,
  pending: undefined,
  pendingResolve: undefined,
  pendingReject: undefined,
  pendingPowerW: undefined,
  pendingSoftLimitKw: undefined,
  pendingReason: undefined,
  pendingDueMs: undefined,
  pendingHardCapBreach: undefined,
  pendingIsInShortfall: undefined,
  pendingOnTightNoopHardCapBreach: undefined,
});

const clearInFlightState = (snapshot: PowerSampleRebuildState): PowerSampleRebuildState => ({
  ...snapshot,
  inFlight: undefined,
});

const createPendingPromiseState = (
  snapshot: PowerSampleRebuildState,
): PowerSampleRebuildState => {
  if (snapshot.pending) return snapshot;
  let pendingResolve!: (reason?: string) => void;
  let pendingReject!: (error: Error) => void;
  const pending = new Promise<void | string>((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
  });
  return {
    ...snapshot,
    pending,
    pendingResolve,
    pendingReject,
  };
};

const stagePendingRebuildRequest = (params: {
  state: PowerSampleRebuildState;
  decision: RebuildDecision;
  nowMs: number;
  minIntervalMs: number;
  currentPowerW?: number;
  softLimitKw?: number;
  triggerReason: string;
  hardCapBreach?: HardCapBreach;
  isInShortfall?: boolean;
  onTightNoopHardCapBreach?: (deficitKw: number) => Promise<void>;
}): {
  nextState: PowerSampleRebuildState;
  intentKind: RebuildIntent['kind'];
  hadPending: boolean;
  previousDueMs?: number;
} => {
  const {
    state,
    decision,
    nowMs,
    minIntervalMs,
    currentPowerW,
    softLimitKw,
    triggerReason,
    hardCapBreach,
    isInShortfall,
    onTightNoopHardCapBreach,
  } = params;
  let nextState = state;
  if (decision.deltaMeaningful && hasTightNoopBackoffState(nextState)) {
    nextState = resetTightNoopBackoff(nextState);
  }
  const intentKind = resolveRebuildIntentKind({ hardCapBreach });
  const dueMs = intentKind === 'hardCap'
    ? nowMs
    : Math.max(nowMs, nextState.lastMs + minIntervalMs);
  const hadPending = Boolean(nextState.pending);
  const previousDueMs = nextState.pendingDueMs;
  nextState = createPendingPromiseState(nextState);
  nextState = {
    ...nextState,
    pendingPowerW: typeof currentPowerW === 'number' ? currentPowerW : nextState.pendingPowerW,
    pendingSoftLimitKw: typeof softLimitKw === 'number' ? softLimitKw : nextState.pendingSoftLimitKw,
    pendingReason: triggerReason,
    pendingDueMs: typeof previousDueMs === 'number' ? Math.min(previousDueMs, dueMs) : dueMs,
    pendingHardCapBreach: hardCapBreach,
    pendingIsInShortfall: isInShortfall,
    pendingOnTightNoopHardCapBreach: onTightNoopHardCapBreach,
  };
  if (intentKind === 'hardCap' && hasTightNoopBackoffState(nextState)) {
    nextState = resetTightNoopBackoff(nextState);
  }
  return {
    nextState,
    intentKind,
    hadPending,
    previousDueMs,
  };
};

const recordPendingRebuildQueueState = (params: {
  triggerReason: string;
  hadPending: boolean;
  previousDueMs?: number;
  pendingDueMs?: number;
}): void => {
  const {
    triggerReason,
    hadPending,
    previousDueMs,
    pendingDueMs,
  } = params;
  recordPowerSampleRebuildRequest(triggerReason);
  if (!hadPending) {
    incPerfCounter('plan_rebuild_pending_created_total');
    return;
  }
  if (typeof previousDueMs === 'number' && typeof pendingDueMs === 'number' && pendingDueMs < previousDueMs) {
    incPerfCounter('plan_rebuild_pending_rescheduled_total');
    return;
  }
  incPerfCounter('plan_rebuild_pending_coalesced_total');
};

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

const getLegacyPowerScheduler = (params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs: () => number;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
  logError?: (error: Error) => void;
}): PlanRebuildScheduler => {
  const {
    getState,
    setState,
    getNowMs,
    rebuildPlanFromCache,
    logError,
  } = params;
  const existing = getState().legacyScheduler;
  if (existing) return existing;

  const scheduler = new PlanRebuildScheduler({
    getNowMs,
    resolveDueAtMs: (intent, state) => {
      if (intent.kind === 'hardCap') return state.nowMs;
      if (intent.kind === 'signal') return getState().pendingDueMs ?? state.nowMs;
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
  setState({
    ...getState(),
    legacyScheduler: scheduler,
  });
  return scheduler;
};

export function executePendingPowerRebuild(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs: () => number;
  rebuildPlanFromCache: (reason?: string) => Promise<RebuildOutcome | void>;
}): Promise<void> {
  const {
    getState,
    setState,
    getNowMs,
    rebuildPlanFromCache,
  } = params;
  const snapshot = getState();
  const reason = snapshot.pendingReason ?? 'unknown';
  const pendingResolve = snapshot.pendingResolve;
  const pendingReject = snapshot.pendingReject;
  const hardCapBreach = snapshot.pendingHardCapBreach;
  const isInShortfall = snapshot.pendingIsInShortfall;
  const onTightNoopHardCapBreach = snapshot.pendingOnTightNoopHardCapBreach;
  const nextPowerW = resolvePendingPowerW(snapshot);
  const nextSoftLimitKw = resolvePendingSoftLimitKw(snapshot);
  const inFlight = snapshot.pending;

  setState({
    ...clearPendingState(snapshot),
    inFlight,
    lastMs: getNowMs(),
    lastRebuildPowerW: typeof nextPowerW === 'number' ? nextPowerW : snapshot.lastRebuildPowerW,
    lastSoftLimitKw: typeof nextSoftLimitKw === 'number' ? nextSoftLimitKw : snapshot.lastSoftLimitKw,
  });
  recordPowerSampleRebuildExecution(reason);

  return rebuildPlanFromCache(reason)
    .then(async (outcome) => {
      if (
        isTightNoopOutcome(reason, outcome)
        && hardCapBreach?.breached
        && !isInShortfall
      ) {
        await onTightNoopHardCapBreach?.(hardCapBreach.deficitKw);
      }
      setState(clearInFlightState(clearShortfallSuppressionInvalidation(
        updateTightRebuildSuppression(getState(), reason, outcome, getNowMs()),
      )));
      pendingResolve?.();
    })
    .catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      setState(clearInFlightState(updateTightRebuildSuppressionAfterError(getState(), reason, getNowMs())));
      pendingReject?.(normalizedError);
      throw normalizedError;
    });
}

export function cancelPendingPowerRebuild(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  reason?: string;
}): void {
  const {
    getState,
    setState,
    reason,
  } = params;
  const state = getState();
  state.pendingResolve?.(reason);
  setState(clearPendingState(state));
}

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
    return Promise.resolve();
  }

  const {
    nextState,
    intentKind,
    hadPending,
    previousDueMs,
  } = stagePendingRebuildRequest({
    state: getState(),
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
  setState(nextState);

  const pending = nextState.pending ?? Promise.resolve();
  const intent: RebuildIntent = { kind: intentKind, reason: triggerReason };
  const requestResult = resolvedScheduler.request(intent);
  if (requestResult.status === 'dropped') {
    setState(state);
    return resolvePendingOrInFlight(state);
  }
  recordPendingRebuildQueueState({
    triggerReason,
    hadPending,
    previousDueMs,
    pendingDueMs: nextState.pendingDueMs,
  });
  return pending;
}

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
