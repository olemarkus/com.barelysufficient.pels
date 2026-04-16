import type CapacityGuard from '../core/capacityGuard';

export type RebuildDecisionState = {
  lastMs: number;
  lastRebuildPowerW?: number;
  backoffUntilMs?: number;
  mitigationHoldoffUntilMs?: number;
};

export type RebuildDecision = {
  shouldRebuild: boolean;
  controlBoundaryActive: boolean;
  deltaW: number;
  deltaMeaningful: boolean;
  maxIntervalExceeded: boolean;
  headroomTight: boolean;
  backoffActive: boolean;
};

export type RebuildOutcome = {
  actionChanged: boolean;
  appliedActions: boolean;
  failed: boolean;
};

export type HardCapBreach = {
  breached: boolean;
  deficitKw: number;
};

const MIN_REBUILD_DELTA_W = 100;
const MIN_REBUILD_DELTA_RATIO = 0.005; // 0.5% of limit
const TIGHT_NOOP_BACKOFF_MS = [15_000, 30_000, 60_000];
const TIGHT_NOOP_BACKOFF_MAX_MS = 120_000;
export const TIGHT_MITIGATION_HOLDOFF_MS = 15_000;

export const resolveHeadroomTight = (headroomKw: number | null | undefined): boolean => {
  return typeof headroomKw === 'number' && headroomKw <= 0;
};

export const resolvePowerDelta = (params: {
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

export const shouldRebuildFromDecision = (params: {
  isInitialSample: boolean;
  controlBoundaryActive: boolean;
  hardCapBreachActive: boolean;
  planConvergenceActive?: boolean;
  isInShortfall?: boolean;
  backoffActive: boolean;
  deltaMeaningful: boolean;
  maxIntervalExceeded: boolean;
}): boolean => {
  const {
    isInitialSample,
    controlBoundaryActive,
    hardCapBreachActive,
    planConvergenceActive,
    isInShortfall,
    backoffActive,
    deltaMeaningful,
    maxIntervalExceeded,
  } = params;
  if (isInitialSample) return true;
  if (backoffActive) return false;
  // Let the first hard-cap breach force an urgent rebuild so shortfall detection can run,
  // but an active tight-noop/mitigation holdoff still suppresses repeated breached samples.
  if (hardCapBreachActive && !isInShortfall) return true;
  return controlBoundaryActive
    || (planConvergenceActive === true && deltaMeaningful)
    || maxIntervalExceeded;
};

export const resolveRebuildDecision = (params: {
  state: RebuildDecisionState;
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
  const shouldRebuild = shouldRebuildFromDecision({
    isInitialSample: state.lastMs === 0,
    controlBoundaryActive,
    hardCapBreachActive,
    planConvergenceActive,
    isInShortfall,
    backoffActive,
    deltaMeaningful,
    maxIntervalExceeded,
  });
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

export const resolveRebuildReason = (params: {
  state: RebuildDecisionState;
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

export const isTightReason = (reason: string): boolean => (
  reason === 'headroom_tight' || reason === 'shortfall' || reason === 'hard_cap_breach'
);

export function isTightNoopBackoffActive(params: {
  state: RebuildDecisionState;
  nowMs: number;
  headroomTight: boolean;
  isInShortfall?: boolean;
  hardCapBreachActive?: boolean;
  deltaMeaningful: boolean;
}): boolean {
  const { state, nowMs, headroomTight, isInShortfall, hardCapBreachActive, deltaMeaningful } = params;
  if (!headroomTight && !isInShortfall && !hardCapBreachActive) return false;
  if (deltaMeaningful) return false;
  return isFutureMs(state.backoffUntilMs, nowMs)
    || isFutureMs(state.mitigationHoldoffUntilMs, nowMs);
}

export const isFutureMs = (value: number | undefined, nowMs: number): boolean => (
  typeof value === 'number' && nowMs < value
);

export const resolveTightNoopBackoffMs = (streak: number): number => {
  const index = Math.max(0, streak - 1);
  return Math.min(
    TIGHT_NOOP_BACKOFF_MAX_MS,
    TIGHT_NOOP_BACKOFF_MS[index] ?? TIGHT_NOOP_BACKOFF_MAX_MS,
  );
};

export const shouldApplyTightNoopBackoff = (reason: string, outcome: RebuildOutcome | void): boolean => {
  if (!isTightReason(reason) || !outcome) return false;
  return outcome.actionChanged === false
    && outcome.appliedActions === false
    && outcome.failed === false;
};

export const isTightNoopOutcome = (reason: string, outcome: RebuildOutcome | void): boolean => (
  shouldApplyTightNoopBackoff(reason, outcome)
);

export const shouldApplyTightMitigationHoldoff = (
  reason: string,
  outcome: RebuildOutcome | void,
): boolean => {
  if (!isTightReason(reason) || !outcome || outcome.failed) return false;
  return outcome.actionChanged || outcome.appliedActions;
};

export const resolveHardCapBreach = (
  totalPowerKw: number | null,
  shortfallThresholdKw: number,
): HardCapBreach => {
  if (totalPowerKw === null || !Number.isFinite(totalPowerKw)) {
    return { breached: false, deficitKw: 0 };
  }
  const deficitKw = Math.max(0, totalPowerKw - shortfallThresholdKw);
  return { breached: deficitKw > 0, deficitKw };
};

export const resolveHardCapBreachFromSignal = (params: {
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
