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
  | 'cooldown'
  | 'restore'
  | 'restore_throttled'
  | 'activation_backoff'
  | 'reserved_for_start';

export type PlanStarvationPauseReason =
  | 'restore'
  | 'keep'
  | 'inactive'
  | 'deferred_objective_avoid'
  | 'awaiting_solar_surplus';

export type PlanStarvationSuppressionSemantics =
  | { state: 'none'; countingCause: null; pauseReason: null }
  | { state: 'paused'; countingCause: null; pauseReason: PlanStarvationPauseReason }
  | { state: 'counting'; countingCause: PlanStarvationCountingCause; pauseReason: null };

const RESTORE_ADMISSION_HOLD_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.waitingForOtherDevices,
  // Same class: the planner declined to resume this cycle, it did not decide to switch anything
  // off. Listing it here is what makes "a startup reservation issues no writes" structurally true
  // rather than merely true-in-practice — without it the reject path's `plannedState: 'shed'`
  // builds a shed intent that only the executor's already-off precheck swallows.
  PLAN_REASON_CODES.reservedForStart,
]);

// Reasons under which a producer-resolved deferred-objective resume (binary_restore)
// must NOT fire: the capacity planner has independently decided this device should
// stay off this cycle (capacity pressure, cooldowns, restore throttling/pending, the
// shed invariant, startup stabilization, waiting on other devices). The deferred-
// release producer reads this so a smart task claims power only when the planner
// agrees — it never overrides capacity/cooldown.
//
// `dailyBudget` and `hourlyBudget` are deliberately absent, but the coupling is
// LATENT today: `buildExecutableReleaseIntent` requires `plannedState === 'keep'`
// before consulting the reason, and every budget-attributed hold rides a shed
// device, so a smart-task binary_restore cannot lift those holds through this
// set. Pinned in `test/unit/planDecisionSemantics.test.ts`; if budget holds ever
// ride keep-state devices, revisit deliberately.
const DEFERRED_RESTORE_BLOCK_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.shedInvariant,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.waitingForOtherDevices,
  // A "Run on solar surplus" hold is a standing baseline-off posture; a smart-task
  // binary_restore must never lift it (plan-side admittedDeviceIds exclusion means
  // the two should not co-occur — this is the defense-in-depth classifier).
  PLAN_REASON_CODES.awaitingSolarSurplus,
  // "Leave off until turned on again" is an explicit user action, and the spec
  // is that it wins over a smart task: the task reports the deadline risk
  // instead of quietly overriding the off. Without this a deferred binary_restore
  // would lift a hold the user set by hand.
  PLAN_REASON_CODES.externalOffHold,
  // One smart task's binary_restore must not lift another task's startup reservation: the
  // reserving device is higher priority by construction, so resuming here would take exactly
  // the block the reservation exists to protect.
  PLAN_REASON_CODES.reservedForStart,
]);

const STEPPED_KEEP_INVARIANT_RESTORE_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.keep,
  PLAN_REASON_CODES.restoreNeed,
]);

const COOLDOWN_BLOCK_REASON_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.restorePending,
]);

// This table is a PURE reason-code → counting-cause map; it must stay free of planner
// state (`softLimitSource`, headroom axes, …). The source-aware fold that
// re-attributes `insufficient_headroom` → `daily_budget` for a budget-releasable hold
// lives one layer up in the producer (`lib/plan/planDiagnostics.ts`,
// `reattributeHeadroomShortfallCause`, gated on `budgetReleasableHeadroomHold`). Do not
// pull that condition in here — it would break the resolution-in-producer boundary.
//
// Membership follows one rule (`notes/starvation/README.md` — "the clock runs whenever
// PELS is the reason the device is down"): every hold PELS itself imposes counts, and the
// cause names WHICH hold, so device detail can still tell a cooldown from a reservation.
// Cooldowns, retry backoff, restore holds, and startup reservations moved here from the
// pause table on 2026-08-08 — they are PELS keeping the device off, and the owner does not
// experience them as a break in the hold.
const COUNTING_SUPPRESSION_CAUSES: Partial<Record<PlanReasonCode, PlanStarvationCountingCause>> = {
  [PLAN_REASON_CODES.capacity]: 'capacity',
  [PLAN_REASON_CODES.dailyBudget]: 'daily_budget',
  [PLAN_REASON_CODES.hourlyBudget]: 'hourly_budget',
  [PLAN_REASON_CODES.shortfall]: 'shortfall',
  [PLAN_REASON_CODES.swapPending]: 'swap_pending',
  [PLAN_REASON_CODES.swappedOut]: 'swapped_out',
  [PLAN_REASON_CODES.insufficientHeadroom]: 'insufficient_headroom',
  // The three timers PELS runs against itself. They are its own pacing, not a reprieve for
  // the device — it stays off across them.
  [PLAN_REASON_CODES.cooldownShedding]: 'cooldown',
  [PLAN_REASON_CODES.cooldownRestore]: 'cooldown',
  [PLAN_REASON_CODES.meterSettling]: 'cooldown',
  // The planner declined to resume this device this cycle. It is off because PELS says so,
  // whether the queue is busy (`restorePending`) or other devices have not settled yet
  // (`waitingForOtherDevices`). Shares the `restore` name with the pause reason below, which
  // covers the one restore code that lands on a RUNNING device — same word, because the two
  // read identically to a user; the discriminated result keeps them apart in code.
  [PLAN_REASON_CODES.restorePending]: 'restore',
  [PLAN_REASON_CODES.waitingForOtherDevices]: 'restore',
  [PLAN_REASON_CODES.restoreThrottled]: 'restore_throttled',
  [PLAN_REASON_CODES.activationBackoff]: 'activation_backoff',
  // A higher-priority device's startup reservation is holding this one down. The reserve is
  // bounded (`HEADROOM_RESERVE_MAX_MS`) and it issues no write, but the device is still off
  // by PELS's decision — the boundedness is a property of the mechanism, not something the
  // held device feels. See `notes/deferred-load-objectives/preemptive-power-reservation.md`.
  [PLAN_REASON_CODES.reservedForStart]: 'reserved_for_start',
};

// The mirror table: holds that must NOT run the clock. Two classes, and the distinction is
// who turned the device off — never how transient the hold is.
const PAUSE_SUPPRESSION_REASONS: Partial<Record<PlanReasonCode, PlanStarvationPauseReason>> = {
  // (1) PELS has not turned this device off at all.
  //
  // `keep` is the device running normally. `inactive` is unplugged/physically unavailable —
  // not PELS's doing. `restoreNeed` is the odd one: it is a restore code, but it lands on a
  // keep-state device that is ON and merely wants a step up, so it belongs here and not with
  // its `restorePending` siblings above.
  [PLAN_REASON_CODES.keep]: 'keep',
  [PLAN_REASON_CODES.inactive]: 'inactive',
  [PLAN_REASON_CODES.restoreNeed]: 'restore',
  // (2) PELS DID turn it off — at the owner's own explicit request.
  //
  // These are the deliberate carve-out from the rule above. Flagging "Held back" here, and
  // offering "Let it run now", would tell the owner their own setting is a problem, so the
  // clock stays off however long the hold lasts.
  //
  // `deferredObjectiveAvoid`: the device's own smart-task policy is deferring it to a
  // cheaper/reserved hour. `awaitingSolarSurplus`: the opted-in dump-load posture, whose
  // baseline IS off, waiting for export. Both keep an attributed pause reason rather than
  // falling through to the `unknown_suppression_reason` catch-all in planDiagnostics.
  [PLAN_REASON_CODES.deferredObjectiveAvoid]: 'deferred_objective_avoid',
  [PLAN_REASON_CODES.awaitingSolarSurplus]: 'awaiting_solar_surplus',
  // `externalOffHold` is the third member of that carve-out but is deliberately ABSENT: a
  // device the owner turned off outside PELS is excluded from starvation ELIGIBILITY
  // upstream (`resolveEligibleForStarvation`, `lib/plan/planDiagnostics.ts`), which resets
  // any accrual instead of latching a paused episode. It therefore resolves to `none` here,
  // and `test/integration/externalOffHoldPlan.test.ts` pins that.
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

/**
 * Classify one planner reason for the starvation clock — the clock behind the "Held back"
 * badge and the "Let it run now" rescue.
 *
 * The rule (owner ruling, 2026-08-08; design-of-record `notes/starvation/README.md`):
 * **the clock runs whenever PELS has turned the device off.** If PELS is the reason the
 * device is down, the time counts — a cooldown, a retry backoff, a queued restore and a
 * startup reservation are all PELS keeping it off, and none of them is a break in the hold
 * from where the owner stands. If the OWNER or the DEVICE is the reason, the clock pauses.
 *
 * The two tables above hold the whole decision; a reason in neither is `none`. Both are pure
 * reason-code lookups: no planner state, no timing, no device shape.
 */
export function resolveStarvationSuppressionSemantics(reason: DeviceReason): PlanStarvationSuppressionSemantics {
  const pauseReason = PAUSE_SUPPRESSION_REASONS[reason.code];
  if (pauseReason) {
    return { state: 'paused', countingCause: null, pauseReason };
  }
  const countingCause = COUNTING_SUPPRESSION_CAUSES[reason.code];
  if (countingCause) {
    return { state: 'counting', countingCause, pauseReason: null };
  }
  return { state: 'none', countingCause: null, pauseReason: null };
}
