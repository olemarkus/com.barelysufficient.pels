/* eslint-disable max-lines, max-lines-per-function, max-statements --
 * Power sample scheduling, backoff, and persistence are kept together for shared state handling.
 */
import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';
import { aggregateAndPruneHistory } from '../core/powerTracker';
import { addPerfDuration, incPerfCounter, incPerfCounters } from '../utils/perfCounters';

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
};

type RebuildDecision = {
  shouldRebuild: boolean;
  controlBoundaryActive: boolean;
  deltaW: number;
  deltaMeaningful: boolean;
  maxIntervalExceeded: boolean;
  headroomTight: boolean;
  backoffActive: boolean;
};

type RebuildOutcome = {
  actionChanged: boolean;
  appliedActions: boolean;
  failed: boolean;
};

type HardCapBreach = {
  breached: boolean;
  deficitKw: number;
};

export function recordDailyBudgetCap(params: {
  powerTracker: PowerTrackerState;
  snapshot: DailyBudgetUiPayload | null;
}): PowerTrackerState {
  const { powerTracker, snapshot } = params;
  const today = snapshot?.days?.[snapshot.todayKey] ?? null;
  if (!today?.budget.enabled) return powerTracker;
  const planned = today.buckets.plannedKWh;
  const startUtc = today.buckets.startUtc;
  const index = today.currentBucketIndex;
  if (!Array.isArray(planned) || !Array.isArray(startUtc)) return powerTracker;
  if (index < 0 || index >= planned.length || index >= startUtc.length) return powerTracker;
  const plannedKWh = planned[index];
  const bucketKey = startUtc[index];
  if (!Number.isFinite(plannedKWh) || typeof bucketKey !== 'string') return powerTracker;
  const nextCaps = { ...(powerTracker.dailyBudgetCaps || {}), [bucketKey]: plannedKWh };
  return { ...powerTracker, dailyBudgetCaps: nextCaps };
}

const MIN_REBUILD_DELTA_W = 100;
const MIN_REBUILD_DELTA_RATIO = 0.005; // 0.5% of limit
const TIGHT_NOOP_BACKOFF_MS = [15_000, 30_000, 60_000];
const TIGHT_NOOP_BACKOFF_MAX_MS = 120_000;
const TIGHT_MITIGATION_HOLDOFF_MS = 15_000;

const resolveHeadroomTight = (headroomKw: number | null | undefined): boolean => {
  return typeof headroomKw === 'number' && headroomKw <= 0;
};

const resolvePowerDelta = (params: {
  currentPowerW?: number;
  powerDeltaW?: number;
  lastRebuildPowerW?: number;
  limitKw: number;
}): { deltaW: number; deltaMeaningful: boolean } => {
  const { currentPowerW, powerDeltaW, lastRebuildPowerW, limitKw } = params;
  const deltaThresholdW = Math.max(MIN_REBUILD_DELTA_W, limitKw * 1000 * MIN_REBUILD_DELTA_RATIO);
  const deltaFromSample = (typeof currentPowerW === 'number' && typeof lastRebuildPowerW === 'number')
    ? Math.abs(currentPowerW - lastRebuildPowerW)
    : 0;
  const deltaFromHint = typeof powerDeltaW === 'number' ? Math.abs(powerDeltaW) : 0;
  const deltaW = Math.max(deltaFromSample, deltaFromHint);
  return { deltaW, deltaMeaningful: deltaW >= deltaThresholdW };
};

const resolveRebuildDecision = (params: {
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
}): RebuildDecision => {
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
  } = params;
  const headroomTight = resolveHeadroomTight(headroomKw);
  const controlBoundaryActive = headroomTight || Boolean(isInShortfall);
  const hardCapBreachActive = hardCapBreach?.breached ?? false;
  const { deltaW, deltaMeaningful } = resolvePowerDelta({
    currentPowerW,
    powerDeltaW,
    lastRebuildPowerW: state.lastRebuildPowerW,
    limitKw,
  });
  const maxIntervalExceeded = maxIntervalMs > 0 && elapsedMs >= maxIntervalMs;
  const backoffActive = isTightNoopBackoffActive({
    state,
    nowMs,
    headroomTight,
    isInShortfall,
    hardCapBreachActive,
    deltaMeaningful,
  });
  // Ordinary power movement stays on the status-only path unless it crosses a real
  // control boundary, the plan is still converging on a recent action, or the periodic
  // convergence window expires.
  const shouldRebuild = state.lastMs === 0
    || (!backoffActive && (
      controlBoundaryActive
      || hardCapBreachActive
      || (planConvergenceActive === true && deltaMeaningful)
      || maxIntervalExceeded
    ));
  return {
    shouldRebuild,
    controlBoundaryActive,
    deltaW,
    deltaMeaningful,
    maxIntervalExceeded,
    headroomTight,
    backoffActive,
  };
};

const resolveRebuildReason = (params: {
  state: PowerSampleRebuildState;
  decision: RebuildDecision;
  isInShortfall?: boolean;
  hardCapBreach?: HardCapBreach;
  planConvergenceActive?: boolean;
}): string => {
  const { state, decision, isInShortfall, hardCapBreach, planConvergenceActive } = params;
  if (state.lastMs === 0) return 'initial';
  if (isInShortfall) return 'shortfall';
  if (hardCapBreach?.breached) return 'hard_cap_breach';
  if (decision.headroomTight) return 'headroom_tight';
  if (planConvergenceActive === true && decision.deltaMeaningful) return 'power_sample_convergence';
  if (decision.deltaMeaningful) return 'power_delta';
  if (decision.maxIntervalExceeded) return 'max_interval';
  return 'unknown';
};

const isTightReason = (reason: string): boolean => (
  reason === 'headroom_tight' || reason === 'shortfall' || reason === 'hard_cap_breach'
);

function isTightNoopBackoffActive(params: {
  state: PowerSampleRebuildState;
  nowMs: number;
  headroomTight: boolean;
  isInShortfall?: boolean;
  hardCapBreachActive?: boolean;
  deltaMeaningful: boolean;
}): boolean {
  const {
    state,
    nowMs,
    headroomTight,
    isInShortfall,
    hardCapBreachActive,
    deltaMeaningful,
  } = params;
  if (!headroomTight && !isInShortfall && !hardCapBreachActive) return false;
  if (deltaMeaningful) return false;
  return isFutureMs(state.backoffUntilMs, nowMs)
    || isFutureMs(state.mitigationHoldoffUntilMs, nowMs);
}

const isFutureMs = (value: number | undefined, nowMs: number): boolean => (
  typeof value === 'number' && nowMs < value
);

const resolveTightNoopBackoffMs = (streak: number): number => {
  const index = Math.max(0, streak - 1);
  return Math.min(
    TIGHT_NOOP_BACKOFF_MAX_MS,
    TIGHT_NOOP_BACKOFF_MS[index] ?? TIGHT_NOOP_BACKOFF_MAX_MS,
  );
};

const shouldApplyTightNoopBackoff = (reason: string, outcome: RebuildOutcome | void): boolean => {
  if (!isTightReason(reason) || !outcome) return false;
  return outcome.actionChanged === false
    && outcome.appliedActions === false
    && outcome.failed === false;
};

const isTightNoopOutcome = (reason: string, outcome: RebuildOutcome | void): boolean => (
  shouldApplyTightNoopBackoff(reason, outcome)
);

const shouldApplyTightMitigationHoldoff = (
  reason: string,
  outcome: RebuildOutcome | void,
): boolean => {
  if (!isTightReason(reason) || !outcome || outcome.failed) return false;
  return outcome.actionChanged || outcome.appliedActions;
};

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

const hasTightNoopBackoffState = (state: PowerSampleRebuildState): boolean => (
  (state.tightNoopStreak ?? 0) > 0
  || state.backoffUntilMs !== undefined
  || state.mitigationHoldoffUntilMs !== undefined
);

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
  pendingReason: undefined,
  pendingPowerW: undefined,
  pendingSoftLimitKw: undefined,
});

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
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    let pendingResolve: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      pendingResolve = resolve;
      const timer = setTimeout(() => {
        const latest = getState();
        const reason = latest.pendingReason ?? triggerReason;
        const nextState = { ...latest, timer: undefined, lastMs: Date.now() };
        setState(nextState);
        performRebuild(nextState, reason)
          .catch((error) => {
            logError(error as Error);
          })
          .finally(() => {
            const latest = getState();
            setState(clearPendingState(latest));
            resolve();
          });
      }, waitMs);
      const latest = getState();
      setState({
        ...withPendingInputs(latest, currentPowerW, softLimitKw, triggerReason),
        timer,
        pendingResolve: resolve,
      });
    });
    setState({ ...getState(), pending, pendingResolve });
    return pending;
  }
  incPerfCounter('plan_rebuild_pending_coalesced_total');
  const latest = getState();
  setState(withPendingInputs(latest, currentPowerW, softLimitKw, triggerReason));
  return getState().pending ?? Promise.resolve();
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

const resolveHardCapBreach = (
  totalPowerKw: number | null,
  shortfallThresholdKw: number,
): HardCapBreach => {
  if (totalPowerKw === null || !Number.isFinite(totalPowerKw)) {
    return { breached: false, deficitKw: 0 };
  }
  const deficitKw = Math.max(0, totalPowerKw - shortfallThresholdKw);
  return { breached: deficitKw > 0, deficitKw };
};

const resolveHardCapBreachFromSignal = (params: {
  capacityGuard?: CapacityGuard;
  capacitySettings: { limitKw: number };
  currentPowerW?: number;
  guardPower: number | null;
}): HardCapBreach => {
  const { capacityGuard, capacitySettings, currentPowerW, guardPower } = params;
  const shortfallThresholdKw = capacityGuard?.getShortfallThreshold() ?? capacitySettings.limitKw;
  const totalPowerKw = guardPower ?? (
    typeof currentPowerW === 'number' ? currentPowerW / 1000 : null
  );
  return resolveHardCapBreach(totalPowerKw, shortfallThresholdKw);
};

export async function recordPowerSampleForApp(params: {
  currentPowerW: number;
  nowMs?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  powerTracker: PowerTrackerState;
  capacityGuard?: CapacityGuard;
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
}): Promise<void> {
  const snapshotStart = Date.now();
  const {
    currentPowerW,
    nowMs = Date.now(),
    capacitySettings,
    getLatestTargetSnapshot,
    powerTracker,
    capacityGuard,
    schedulePlanRebuild,
    saveState,
  } = params;
  const hourBudgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const snapshot = getLatestTargetSnapshot();
  const { controlledKw } = snapshot.length
    ? splitControlledUsageKw({
      devices: snapshot,
      totalKw: currentPowerW / 1000,
    })
    : { controlledKw: null };
  const exemptKw = snapshot.length ? sumBudgetExemptLiveUsageKw(snapshot) : null;
  const controlledPowerW = controlledKw !== null ? Math.max(0, controlledKw * 1000) : undefined;
  const exemptPowerW = exemptKw !== null ? Math.max(0, exemptKw * 1000) : undefined;
  addPerfDuration('power_sample_snapshot_ms', Date.now() - snapshotStart);
  await recordPowerSampleCore({
    state: powerTracker,
    currentPowerW,
    controlledPowerW,
    exemptPowerW,
    nowMs,
    capacityGuard,
    hourBudgetKWh,
    rebuildPlanFromCache: schedulePlanRebuild,
    saveState,
  });
}

export function persistPowerTrackerStateForApp(params: {
  homey: Homey.App['homey'];
  powerTracker: PowerTrackerState;
  error: (msg: string, err: Error) => void;
}): void {
  const { homey, powerTracker, error } = params;
  const writeStart = Date.now();
  try {
    homey.settings.set('power_tracker_state', powerTracker);
    addPerfDuration('settings_write_ms', Date.now() - writeStart);
    incPerfCounter('settings_set.power_tracker_state');
  } catch (err) {
    error('Failed to persist power tracker', err as Error);
  }
}

export function prunePowerTrackerHistoryForApp(params: {
  powerTracker: PowerTrackerState;
  logDebug: (msg: string) => void;
  error: (msg: string, err: Error) => void;
}): PowerTrackerState {
  const { powerTracker, logDebug, error } = params;
  logDebug('Pruning power tracker history');
  const pruneStart = Date.now();
  try {
    const pruned = aggregateAndPruneHistory(powerTracker);
    addPerfDuration('power_tracker_prune_ms', Date.now() - pruneStart);
    incPerfCounter('power_tracker_save_total');
    return pruned;
  } catch (err) {
    error('Failed to prune power tracker history', err as Error);
    return powerTracker;
  }
}

export function updateDailyBudgetAndRecordCapForApp(params: {
  powerTracker: PowerTrackerState;
  dailyBudgetService: {
    updateState: (options?: { forcePlanRebuild?: boolean; nowMs?: number }) => void;
    getSnapshot: () => DailyBudgetUiPayload | null;
  };
  options?: { nowMs?: number; forcePlanRebuild?: boolean };
}): PowerTrackerState {
  const { powerTracker, dailyBudgetService, options } = params;
  dailyBudgetService.updateState(options);
  return recordDailyBudgetCap({
    powerTracker,
    snapshot: dailyBudgetService.getSnapshot(),
  });
}
