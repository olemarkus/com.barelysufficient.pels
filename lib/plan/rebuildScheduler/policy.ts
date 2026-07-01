import type CapacityGuard from '../../power/capacityGuard';

export type RebuildDecisionState = {
  lastMs: number;
  lastRebuildPowerW?: number;
  lastHardCapBreached?: boolean;
  lastHardCapDeficitKw?: number;
  backoffUntilMs?: number;
  mitigationHoldoffUntilMs?: number;
  shortfallSuppressionInvalidated?: boolean;
};

export type RebuildDecision = {
  shouldRebuild: boolean;
  controlBoundaryActive: boolean;
  deltaW: number;
  deltaMeaningful: boolean;
  maxIntervalExceeded: boolean;
  headroomTight: boolean;
  backoffActive: boolean;
  // The last plan proved nothing can be shed or restored while a capacity
  // boundary is active (tight/shortfall/hard-cap breach). Gates the
  // execution-side floor so no trigger can rebuild faster than the floor
  // while the state is unwinnable — see `TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS`.
  tightUnactionable: boolean;
};

export type RebuildIntentKind = 'hardCap' | 'signal';

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
const MIN_HARD_CAP_DEFICIT_DELTA_KW = 0.001;
const TIGHT_NOOP_BACKOFF_MS = [15_000, 30_000, 60_000];
const TIGHT_NOOP_BACKOFF_MAX_MS = 120_000;
export const TIGHT_MITIGATION_HOLDOFF_MS = 15_000;
// Hard floor between *executed* rebuilds while a capacity boundary is active and
// the last plan proved nothing is actionable. A ~1.4s build at 15s ≈ 9% CPU (vs
// ~20% at the 6–9s per-sample cadence that trips Homey's cpuwarn watchdog). Kept
// below the 30s max-interval so it never delays the intended refresh — it only
// bites if the decision throttle is bypassed (e.g. the one-shot invalidation latch).
export const TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS = 15_000;

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

// The last plan proved nothing can be shed or restored, so a full rebuild cannot
// change any device action no matter how urgent the trigger. Throttle to the
// max-interval cadence. Excludes the convergence path (which legitimately rebuilds
// on power deltas) and yields for one re-check when a device returns load (the
// invalidation latch), so newly-actionable load re-enters the normal decision
// gates. (The execution-side floor may still space that re-check by up to its
// interval — see `TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS`.)
export const isUnactionableThrottleActive = (params: {
  unactionable?: boolean;
  planConvergenceActive?: boolean;
  suppressionInvalidated?: boolean;
}): boolean => (
  params.unactionable === true
  && params.planConvergenceActive !== true
  && params.suppressionInvalidated !== true
);

// Derives the execution-floor gate. Extracted from `resolveRebuildDecision` to keep
// that function under the cyclomatic-complexity ceiling. Anchored to the raw breach
// so it holds for a first/steady breach; excludes convergence (productive rebuilds)
// but stays independent of the latch so the floor still bites when the latch bypasses
// the decision throttle.
const resolveTightUnactionable = (params: {
  unactionable?: boolean;
  planConvergenceActive?: boolean;
  headroomTight: boolean;
  isInShortfall?: boolean;
  hardCapBreachActive: boolean;
}): boolean => {
  const {
    unactionable,
    planConvergenceActive,
    headroomTight,
    isInShortfall,
    hardCapBreachActive,
  } = params;
  const boundaryActive = headroomTight || Boolean(isInShortfall) || hardCapBreachActive;
  return unactionable === true && planConvergenceActive !== true && boundaryActive;
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
  unactionable?: boolean;
  suppressionInvalidated?: boolean;
}): boolean => {
  const {
    isInitialSample,
    controlBoundaryActive,
    hardCapBreachActive,
    planConvergenceActive,
    backoffActive,
    deltaMeaningful,
    maxIntervalExceeded,
    unactionable,
    suppressionInvalidated,
  } = params;
  if (isInitialSample) return true;
  // Sits above the hard-cap and backoff gates: when nothing is actionable, a
  // hard-cap breach or meaningful delta cannot change the outcome, so refresh
  // only on the max-interval cadence instead of every power sample.
  if (isUnactionableThrottleActive({ unactionable, planConvergenceActive, suppressionInvalidated })) {
    return maxIntervalExceeded;
  }
  if (hardCapBreachActive) return true;
  if (backoffActive) return false;
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
  unactionable?: boolean;
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
    unactionable,
  } = params;
  const suppressionInvalidated = state.shortfallSuppressionInvalidated;
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
  const repeatedHardCapBreach = hardCapBreachActive && state.lastHardCapBreached === true;
  const hardCapDeficitIncreased = hardCapBreachActive
    && typeof state.lastHardCapDeficitKw === 'number'
    && (hardCapBreach?.deficitKw ?? 0) > state.lastHardCapDeficitKw + MIN_HARD_CAP_DEFICIT_DELTA_KW;
  const hardCapBreachShouldRebuild = hardCapBreachActive && (
    !repeatedHardCapBreach
    || deltaMeaningful
    || hardCapDeficitIncreased
    || maxIntervalExceeded
  );
  const backoffActive = isTightNoopBackoffActive({
    state,
    nowMs,
    headroomTight,
    isInShortfall,
    hardCapBreachActive: hardCapBreachShouldRebuild,
    deltaMeaningful,
  });
  const shouldRebuild = shouldRebuildFromDecision({
    isInitialSample: state.lastMs === 0,
    controlBoundaryActive,
    hardCapBreachActive: hardCapBreachShouldRebuild,
    planConvergenceActive,
    isInShortfall,
    backoffActive,
    deltaMeaningful,
    maxIntervalExceeded,
    unactionable,
    suppressionInvalidated,
  });
  const tightUnactionable = resolveTightUnactionable({
    unactionable,
    planConvergenceActive,
    headroomTight,
    isInShortfall,
    hardCapBreachActive,
  });
  return {
    shouldRebuild,
    controlBoundaryActive,
    deltaW,
    deltaMeaningful,
    maxIntervalExceeded,
    headroomTight,
    backoffActive,
    tightUnactionable,
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

export const resolveRebuildIntentKind = (params: {
  hardCapBreach?: HardCapBreach;
}): RebuildIntentKind => (
  params.hardCapBreach?.breached === true ? 'hardCap' : 'signal'
);

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
  const { state, nowMs, headroomTight, isInShortfall, deltaMeaningful } = params;
  if (!headroomTight && !isInShortfall) return false;
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
