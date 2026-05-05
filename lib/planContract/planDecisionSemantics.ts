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
  | 'inactive';

export type PlanStarvationSuppressionSemantics =
  | { state: 'none'; countingCause: null; pauseReason: null }
  | { state: 'paused'; countingCause: null; pauseReason: PlanStarvationPauseReason }
  | { state: 'counting'; countingCause: PlanStarvationCountingCause; pauseReason: null };

const RESTORE_ADMISSION_HOLD_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.cooldownRestore,
]);

const STEPPED_KEEP_INVARIANT_RESTORE_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.keep,
  PLAN_REASON_CODES.restoreNeed,
]);

const SHED_WINDOW_HOLD_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.startupStabilization,
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

export const allowsSteppedLoadKeepInvariantRestore = (reason: DeviceReason): boolean => (
  STEPPED_KEEP_INVARIANT_RESTORE_REASON_CODES.has(reason.code)
);

export const isShedWindowHoldReason = (reason: DeviceReason): boolean => (
  SHED_WINDOW_HOLD_REASON_CODES.has(reason.code)
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
  const countingCause = COUNTING_SUPPRESSION_CAUSES[reason.code];
  if (countingCause) {
    return { state: 'counting', countingCause, pauseReason: null };
  }
  return { state: 'none', countingCause: null, pauseReason: null };
}
