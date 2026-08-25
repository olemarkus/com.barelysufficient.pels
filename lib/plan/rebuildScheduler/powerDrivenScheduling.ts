import { incPerfCounter, incPerfCounters } from '../../utils/perfCounters';
import { PlanRebuildScheduler, type RebuildIntent } from './scheduler';
import { clearShortfallSuppressionInvalidation } from './shortfallSuppression';
import {
  resolvePendingOrInFlight,
  resolvePendingPowerW,
  resolvePendingCapacityPaceKw,
} from './stateHelpers';
import {
  isFutureMs,
  isTightNoopOutcome,
  isTightReason,
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
} from './policy';
import type { PowerSampleRebuildState } from './powerDriven';
import type { PlanRebuildTrigger, PowerSampleRebuildTrigger } from '../planRebuildTrigger';

const hasTightNoopBackoffState = (state: PowerSampleRebuildState): boolean => (
  (state.tightNoopStreak ?? 0) > 0
  || state.backoffUntilMs !== undefined
  || state.mitigationHoldoffUntilMs !== undefined
);

export const handleSkippedRebuildDecision = (params: {
  state: PowerSampleRebuildState;
  decision: RebuildDecision;
  now: number;
  hardCapBreach?: HardCapBreach;
  isInShortfall?: boolean;
  setState: (state: PowerSampleRebuildState) => void;
}): void => {
  const { state, decision, now, hardCapBreach, isInShortfall, setState } = params;
  let nextState = state;
  if (!decision.headroomTight && !isInShortfall && !hardCapBreach?.breached && hasTightNoopBackoffState(nextState)) {
    nextState = resetTightNoopBackoff(nextState);
  }
  if (hardCapBreach?.breached !== true && nextState.lastHardCapBreached === true) {
    nextState = { ...nextState, lastHardCapBreached: false, lastHardCapDeficitKw: undefined };
  }
  // Keep the persisted execution-floor flag in sync on skips too (requests stamp it
  // in `stagePendingRebuildRequest`). Clears a stale `tightUnactionable` once the
  // state is no longer tight, so a recovered state can't carry an old floor forward.
  if (nextState.tightUnactionable !== decision.tightUnactionable) {
    nextState = { ...nextState, tightUnactionable: decision.tightUnactionable };
  }
  if (nextState !== state) setState(nextState);
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
  reason: PlanRebuildTrigger,
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
  reason: PlanRebuildTrigger,
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

/**
 * Did a device observation land while this rebuild was in flight?
 *
 * If so, the rebuild decided from devices it read BEFORE that observation, so its
 * verdict is about a house that no longer exists — and both suppressions it would
 * otherwise install (`updateTightRebuildSuppression`'s backoff) or clear
 * (`clearShortfallSuppressionInvalidation`'s latch) would be applied on the
 * strength of it. At a ~1.4 s build against a 10 s poll this is a routine race,
 * not an edge case, and before the counter it silently ate the observation's only
 * remaining effect on the planner.
 */
const observedDuringFlight = (
  state: PowerSampleRebuildState,
  seqAtDispatch: number,
): boolean => (state.observationSeq ?? 0) !== seqAtDispatch;

/**
 * The settle-down for a rebuild an observation overtook.
 *
 * It must keep the observation's cleared suppressions AND still install the
 * post-mitigation holdoff when the rebuild actually acted, because
 * `updateTightRebuildSuppression` is the only place that holdoff is armed.
 * Skipping the whole function would mean a tight rebuild that DID act — whose own
 * command echo is exactly the kind of observation that lands mid-flight — never
 * gets its 15 s settling window, and the next 10 s poll re-decides on top of a
 * command still taking effect.
 *
 * What it must never do is install the tight-NOOP backoff or spend the
 * invalidation latch: both of those rest on a "nothing is actionable" verdict the
 * observation just falsified.
 */
const settleAfterOvertakenRebuild = (
  state: PowerSampleRebuildState,
  reason: PlanRebuildTrigger,
  outcome: RebuildOutcome | void,
  nowMs: number,
): PowerSampleRebuildState => (
  shouldApplyTightMitigationHoldoff(reason, outcome)
    ? { ...state, mitigationHoldoffUntilMs: nowMs + TIGHT_MITIGATION_HOLDOFF_MS }
    : state
);

const incReasonCounter = (base: string, reason: string): void => {
  incPerfCounter(`${base}.${reason}_total`);
};

const clearPendingState = (snapshot: PowerSampleRebuildState): PowerSampleRebuildState => ({
  ...snapshot,
  pending: undefined,
  pendingResolve: undefined,
  pendingReject: undefined,
  pendingPowerW: undefined,
  pendingCapacityPaceKw: undefined,
  pendingReason: undefined,
  pendingDueMs: undefined,
  pendingHardCapBreach: undefined,
  pendingIsInShortfall: undefined,
  pendingOnTightNoopHardCapBreach: undefined,
});

const clearInFlightState = (snapshot: PowerSampleRebuildState): PowerSampleRebuildState => ({
  ...snapshot, inFlight: undefined });

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
  capacityPaceKw?: number;
  triggerReason: PowerSampleRebuildTrigger;
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
    capacityPaceKw,
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
    pendingCapacityPaceKw: typeof capacityPaceKw === 'number' ? capacityPaceKw : nextState.pendingCapacityPaceKw,
    pendingReason: triggerReason,
    pendingDueMs: typeof previousDueMs === 'number' ? Math.min(previousDueMs, dueMs) : dueMs,
    pendingHardCapBreach: hardCapBreach,
    pendingIsInShortfall: isInShortfall,
    pendingOnTightNoopHardCapBreach: onTightNoopHardCapBreach,
    tightUnactionable: decision.tightUnactionable,
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
  triggerReason: PowerSampleRebuildTrigger;
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

const recordPowerSampleRebuildRequest = (reason: PowerSampleRebuildTrigger): void => {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.power_sample_total',
  ]);
  incReasonCounter('plan_rebuild_requested.power_sample_reason', reason);
};

const recordPowerSampleRebuildExecution = (reason: PowerSampleRebuildTrigger): void => {
  incPerfCounters([
    'plan_rebuild_execute_total',
    'plan_rebuild_execute.power_sample_total',
  ]);
  incReasonCounter('plan_rebuild_execute.power_sample_reason', reason);
};

export function executePendingPowerRebuild(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  getNowMs: () => number;
  rebuildPlanFromCache: (trigger: PowerSampleRebuildTrigger) => Promise<RebuildOutcome | void>;
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
  const nextCapacityPaceKw = resolvePendingCapacityPaceKw(snapshot);
  const inFlight = snapshot.pending;
  // Captured BEFORE the await. Anything that moves this while the rebuild runs is
  // a device the rebuild's plan input never saw.
  const observationSeqAtDispatch = snapshot.observationSeq ?? 0;

  setState({
    ...clearPendingState(snapshot),
    inFlight,
    lastMs: getNowMs(),
    lastRebuildPowerW: typeof nextPowerW === 'number' ? nextPowerW : snapshot.lastRebuildPowerW,
    lastCapacityPaceKw: typeof nextCapacityPaceKw === 'number' ? nextCapacityPaceKw : snapshot.lastCapacityPaceKw,
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
      const completed = {
        ...getState(),
        lastHardCapBreached: hardCapBreach?.breached === true,
        lastHardCapDeficitKw: hardCapBreach?.breached === true ? hardCapBreach.deficitKw : undefined,
      };
      setState(clearInFlightState(
        observedDuringFlight(completed, observationSeqAtDispatch)
          ? settleAfterOvertakenRebuild(completed, reason, outcome, getNowMs())
          : clearShortfallSuppressionInvalidation(
            updateTightRebuildSuppression(completed, reason, outcome, getNowMs()),
          ),
      ));
      pendingResolve?.();
    })
    .catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      // Clear the invalidation latch here too (the success path already does),
      // so a failed re-check rebuild can't leave it set and permanently disarm the
      // unactionable throttle for the rest of the incident — keep it a true one-shot.
      const failed = getState();
      // No mitigation holdoff on the error path: a failed rebuild acted on nothing,
      // so there is no command to let settle.
      setState(clearInFlightState(
        observedDuringFlight(failed, observationSeqAtDispatch)
          ? failed
          : clearShortfallSuppressionInvalidation(
            updateTightRebuildSuppressionAfterError(failed, reason, getNowMs()),
          ),
      ));
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

export const resolvePowerSampleDecision = (params: {
  state: PowerSampleRebuildState;
  nowMs: number;
  elapsedMs: number;
  maxIntervalMs: number;
  limitKw: number;
  currentPowerW?: number;
  powerDeltaW?: number;
  headroomKw?: number | null;
  isInShortfall?: boolean;
  hardCapBreach?: HardCapBreach;
  planConvergenceActive?: boolean;
  unactionable?: boolean;
}): { decision: RebuildDecision; triggerReason: PowerSampleRebuildTrigger } => {
  const {
    state,
    nowMs,
    elapsedMs,
    maxIntervalMs,
    limitKw,
    currentPowerW,
    powerDeltaW,
    headroomKw,
    isInShortfall,
    hardCapBreach,
    planConvergenceActive,
    unactionable,
  } = params;
  const decision = resolveRebuildDecision({
    state,
    nowMs,
    elapsedMs,
    maxIntervalMs,
    limitKw,
    currentPowerW,
    powerDeltaW,
    headroomKw,
    isInShortfall,
    hardCapBreach,
    planConvergenceActive,
    unactionable,
  });
  const triggerReason = resolveRebuildReason({
    state,
    decision,
    isInShortfall,
    hardCapBreach,
    planConvergenceActive,
  });
  return { decision, triggerReason };
};

export const requestPowerSampleRebuild = (params: {
  resolvedScheduler: PlanRebuildScheduler;
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  fallbackState: PowerSampleRebuildState;
  decision: RebuildDecision;
  nowMs: number;
  minIntervalMs: number;
  currentPowerW?: number;
  capacityPaceKw?: number;
  triggerReason: PowerSampleRebuildTrigger;
  hardCapBreach?: HardCapBreach;
  isInShortfall?: boolean;
  onTightNoopHardCapBreach?: (deficitKw: number) => Promise<void>;
}): Promise<void | string> => {
  const {
    resolvedScheduler,
    getState,
    setState,
    fallbackState,
    decision,
    nowMs,
    minIntervalMs,
    currentPowerW,
    capacityPaceKw,
    triggerReason,
    hardCapBreach,
    isInShortfall,
    onTightNoopHardCapBreach,
  } = params;
  const {
    nextState,
    intentKind,
    hadPending,
    previousDueMs,
  } = stagePendingRebuildRequest({
    state: getState(),
    decision,
    nowMs,
    minIntervalMs,
    currentPowerW,
    capacityPaceKw,
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
    setState(fallbackState);
    return resolvePendingOrInFlight(fallbackState);
  }
  recordPendingRebuildQueueState({
    triggerReason,
    hadPending,
    previousDueMs,
    pendingDueMs: nextState.pendingDueMs,
  });
  return pending;
};
