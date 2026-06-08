import {
  PLAN_REASON_CODES,
  type DeviceReason,
  type PlanReasonCode,
} from '../../packages/shared-domain/src/planReasonSemantics';

export type PlanStarvationCountingCause =
  | 'capacity'
  | 'daily_budget'
  | 'hourly_budget'
  | 'shortfall'
  | 'swap_pending'
  | 'swapped_out'
  | 'insufficient_headroom'
  | 'shedding_active';

export type PlanStarvationPauseReason =
  | 'cooldown'
  | 'restore'
  | 'restore_throttled'
  | 'activation_backoff'
  | 'headroom_cooldown'
  | 'keep'
  | 'inactive'
  | 'deferred_objective_avoid';

export type PlanStarvationSuppressionSemantics =
  | { state: 'none'; countingCause: null; pauseReason: null }
  | { state: 'paused'; countingCause: null; pauseReason: PlanStarvationPauseReason }
  | { state: 'counting'; countingCause: PlanStarvationCountingCause; pauseReason: null };

const RESTORE_ADMISSION_HOLD_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.cooldownRestore,
]);

// Reasons under which a producer-resolved deferred-objective resume (binary_restore)
// must NOT fire: the capacity planner has independently decided this device should
// stay off this cycle (capacity pressure, cooldowns, restore throttling/pending, the
// shed invariant, startup stabilization, waiting on other devices). The deferred-
// release producer reads this so a smart task claims power only when the planner
// agrees — it never overrides capacity/cooldown.
const DEFERRED_RESTORE_BLOCK_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.headroomCooldown,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.shedInvariant,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.waitingForOtherDevices,
]);

const STEPPED_KEEP_INVARIANT_RESTORE_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.keep,
  PLAN_REASON_CODES.restoreNeed,
]);

const COOLDOWN_BLOCK_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.headroomCooldown,
  PLAN_REASON_CODES.restorePending,
]);

const RESTORE_PAUSE_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.restoreNeed,
]);

const STARVATION_COOLDOWN_PAUSE_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
]);

const COUNTING_SUPPRESSION_CAUSES: Partial<Record<PlanReasonCode, PlanStarvationCountingCause>> = {
  [PLAN_REASON_CODES.capacity]: 'capacity',
  [PLAN_REASON_CODES.dailyBudget]: 'daily_budget',
  [PLAN_REASON_CODES.hourlyBudget]: 'hourly_budget',
  [PLAN_REASON_CODES.shortfall]: 'shortfall',
  [PLAN_REASON_CODES.swapPending]: 'swap_pending',
  [PLAN_REASON_CODES.swappedOut]: 'swapped_out',
  [PLAN_REASON_CODES.insufficientHeadroom]: 'insufficient_headroom',
  [PLAN_REASON_CODES.sheddingActive]: 'shedding_active',
};

export const isRestoreAdmissionHoldReason = (reason: DeviceReason): boolean => (
  RESTORE_ADMISSION_HOLD_REASON_CODES.has(reason.code)
);

export const isDeferredRestoreBlockedReason = (reason: DeviceReason): boolean => (
  DEFERRED_RESTORE_BLOCK_REASON_CODES.has(reason.code)
);

// A swap is pending against this device but the swap target is not yet known
// (`targetName === null`) — actuation must hold until the target resolves. Shared
// reason classifier (the deferred-release producer and the executor both gate on it).
export const isSwapTargetPendingReason = (reason: DeviceReason | undefined): boolean => (
  reason?.code === PLAN_REASON_CODES.swapPending && reason.targetName === null
);

export const allowsSteppedLoadKeepInvariantRestore = (reason: DeviceReason): boolean => (
  STEPPED_KEEP_INVARIANT_RESTORE_REASON_CODES.has(reason.code)
);

export const isCooldownBlockedReason = (reason: DeviceReason): boolean => (
  COOLDOWN_BLOCK_REASON_CODES.has(reason.code)
);

export const isActivationPenaltyBlockedReason = (reason: DeviceReason): boolean => (
  reason.code === PLAN_REASON_CODES.activationBackoff
);

export const isShedInvariantBlockedReason = (reason: DeviceReason): boolean => (
  reason.code === PLAN_REASON_CODES.shedInvariant
);

export function resolveStarvationSuppressionSemantics(reason: DeviceReason): PlanStarvationSuppressionSemantics {
  if (reason.code === PLAN_REASON_CODES.headroomCooldown) {
    return { state: 'paused', countingCause: null, pauseReason: 'headroom_cooldown' };
  }
  if (STARVATION_COOLDOWN_PAUSE_REASON_CODES.has(reason.code)) {
    return { state: 'paused', countingCause: null, pauseReason: 'cooldown' };
  }
  if (reason.code === PLAN_REASON_CODES.restoreThrottled) {
    return { state: 'paused', countingCause: null, pauseReason: 'restore_throttled' };
  }
  if (isActivationPenaltyBlockedReason(reason)) {
    return { state: 'paused', countingCause: null, pauseReason: 'activation_backoff' };
  }
  if (RESTORE_PAUSE_REASON_CODES.has(reason.code)) {
    return { state: 'paused', countingCause: null, pauseReason: 'restore' };
  }
  if (reason.code === PLAN_REASON_CODES.keep) {
    return { state: 'paused', countingCause: null, pauseReason: 'keep' };
  }
  if (reason.code === PLAN_REASON_CODES.inactive) {
    return { state: 'paused', countingCause: null, pauseReason: 'inactive' };
  }
  // A device held by `deferredObjectiveAvoid` is being deliberately deferred by
  // its own smart-task policy (waiting for a cheaper/reserved hour), not starved
  // for capacity — pause it with an attributed reason rather than letting it fall
  // through to the `unknown_suppression_reason` catch-all in planDiagnostics.
  if (reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid) {
    return { state: 'paused', countingCause: null, pauseReason: 'deferred_objective_avoid' };
  }
  const countingCause = COUNTING_SUPPRESSION_CAUSES[reason.code];
  if (countingCause) {
    return { state: 'counting', countingCause, pauseReason: null };
  }
  return { state: 'none', countingCause: null, pauseReason: null };
}
