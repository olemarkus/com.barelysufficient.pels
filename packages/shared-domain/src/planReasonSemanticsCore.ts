export const PLAN_REASON_CODES = {
  none: 'none',
  keep: 'keep',
  restoreNeed: 'restore_need',
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
  restoreThrottled: 'restore_throttled',
  waitingForOtherDevices: 'waiting_for_other_devices',
  insufficientHeadroom: 'insufficient_headroom',
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
} as const;

export type PlanReasonCode = typeof PLAN_REASON_CODES[keyof typeof PLAN_REASON_CODES];

export type CountdownReasonTiming = {
  countdownStartedAtMs?: number;
  countdownTotalSec?: number;
};

// The power that, if it became available, would admit this device — already
// rounded to the 0.1 kW display resolution (`ceilToDisplayKw`). Carried by
// every power-liftable ceiling hold so the device card can state what the
// device NEEDS instead of naming the house-level ceiling (which the hero
// states once). On the carrier codes it is recomputed every plan cycle at
// reason normalization (`finalizeCeilingReason`, `lib/plan/planReasons.ts`)
// from the current per-axis availability — fresh wins over any number a
// producer attached earlier, because carry-forward states would otherwise pin
// a snapshot on the card while the pace moves. `null`/absent when the
// arithmetic declined this cycle (reserve carve-out, admission would pass, the
// exhausted hour, or a gap that rounds to nothing).
//
// Pre-rounded on purpose: the stored value then changes only when the DISPLAYED
// number changes, so a kW that jitters every plan cycle cannot churn the
// overview transition signature (see `buildComparableDeviceReason`).
type AdmissionShortfall = { shortfallKw?: number | null };

// The device whose startup reservation is standing in this device's way, when
// admission declined for THAT reason and no other. Mutually exclusive with
// `shortfallKw` by construction: the reserve carve-out is precisely the branch
// where no gap figure is honest (a gap through the reservation would state the
// holder's quantity as this device's), so `finalizeCeilingReason` attaches one
// or the other, never both.
//
// DISPLAY-ONLY, and the distinction matters. The honest reason CODE here is
// `reservedForStart`, but that code is in `RESTORE_ADMISSION_HOLD_REASON_CODES`
// — it builds no actuation intent. Only the restore/hold lane may switch to it,
// because only that lane knows whether the shed has actually materialized
// (`observedAtShedFloor`, `lib/plan/planReasonsRestoreGating.ts`); swapping it in
// while a floor command is still in flight would stop that command being retried
// while the device keeps drawing inside the reserved block
// (`test/integration/planHeadroomReserve.test.ts`). Reason normalization runs on
// every shed device without that fact, so it carries the holder's NAME beside an
// unchanged, still-actuating ceiling code. The card reads the same sentence
// either way; the executor and the starvation classifier see no change.
type ReserveHolder = { reserveHolderName?: string | null };

// `PLAN_REASON_CODES.none` is deliberately NOT a member: `reason` is a required
// `DeviceReason` on `DevicePlanDevice`, so nothing can fall through to it. The
// constant survives for `ComparablePlanReason`, which uses it as its
// absent-reason marker.
export type DeviceReason =
  | { code: typeof PLAN_REASON_CODES.keep; detail: string | null }
  | {
    code: typeof PLAN_REASON_CODES.restoreNeed;
    fromTarget: string | null;
    toTarget: string | null;
    needKw: number;
    headroomKw: number | null;
  }
  // The swap PRODUCERS (`lib/plan/swap/candidates.ts`, `lib/plan/restore/swap.ts`,
  // `lib/plan/swap/blocking.ts`) must still never pin their own admission numbers
  // here — those belong to the device being swapped IN, and stating them on the
  // victim would present another device's quantity as this one's. The
  // `shortfallKw` these variants carry is attached post hoc at reason
  // normalization (`finalizeCeilingReason`), computed from THIS device's own
  // need against the current pace.
  | ({ code: typeof PLAN_REASON_CODES.swapPending; targetName: string | null } & AdmissionShortfall & ReserveHolder)
  | ({ code: typeof PLAN_REASON_CODES.swappedOut; targetName: string | null } & AdmissionShortfall & ReserveHolder)
  // Never a carrier: the hour's kWh is spent, so no amount of freed power admits
  // the device before the hour rolls over — the card renders time-based copy.
  | { code: typeof PLAN_REASON_CODES.hourlyBudget; detail: string | null }
  | ({ code: typeof PLAN_REASON_CODES.dailyBudget; detail: string | null } & AdmissionShortfall & ReserveHolder)
  | { code: typeof PLAN_REASON_CODES.shortfall; needKw: number | null; headroomKw: number | null }
  | ({ code: typeof PLAN_REASON_CODES.cooldownShedding; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.cooldownRestore; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.meterSettling; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.activationBackoff; remainingSec: number } & CountdownReasonTiming)
  | ({ code: typeof PLAN_REASON_CODES.restorePending; remainingSec: number } & CountdownReasonTiming)
  | { code: typeof PLAN_REASON_CODES.restoreThrottled }
  | { code: typeof PLAN_REASON_CODES.waitingForOtherDevices }
  // Nullable iff a live producer can genuinely omit the field. The admission
  // quartet below is always supplied — `buildRestoreHeadroomReason`
  // (`lib/plan/planReasonStrings.ts`) declares all four as required `number`,
  // and its three call sites (`restore/accounting.ts`, `swap/candidates.ts`,
  // `restore/steppedRestoreAdmission.ts`) each pass a computed figure. The
  // nullable versions existed only to satisfy a prose-reason parser that
  // reconstructed these objects by regex from log text; it was deleted
  // 2026-08-07 (test-only for its whole life), and with it the `headroom
  // unknown` / absent-margin renderings and the fabricate-a-gap-from-`needKw`
  // fallback in `resolveRestoreShortfallKw`. Do not widen them back: a null
  // here means "we could not measure admission", which no producer can say.
  //
  // The remaining four ARE genuinely optional — they describe conditions that
  // may not be in play at all: an activation penalty (`penaltyExtraKw`), and
  // the swap path's reserve/effective figures and target name.
  | {
    code: typeof PLAN_REASON_CODES.insufficientHeadroom;
    needKw: number;
    availableKw: number;
    postReserveMarginKw: number;
    minimumRequiredPostReserveMarginKw: number;
    penaltyExtraKw: number | null;
    swapReserveKw: number | null;
    effectiveAvailableKw: number | null;
    swapTargetName: string | null;
  }
  | { code: typeof PLAN_REASON_CODES.inactive; detail: string | null }
  | ({ code: typeof PLAN_REASON_CODES.capacity; detail: string | null } & AdmissionShortfall & ReserveHolder)
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
  | { code: typeof PLAN_REASON_CODES.reservedForStart; targetName: string | null };

const REASON_LABELS = {
  [PLAN_REASON_CODES.none]: 'unknown',
  [PLAN_REASON_CODES.keep]: 'keep',
  [PLAN_REASON_CODES.restoreNeed]: 'restore',
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
  [PLAN_REASON_CODES.restoreThrottled]: 'restore throttled',
  [PLAN_REASON_CODES.waitingForOtherDevices]: 'waiting for other devices',
  [PLAN_REASON_CODES.insufficientHeadroom]: 'insufficient headroom',
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
} as const satisfies Record<PlanReasonCode, string>;

export function getPlanReasonLabel(code: PlanReasonCode): string {
  return REASON_LABELS[code];
}
