import type { PlanRebuildTrigger, PowerSampleRebuildTrigger } from '../planRebuildTrigger';
import {
  resolveHeadroomTight,
  type HardCapBreach,
  type PowerRebuildSignal,
} from './rebuildSignal';


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

// `lastRebuildPowerW` is absent only until the first rebuild has run, which is
// a genuine "no previous sample to compare against" — not a missing input.
export const resolvePowerDelta = (
  signal: PowerRebuildSignal,
  lastRebuildPowerW: number | undefined,
): { deltaW: number; deltaMeaningful: boolean } => {
  const deltaThresholdW = Math.max(MIN_REBUILD_DELTA_W, signal.limitKw * 1000 * MIN_REBUILD_DELTA_RATIO);
  const deltaW = typeof lastRebuildPowerW === 'number'
    ? Math.abs(signal.currentPowerW - lastRebuildPowerW)
    : 0;
  return { deltaW, deltaMeaningful: deltaW >= deltaThresholdW };
};

// The last plan proved nothing can be shed or restored, so a full rebuild cannot
// change any device action no matter how urgent the trigger. Throttle to the
// max-interval cadence. Excludes the convergence path (which legitimately rebuilds
// on power deltas) and yields for one re-check when a device returns load (the
// invalidation latch), so newly-actionable load re-enters the normal decision
// gates. (The execution-side floor may still space that re-check by up to its
// interval — see `TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS`.)
export const isUnactionableThrottleActive = (
  signal: PowerRebuildSignal,
  suppressionInvalidated: boolean,
): boolean => (
  signal.unactionable
  && !signal.planConvergenceActive
  && !suppressionInvalidated
);

// Derives the execution-floor gate. Extracted from `resolveRebuildDecision` to keep
// that function under the cyclomatic-complexity ceiling. Anchored to the raw breach
// so it holds for a first/steady breach; excludes convergence (productive rebuilds)
// but stays independent of the latch so the floor still bites when the latch bypasses
// the decision throttle.
const resolveTightUnactionable = (
  signal: PowerRebuildSignal,
  headroomTight: boolean,
  hardCapBreachActive: boolean,
): boolean => {
  const boundaryActive = headroomTight || signal.isInShortfall || hardCapBreachActive;
  return signal.unactionable && !signal.planConvergenceActive && boundaryActive;
};

// `state` supplies the two gates that are pure functions of it — the initial
// sample and the invalidation latch — rather than being re-derived by the
// caller and handed back. The rest are this stage's own derivations.
export const shouldRebuildFromDecision = (
  signal: PowerRebuildSignal,
  state: RebuildDecisionState,
  controlBoundaryActive: boolean,
  hardCapBreachActive: boolean,
  backoffActive: boolean,
  deltaMeaningful: boolean,
  maxIntervalExceeded: boolean,
): boolean => {
  if (state.lastMs === 0) return true;
  // Sits above the hard-cap and backoff gates: when nothing is actionable, a
  // hard-cap breach or meaningful delta cannot change the outcome, so refresh
  // only on the max-interval cadence instead of every power sample.
  if (isUnactionableThrottleActive(signal, state.shortfallSuppressionInvalidated === true)) {
    return maxIntervalExceeded;
  }
  if (hardCapBreachActive) return true;
  if (backoffActive) return false;
  return controlBoundaryActive
    || (signal.planConvergenceActive && deltaMeaningful)
    || maxIntervalExceeded;
};

// `elapsedMs` is not a parameter: it is `nowMs - state.lastMs`, and both are
// already here. Passing it alongside let a caller hand in a third opinion.
export const resolveRebuildDecision = (
  signal: PowerRebuildSignal,
  state: RebuildDecisionState,
  nowMs: number,
  maxIntervalMs: number,
): RebuildDecision => {
  const headroomTight = resolveHeadroomTight(signal.headroomKw);
  const controlBoundaryActive = headroomTight || signal.isInShortfall;
  const hardCapBreachActive = signal.hardCapBreach.breached;
  const { deltaW, deltaMeaningful } = resolvePowerDelta(signal, state.lastRebuildPowerW);
  const maxIntervalExceeded = maxIntervalMs > 0 && (nowMs - state.lastMs) >= maxIntervalMs;
  const repeatedHardCapBreach = hardCapBreachActive && state.lastHardCapBreached === true;
  const hardCapDeficitIncreased = hardCapBreachActive
    && typeof state.lastHardCapDeficitKw === 'number'
    && signal.hardCapBreach.deficitKw > state.lastHardCapDeficitKw + MIN_HARD_CAP_DEFICIT_DELTA_KW;
  const hardCapBreachShouldRebuild = hardCapBreachActive && (
    !repeatedHardCapBreach
    || deltaMeaningful
    || hardCapDeficitIncreased
    || maxIntervalExceeded
  );
  const backoffActive = isTightNoopBackoffActive(
    signal,
    state,
    nowMs,
    headroomTight,
    deltaMeaningful,
  );
  const shouldRebuild = shouldRebuildFromDecision(
    signal,
    state,
    controlBoundaryActive,
    hardCapBreachShouldRebuild,
    backoffActive,
    deltaMeaningful,
    maxIntervalExceeded,
  );
  const tightUnactionable = resolveTightUnactionable(signal, headroomTight, hardCapBreachActive);
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

export const resolveRebuildReason = (
  signal: PowerRebuildSignal,
  state: RebuildDecisionState,
  decision: RebuildDecision,
): PowerSampleRebuildTrigger => {
  if (state.lastMs === 0) return 'initial';
  if (signal.isInShortfall) return 'shortfall';
  if (signal.hardCapBreach.breached) return 'hard_cap_breach';
  if (decision.headroomTight) return 'headroom_tight';
  if (signal.planConvergenceActive && decision.deltaMeaningful) return 'power_sample_convergence';
  if (decision.deltaMeaningful) return 'power_delta';
  if (decision.maxIntervalExceeded) return 'max_interval';
  return 'unknown';
};

export const resolveRebuildIntentKind = (hardCapBreach: HardCapBreach): RebuildIntentKind => (
  hardCapBreach.breached ? 'hardCap' : 'signal'
);

export const isTightReason = (reason: PlanRebuildTrigger): boolean => (
  reason === 'headroom_tight' || reason === 'shortfall' || reason === 'hard_cap_breach'
);

export function isTightNoopBackoffActive(
  signal: PowerRebuildSignal,
  state: RebuildDecisionState,
  nowMs: number,
  headroomTight: boolean,
  deltaMeaningful: boolean,
): boolean {
  if (!headroomTight && !signal.isInShortfall) return false;
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

export const shouldApplyTightNoopBackoff = (reason: PlanRebuildTrigger, outcome: RebuildOutcome | void): boolean => {
  if (!isTightReason(reason) || !outcome) return false;
  return outcome.actionChanged === false
    && outcome.appliedActions === false
    && outcome.failed === false;
};

export const isTightNoopOutcome = (reason: PlanRebuildTrigger, outcome: RebuildOutcome | void): boolean => (
  shouldApplyTightNoopBackoff(reason, outcome)
);

export const shouldApplyTightMitigationHoldoff = (
  reason: PlanRebuildTrigger,
  outcome: RebuildOutcome | void,
): boolean => {
  if (!isTightReason(reason) || !outcome || outcome.failed) return false;
  return outcome.actionChanged || outcome.appliedActions;
};

