export const PLAN_REASON_CODES = {
  none: 'none',
  keep: 'keep',
  restoreNeed: 'restore_need',
  setTarget: 'set_target',
  swapPending: 'swap_pending',
  swappedOut: 'swapped_out',
  hourlyBudget: 'hourly_budget',
  dailyBudget: 'daily_budget',
  shortfall: 'shortfall',
  cooldownShedding: 'cooldown_shedding',
  cooldownRestore: 'cooldown_restore',
  meterSettling: 'meter_settling',
  activationBackoff: 'activation_backoff',
  restorePending: 'restore_pending',
  headroomCooldown: 'headroom_cooldown',
  restoreThrottled: 'restore_throttled',
  waitingForOtherDevices: 'waiting_for_other_devices',
  insufficientHeadroom: 'insufficient_headroom',
  sheddingActive: 'shedding_active',
  inactive: 'inactive',
  capacity: 'capacity',
  neutralStartupHold: 'neutral_startup_hold',
  startupStabilization: 'startup_stabilization',
  capacityControlOff: 'capacity_control_off',
  shedInvariant: 'shed_invariant',
  other: 'other',
} as const;

export type PlanReasonCode = typeof PLAN_REASON_CODES[keyof typeof PLAN_REASON_CODES];

export type DeviceReason =
  | { code: typeof PLAN_REASON_CODES.none }
  | { code: typeof PLAN_REASON_CODES.keep; detail: string | null }
  | {
    code: typeof PLAN_REASON_CODES.restoreNeed;
    fromTarget: string | null;
    toTarget: string | null;
    needKw: number;
    headroomKw: number | null;
  }
  | { code: typeof PLAN_REASON_CODES.setTarget; targetText: string }
  | { code: typeof PLAN_REASON_CODES.swapPending; targetName: string | null }
  | { code: typeof PLAN_REASON_CODES.swappedOut; targetName: string | null }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.dailyBudget; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.shortfall; needKw: number | null; headroomKw: number | null }
  | { code: typeof PLAN_REASON_CODES.cooldownShedding; remainingSec: number }
  | { code: typeof PLAN_REASON_CODES.cooldownRestore; remainingSec: number }
  | { code: typeof PLAN_REASON_CODES.meterSettling; remainingSec: number }
  | { code: typeof PLAN_REASON_CODES.activationBackoff; remainingSec: number }
  | { code: typeof PLAN_REASON_CODES.restorePending; remainingSec: number }
  | {
    code: typeof PLAN_REASON_CODES.headroomCooldown;
    kind: 'recent_pels_shed' | 'recent_pels_restore' | 'usage_step_down';
    remainingSec: number;
    fromKw: number | null;
    toKw: number | null;
  }
  | { code: typeof PLAN_REASON_CODES.restoreThrottled }
  | { code: typeof PLAN_REASON_CODES.waitingForOtherDevices }
  | {
    code: typeof PLAN_REASON_CODES.insufficientHeadroom;
    needKw: number;
    availableKw: number | null;
    postReserveMarginKw: number | null;
    minimumRequiredPostReserveMarginKw: number | null;
    penaltyExtraKw: number | null;
    swapReserveKw: number | null;
    effectiveAvailableKw: number | null;
    swapTargetName: string | null;
  }
  | { code: typeof PLAN_REASON_CODES.sheddingActive; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.inactive; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.capacity; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.neutralStartupHold }
  | { code: typeof PLAN_REASON_CODES.startupStabilization }
  | { code: typeof PLAN_REASON_CODES.capacityControlOff }
  | {
    code: typeof PLAN_REASON_CODES.shedInvariant;
    fromStep: string;
    toStep: string;
    shedDeviceCount: number;
    maxStep: string;
  }
  | { code: typeof PLAN_REASON_CODES.other; text: string };

const REASON_LABELS = {
  [PLAN_REASON_CODES.none]: 'unknown',
  [PLAN_REASON_CODES.keep]: 'keep',
  [PLAN_REASON_CODES.restoreNeed]: 'restore',
  [PLAN_REASON_CODES.setTarget]: 'set target',
  [PLAN_REASON_CODES.swapPending]: 'swap pending',
  [PLAN_REASON_CODES.swappedOut]: 'swapped out',
  [PLAN_REASON_CODES.hourlyBudget]: 'hourly budget',
  [PLAN_REASON_CODES.dailyBudget]: 'daily budget',
  [PLAN_REASON_CODES.shortfall]: 'shortfall',
  [PLAN_REASON_CODES.cooldownShedding]: 'cooldown (shedding)',
  [PLAN_REASON_CODES.cooldownRestore]: 'cooldown (restore)',
  [PLAN_REASON_CODES.meterSettling]: 'meter settling',
  [PLAN_REASON_CODES.activationBackoff]: 'activation backoff',
  [PLAN_REASON_CODES.restorePending]: 'restore pending',
  [PLAN_REASON_CODES.headroomCooldown]: 'headroom cooldown',
  [PLAN_REASON_CODES.restoreThrottled]: 'restore throttled',
  [PLAN_REASON_CODES.waitingForOtherDevices]: 'waiting for other devices',
  [PLAN_REASON_CODES.insufficientHeadroom]: 'insufficient headroom',
  [PLAN_REASON_CODES.sheddingActive]: 'shedding active',
  [PLAN_REASON_CODES.inactive]: 'inactive',
  [PLAN_REASON_CODES.capacity]: 'capacity',
  [PLAN_REASON_CODES.neutralStartupHold]: 'left off',
  [PLAN_REASON_CODES.startupStabilization]: 'startup stabilization',
  [PLAN_REASON_CODES.capacityControlOff]: 'capacity control off',
  [PLAN_REASON_CODES.shedInvariant]: 'shed invariant',
  [PLAN_REASON_CODES.other]: 'other',
} as const satisfies Record<PlanReasonCode, string>;

export function getPlanReasonLabel(code: PlanReasonCode): string {
  return REASON_LABELS[code];
}
