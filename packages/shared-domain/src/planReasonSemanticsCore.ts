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
  deferredObjectiveAvoid: 'deferred_objective_avoid',
  // Standing "Run on solar surplus" hold for a binary dump load: the device's
  // baseline is OFF and PELS lifts the hold only while the surplus allocator
  // marks it eligible. Deliberately carries NO numbers/timestamps — the reason
  // must be byte-stable across plan cycles (rebuild-storm class, f1550cea).
  awaitingSolarSurplus: 'awaiting_solar_surplus',
  // "Leave off until turned on again": an opted-in device was turned off outside
  // PELS, independently of its current plan. PELS is NOT holding the device back
  // — it is respecting an explicit action — so this pairs with the display-only
  // `Off` state word, never `Limited`.
  // Like `awaitingSolarSurplus`, it deliberately carries NO detail: the reason
  // must be byte-stable across plan cycles (rebuild-storm class, f1550cea).
  externalOffHold: 'external_off_hold',
  neutralStartupHold: 'neutral_startup_hold',
  startupStabilization: 'startup_stabilization',
  capacityControlOff: 'capacity_control_off',
  shedInvariant: 'shed_invariant',
  // A more important device has reserved the power it needs to start
  // (`lib/plan/admission/headroomReserve.ts`), so this device stands down. Distinct from
  // `capacity`: there is no hard-cap pressure, the available power is simply spoken for, and
  // nothing was turned off to create the reservation. Lands on a device that is off and waiting to
  // resume, and on an active stepped device denied a step-up.
  reservedForStart: 'reserved_for_start',
  other: 'other',
} as const;

export type PlanReasonCode = typeof PLAN_REASON_CODES[keyof typeof PLAN_REASON_CODES];

export type CountdownReasonTiming = {
  countdownStartedAtMs?: number;
  countdownTotalSec?: number;
};

// The power that, if it became available, would admit this device — already
// rounded to the 0.1 kW display resolution by `resolveRestoreShortfallKw`.
// Carried by holds whose producer had the admission arithmetic in scope, so the
// device card can state what the device NEEDS instead of naming the house-level
// ceiling (which the hero states once). `null`/absent when the hold is not
// power-blocked — a carry-forward `capacity` fold, or a shed selected this cycle
// before the restore lane evaluated the device.
//
// Pre-rounded on purpose: the stored value then changes only when the DISPLAYED
// number changes, so a kW that jitters every plan cycle cannot churn the
// overview transition signature (see `buildComparableDeviceReason`).
type AdmissionShortfall = { shortfallKw?: number | null };

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
  // Deliberately NOT `AdmissionShortfall` carriers. The admission arithmetic in
  // scope at the swap producers (`lib/plan/swap/candidates.ts`,
  // `lib/plan/restore/swap.ts`, `lib/plan/swap/blocking.ts`) belongs to the
  // device being swapped IN, not to the victim carrying this reason — pinning it
  // here would state another device's number as this one's. A swap victim gets
  // its own figure on the next cycle, when the restore lane evaluates it.
  | { code: typeof PLAN_REASON_CODES.swapPending; targetName: string | null }
  | { code: typeof PLAN_REASON_CODES.swappedOut; targetName: string | null }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget; detail: string | null }
  | ({ code: typeof PLAN_REASON_CODES.dailyBudget; detail: string | null } & AdmissionShortfall)
  | { code: typeof PLAN_REASON_CODES.shortfall; needKw: number | null; headroomKw: number | null }
  | ({ code: typeof PLAN_REASON_CODES.cooldownShedding; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.cooldownRestore; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.meterSettling; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.activationBackoff; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.restorePending; remainingSec: number } & CountdownReasonTiming)
  | ({
    code: typeof PLAN_REASON_CODES.headroomCooldown;
    kind: 'recent_pels_shed' | 'recent_pels_restore' | 'usage_step_down';
    remainingSec: number;
    fromKw: number | null;
    toKw: number | null;
  } & CountdownReasonTiming)
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
  | { code: typeof PLAN_REASON_CODES.deferredObjectiveAvoid; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.awaitingSolarSurplus; detail: string | null }
  | { code: typeof PLAN_REASON_CODES.externalOffHold }
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
  // Also not a carrier, for the same reason as the swap holds above: the gap that
  // would admit this device THROUGH a reservation is dominated by the holder's
  // reserved block, so it states another device's quantity as this one's. The
  // honest line names the holder.
  | { code: typeof PLAN_REASON_CODES.reservedForStart; targetName: string | null }
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
  [PLAN_REASON_CODES.deferredObjectiveAvoid]: 'waiting for cheaper hours',
  [PLAN_REASON_CODES.awaitingSolarSurplus]: 'waiting for solar surplus',
  [PLAN_REASON_CODES.externalOffHold]: 'staying off until turned on again',
  [PLAN_REASON_CODES.neutralStartupHold]: 'left off',
  [PLAN_REASON_CODES.startupStabilization]: 'startup stabilization',
  [PLAN_REASON_CODES.capacityControlOff]: 'capacity control off',
  [PLAN_REASON_CODES.shedInvariant]: 'shed invariant',
  [PLAN_REASON_CODES.reservedForStart]: 'reserved for start',
  [PLAN_REASON_CODES.other]: 'other',
} as const satisfies Record<PlanReasonCode, string>;

export function getPlanReasonLabel(code: PlanReasonCode): string {
  return REASON_LABELS[code];
}
