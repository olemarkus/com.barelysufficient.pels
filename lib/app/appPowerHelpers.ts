import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { recordPowerSample as recordPowerSampleCore } from '../core/powerTracker';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { sumControlledUsageKw } from '../plan/planUsage';
import type { TargetDeviceSnapshot } from '../utils/types';
import { aggregateAndPruneHistory } from '../core/powerTracker';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';

export type PowerSampleRebuildState = {
  lastMs: number;
  lastRebuildPowerW?: number;
  lastSoftLimitKw?: number;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  pendingPowerW?: number;
  pendingSoftLimitKw?: number;
  pendingReason?: string;
};

type RebuildDecision = {
  shouldRebuild: boolean;
  deltaW: number;
  deltaMeaningful: boolean;
  softLimitChanged: boolean;
  maxIntervalExceeded: boolean;
  isDangerZone: boolean;
  headroomTight: boolean;
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

const DANGER_ZONE_MARGIN_RATIO = 0.1; // 10%
const MIN_REBUILD_DELTA_W = 100;
const MIN_REBUILD_DELTA_RATIO = 0.005; // 0.5% of limit
const MIN_SOFT_LIMIT_DELTA_KW = 0.1;
const MIN_SOFT_LIMIT_DELTA_RATIO = 0.01; // 1% of limit

const resolveDangerZone = (currentPowerW: number | undefined, limitKw: number): boolean => {
  if (typeof currentPowerW !== 'number') return false;
  const dangerLimitW = (limitKw * (1 - DANGER_ZONE_MARGIN_RATIO)) * 1000;
  return currentPowerW >= dangerLimitW;
};

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

const resolveSoftLimitChange = (params: {
  softLimitKw?: number;
  lastSoftLimitKw?: number;
  limitKw: number;
}): { softLimitChanged: boolean } => {
  const { softLimitKw, lastSoftLimitKw, limitKw } = params;
  if (typeof softLimitKw !== 'number') return { softLimitChanged: false };
  const softLimitDeltaThresholdKw = Math.max(MIN_SOFT_LIMIT_DELTA_KW, limitKw * MIN_SOFT_LIMIT_DELTA_RATIO);
  if (typeof lastSoftLimitKw !== 'number') return { softLimitChanged: true };
  const softLimitDeltaKw = Math.abs(softLimitKw - lastSoftLimitKw);
  return { softLimitChanged: softLimitDeltaKw >= softLimitDeltaThresholdKw };
};

const resolveRebuildDecision = (params: {
  state: PowerSampleRebuildState;
  elapsedMs: number;
  maxIntervalMs: number;
  limitKw: number;
  currentPowerW?: number;
  powerDeltaW?: number;
  softLimitKw?: number;
  headroomKw?: number | null;
  isInShortfall?: boolean;
}): RebuildDecision => {
  const {
    state,
    elapsedMs,
    maxIntervalMs,
    limitKw,
    currentPowerW,
    powerDeltaW,
    softLimitKw,
    headroomKw,
    isInShortfall,
  } = params;
  const isDangerZone = resolveDangerZone(currentPowerW, limitKw);
  const headroomTight = resolveHeadroomTight(headroomKw);
  const { deltaW, deltaMeaningful } = resolvePowerDelta({
    currentPowerW,
    powerDeltaW,
    lastRebuildPowerW: state.lastRebuildPowerW,
    limitKw,
  });
  const { softLimitChanged } = resolveSoftLimitChange({
    softLimitKw,
    lastSoftLimitKw: state.lastSoftLimitKw,
    limitKw,
  });
  const maxIntervalExceeded = maxIntervalMs > 0 && elapsedMs >= maxIntervalMs;
  const shouldRebuild = state.lastMs === 0
    || isDangerZone
    || headroomTight
    || isInShortfall
    || softLimitChanged
    || deltaMeaningful
    || maxIntervalExceeded;
  return {
    shouldRebuild,
    deltaW,
    deltaMeaningful,
    softLimitChanged,
    maxIntervalExceeded,
    isDangerZone,
    headroomTight,
  };
};

const resolveRebuildReason = (params: {
  state: PowerSampleRebuildState;
  decision: RebuildDecision;
  isInShortfall?: boolean;
}): string => {
  const { state, decision, isInShortfall } = params;
  if (state.lastMs === 0) return 'initial';
  if (decision.isDangerZone) return 'danger_zone';
  if (decision.headroomTight) return 'headroom_tight';
  if (isInShortfall) return 'shortfall';
  if (decision.softLimitChanged) return 'soft_limit_changed';
  if (decision.deltaMeaningful) return 'power_delta';
  if (decision.maxIntervalExceeded) return 'max_interval';
  return 'unknown';
};

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

const recordPowerSampleRebuildRequest = (reason: string): void => {
  incPerfCounter('plan_rebuild_requested_total');
  incPerfCounter('plan_rebuild_requested.power_sample_total');
  incReasonCounter('plan_rebuild_requested.power_sample_reason', reason);
};

const recordPowerSampleRebuildExecution = (reason: string): void => {
  incPerfCounter('plan_rebuild_execute_total');
  incPerfCounter('plan_rebuild_execute.power_sample_total');
  incReasonCounter('plan_rebuild_execute.power_sample_reason', reason);
};

export function schedulePlanRebuildFromPowerSample(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  minIntervalMs: number;
  maxIntervalMs: number;
  rebuildPlanFromCache: () => Promise<void>;
  logError: (error: Error) => void;
  currentPowerW?: number;
  powerDeltaW?: number;
  limitKw: number;
  softLimitKw?: number;
  headroomKw?: number | null;
  isInShortfall?: boolean;
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
  } = params;
  const state = getState();
  const now = Date.now();
  const elapsedMs = now - state.lastMs;

  const decision = resolveRebuildDecision({
    state,
    elapsedMs,
    maxIntervalMs,
    limitKw,
    currentPowerW,
    powerDeltaW,
    softLimitKw,
    headroomKw,
    isInShortfall,
  });
  const triggerReason = resolveRebuildReason({
    state,
    decision,
    isInShortfall,
  });

  if (!decision.shouldRebuild) {
    incPerfCounter('plan_rebuild_skipped_total');
    incPerfCounter('plan_rebuild_skipped_insignificant_total');
    incPerfCounter('plan_rebuild_skipped_reason.stable_total');
    // Skip rebuild, but don't update lastMs or state, so we stay ready.
    return Promise.resolve();
  }
  recordPowerSampleRebuildRequest(triggerReason);

  const performRebuild = async (snapshot: PowerSampleRebuildState, reason: string): Promise<void> => {
    recordPowerSampleRebuildExecution(reason);
    const nextPowerW = resolvePendingPowerW(snapshot, currentPowerW);
    const nextSoftLimitKw = resolvePendingSoftLimitKw(snapshot, softLimitKw);
    setState(buildPostRebuildState(snapshot, nextPowerW, nextSoftLimitKw));
    return rebuildPlanFromCache();
  };

  if (elapsedMs >= minIntervalMs) {
    const nextState = {
      ...state,
      lastMs: now,
      pendingPowerW: undefined,
      pendingSoftLimitKw: undefined,
      pendingReason: undefined,
    };
    setState(nextState);
    return performRebuild(nextState, triggerReason);
  }

  if (!state.pending) {
    incPerfCounter('plan_rebuild_pending_created_total');
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    const pending = new Promise<void>((resolve) => {
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
            setState({ ...getState(), pending: undefined, pendingReason: undefined });
            resolve();
          });
      }, waitMs);
      setState({
        ...getState(),
        timer,
        pendingPowerW: typeof currentPowerW === 'number' ? currentPowerW : state.pendingPowerW,
        pendingSoftLimitKw: typeof softLimitKw === 'number' ? softLimitKw : state.pendingSoftLimitKw,
        pendingReason: triggerReason,
      });
    });
    setState({ ...getState(), pending });
    return pending;
  }
  incPerfCounter('plan_rebuild_pending_coalesced_total');
  setState({
    ...getState(),
    pendingPowerW: typeof currentPowerW === 'number' ? currentPowerW : state.pendingPowerW,
    pendingSoftLimitKw: typeof softLimitKw === 'number' ? softLimitKw : state.pendingSoftLimitKw,
    pendingReason: triggerReason,
  });
  return getState().pending ?? Promise.resolve();
}

export function schedulePlanRebuildFromSignal(params: {
  getState: () => PowerSampleRebuildState;
  setState: (state: PowerSampleRebuildState) => void;
  minIntervalMs: number;
  stableMinIntervalMs?: number;
  maxIntervalMs: number;
  rebuildPlanFromCache: () => Promise<void>;
  logError: (error: Error) => void;
  currentPowerW?: number;
  powerDeltaW?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityGuard?: CapacityGuard;
}): Promise<void> {
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
  } = params;
  const softLimitKw = capacityGuard?.getSoftLimit()
    ?? Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const headroomKw = capacityGuard?.getHeadroom()
    ?? (typeof currentPowerW === 'number' ? softLimitKw - currentPowerW / 1000 : null);
  const isInShortfall = capacityGuard?.isInShortfall() ?? false;
  const isDangerZone = resolveDangerZone(currentPowerW, capacitySettings.limitKw);
  const headroomTight = resolveHeadroomTight(headroomKw);
  const stableIntervalMs = typeof stableMinIntervalMs === 'number' ? stableMinIntervalMs : minIntervalMs;
  const effectiveMinIntervalMs = (!isDangerZone && !headroomTight && !isInShortfall)
    ? Math.max(minIntervalMs, stableIntervalMs)
    : minIntervalMs;
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
  });
}

export async function recordPowerSampleForApp(params: {
  currentPowerW: number;
  nowMs?: number;
  capacitySettings: { limitKw: number; marginKw: number };
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  powerTracker: PowerTrackerState;
  capacityGuard?: CapacityGuard;
  homey: Homey.App['homey'];
  schedulePlanRebuild: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
}): Promise<void> {
  const {
    currentPowerW,
    nowMs = Date.now(),
    capacitySettings,
    getLatestTargetSnapshot,
    powerTracker,
    capacityGuard,
    homey,
    schedulePlanRebuild,
    saveState,
  } = params;
  const hourBudgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const snapshot = getLatestTargetSnapshot();
  const totalKw = snapshot.length ? sumControlledUsageKw(snapshot) : null;
  const controlledPowerW = totalKw !== null ? Math.max(0, totalKw * 1000) : undefined;
  await recordPowerSampleCore({
    state: powerTracker,
    currentPowerW,
    controlledPowerW,
    nowMs,
    capacityGuard,
    hourBudgetKWh,
    rebuildPlanFromCache: schedulePlanRebuild,
    saveState,
    homey,
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
