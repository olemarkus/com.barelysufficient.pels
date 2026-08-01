import type { DevicePlanDevice } from './planTypes';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { computeBaseRestoreNeed } from './restore/accounting';
import {
  classifyPlanReason,
  renderPlanReasonDecision,
  type ClassifiedPlanReason,
  type PlanReasonDecision,
} from './planReasonStrings';
import {
  isBudgetReason,
  isShortfallReason,
  isSwapReason,
  shouldNormalizeReason,
} from './planReasonsShared';

// Public entry point. The shed-temperature hold decision table and the plan
// reason-pair validation live in sibling modules; they are re-exported here so
// importers keep a single `./planReasons` entry point.
export { applyShedTemperatureHold, type ShedHoldParams } from './planReasonsHoldDecisions';
export { finalizePlanDevices, type PlanReasonPairValidationIssue } from './planReasonsValidation';

// The two standing-hold framing inputs `normalizeShedReasons` consumes (the
// smart-task avoid set + the surplus dump-load hold reasons), bundled so the
// builder can thread them as one value.
export type ShedReasonHoldInputs = {
  deferredObjectiveAvoidDeviceIds: ReadonlySet<string>;
  surplusHoldReasonById: ReadonlyMap<string, DeviceReason>;
};

function buildBaseReason(
  dev: DevicePlanDevice,
  shedReasons: Map<string, DeviceReason>,
  softLimitSource: 'capacity' | 'daily' | null,
  capacityBreached: boolean,
  budgetReleasableHeadroomHold: boolean,
): DeviceReason {
  const classifiedReason = classifyPlanReason(dev.reason);
  const keepReason = shouldNormalizeReason(classifiedReason) ? null : classifiedReason.reason;
  const resolved = shedReasons.get(dev.id) ?? keepReason ?? { code: PLAN_REASON_CODES.capacity, detail: null };
  // Shared fold with `normalizeDeviceReason` — the full rationale (carry-forward
  // capacity, budget-bound restore holds, the prod-2026-07-25 breach carve-out)
  // lives on `resolveDailyBindingReattribution`.
  const reattributed = resolveDailyBindingReattribution({
    reasonCode: resolved.code,
    shedReasonFresh: shedReasons.has(dev.id),
    softLimitSource,
    capacityBreached,
    budgetReleasableHeadroomHold,
  });
  return reattributed ?? resolved;
}

function maybeApplyShortfallReason(params: {
  dev: DevicePlanDevice;
  guardInShortfall: boolean;
  currentReason: ClassifiedPlanReason;
  headroomRaw: number;
}): PlanReasonDecision | null {
  const { dev, guardInShortfall, currentReason, headroomRaw } = params;
  if (!guardInShortfall || isSwapReason(currentReason) || isBudgetReason(currentReason)) return null;
  if (currentReason.code === PLAN_REASON_CODES.neutralStartupHold) return null;
  if (isShortfallReason(currentReason)) return null;
  const { needed: estimatedNeed } = computeBaseRestoreNeed(dev);
  return { code: 'shortfall', neededKw: estimatedNeed, headroomKw: headroomRaw };
}

function maybeApplyCooldownReason(params: {
  currentReason: ClassifiedPlanReason;
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
}): PlanReasonDecision | null {
  const {
    currentReason,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
  } = params;
  if (
    inCooldown
    && !activeOvershoot
    && !isSwapReason(currentReason)
    && currentReason.code !== PLAN_REASON_CODES.neutralStartupHold
    // A startup reservation is why this device is not resuming; the shed cooldown is incidental
    // (it fires whenever ANY device was shed in the last 60 s). Same precedent as the surplus
    // hold above — without this the card flips to "will try to resume in Ns" and hides the cause.
    && currentReason.code !== PLAN_REASON_CODES.reservedForStart
  ) {
    return {
      code: 'cooldown_shedding',
      remainingSec: shedCooldownRemainingSec,
      countdownTiming: {
        ...(typeof shedCooldownStartedAtMs === 'number' ? { countdownStartedAtMs: shedCooldownStartedAtMs } : {}),
        ...(typeof shedCooldownTotalSec === 'number' && shedCooldownTotalSec > 0
          ? { countdownTotalSec: shedCooldownTotalSec }
          : {}),
      },
    };
  }
  return null;
}

export function normalizeShedReasons(params: {
  planDevices: DevicePlanDevice[];
  shedReasons: Map<string, DeviceReason>;
  guardInShortfall: boolean;
  headroomRaw: number;
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  // Devices whose active smart task is between planned hours: the current hour
  // was relatively expensive so the load was booked into cheaper hours, or the
  // task has not started yet, or it has already finished. When the device ends up
  // held this cycle, this framing wins over capacity/dailyBudget because it
  // reflects the user's opt-in to the price-aware plan. See
  // `packages/shared-domain/src/planStateLabels.ts` §
  // PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS.
  deferredObjectiveAvoidDeviceIds?: ReadonlySet<string>;
  // Devices held OFF by the standing "Run on solar surplus" dump-load posture
  // this cycle (`resolveSurplusHold`), with the producer-built stable
  // `awaitingSolarSurplus` reason. Adopted like the deferred-avoid framing:
  // it wins over the capacity/dailyBudget default, but never over a fresh
  // shed decision (`shedReasons`) or the richer shortfall/cooldown/swap/
  // hourly-budget reasons.
  surplusHoldReasonById?: ReadonlyMap<string, DeviceReason>;
  // Plan-level binding-constraint signal. When `'daily'`, carry-forward
  // `capacity` reasons re-attribute to `dailyBudget` so the device card label
  // matches the current binding constraint instead of the constraint that was
  // binding when the device was first shed.
  softLimitSource?: 'capacity' | 'daily' | null;
  // True when the draw is over the CAPACITY soft limit, regardless of which limit
  // is binding. Resolved by the producer (`isCapacityBreached`) so consumers never
  // re-derive it; see the re-attribution guards in `resolveDailyBindingReattribution`.
  capacityBreached?: boolean;
  // Producer-resolved on `PlanContext` (see the field doc there): daily pace
  // binding AND fresh power AND capacity not also breached. Gates the
  // `insufficientHeadroom` → `dailyBudget` re-attribution, and is the SAME flat
  // field `planDiagnostics` reads for the starvation counting cause and rescue
  // gating, so the card label and the rescue widget cannot disagree about
  // whether a hold is budget-releasable.
  budgetReleasableHeadroomHold?: boolean;
}): DevicePlanDevice[] {
  const {
    planDevices,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    deferredObjectiveAvoidDeviceIds,
    surplusHoldReasonById,
    softLimitSource = null,
    capacityBreached = false,
    budgetReleasableHeadroomHold = false,
  } = params;

  return planDevices.map((dev) => normalizeDeviceReason({
    dev,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    deferredObjectiveAvoidDeviceIds,
    surplusHoldReasonById,
    softLimitSource,
    capacityBreached,
    budgetReleasableHeadroomHold,
  }));
}

function normalizeDeviceReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, DeviceReason>;
  guardInShortfall: boolean;
  headroomRaw: number;
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  deferredObjectiveAvoidDeviceIds?: ReadonlySet<string>;
  surplusHoldReasonById?: ReadonlyMap<string, DeviceReason>;
  softLimitSource?: 'capacity' | 'daily' | null;
  // True when the draw is over the CAPACITY soft limit, regardless of which limit
  // is binding. Resolved by the producer (`isCapacityBreached`) so consumers never
  // re-derive it; see the re-attribution guards in `resolveDailyBindingReattribution`.
  capacityBreached?: boolean;
  // Producer-resolved flat semantic — see `normalizeShedReasons` param doc.
  budgetReleasableHeadroomHold?: boolean;
}): DevicePlanDevice {
  const {
    dev,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    deferredObjectiveAvoidDeviceIds,
    surplusHoldReasonById,
    softLimitSource = null,
    capacityBreached = false,
    budgetReleasableHeadroomHold = false,
  } = params;

  if (dev.plannedState !== 'shed') return dev;

  const currentReason = classifyPlanReason(dev.reason);
  const baseReason = buildBaseReason(dev, shedReasons, softLimitSource, capacityBreached, budgetReleasableHeadroomHold);

  const shortfallReason = maybeApplyShortfallReason({
    dev,
    guardInShortfall,
    currentReason,
    headroomRaw,
  });
  if (shortfallReason) return { ...dev, reason: renderPlanReasonDecision(shortfallReason) };

  // Surplus-hold framing takes precedence over the plan-wide shed cooldown for a
  // device whose shed IS the standing "Run on solar surplus" posture: the device
  // is held for surplus, not for the cooldown (which is incidental — it fires
  // whenever ANY device was recently shed). This must run BEFORE the cooldown
  // return below, or a surplus-held dump load would show `cooldown_shedding`
  // during the 60 s window — and, worse, the stepped-restore-block invariant
  // (`isSurplusOnlyHoldShed`, keyed on `reason.code === awaitingSolarSurplus`)
  // would then NOT exempt it, so it would wrongly count as capacity pressure and
  // block unrelated stepped restores. `resolveSurplusHoldReasonAdoption` fires
  // ONLY for a genuine surplus hold (device in `surplusHoldReasonById`, no fresh
  // `shedReasons` entry), so a device genuinely in a capacity cooldown still
  // falls through to `cooldown_shedding` below.
  const surplusHoldReason = resolveSurplusHoldReasonAdoption({
    dev, shedReasons, surplusHoldReasonById, currentReason,
  });
  if (surplusHoldReason) return { ...dev, reason: surplusHoldReason };

  const cooldownReason = maybeApplyCooldownReason({
    currentReason,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
  });
  if (cooldownReason) return { ...dev, reason: renderPlanReasonDecision(cooldownReason) };

  // Smart-task framing wins over capacity / dailyBudget framing when both
  // apply: the user opted into the price-aware plan, so "Waiting for cheaper
  // hours" reflects the planner's intent more honestly than naming whichever
  // physical constraint happens to be binding right now. Skipped when the
  // device has a richer hold reason (shortfall above, swap/budget below) —
  // those carry user-actionable information the smart-task framing would
  // hide. Active state-machine reasons (cooldown handled above) similarly
  // pass through.
  if (deferredObjectiveAvoidDeviceIds?.has(dev.id) && shouldAdoptDeferredAvoidFraming(currentReason, baseReason)) {
    return { ...dev, reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid, detail: null } };
  }

  const dailyReattribution = resolveDailyBindingReattribution({
    reasonCode: currentReason.code,
    shedReasonFresh: shedReasons.has(dev.id),
    softLimitSource,
    capacityBreached,
    budgetReleasableHeadroomHold,
  });
  if (dailyReattribution) return { ...dev, reason: dailyReattribution };

  if (shouldNormalizeReason(currentReason)) {
    return { ...dev, reason: baseReason };
  }
  return dev;
}

// Re-attribution to `dailyBudget` while the daily-budget pacing is the binding
// constraint. Shared by `buildBaseReason` (carry-forward path) and
// `normalizeDeviceReason` (explicit-reason path) so the two sites cannot drift —
// the removed inline copies had already needed one guard-mirroring fix each.
// Two shapes:
//
// - Carry-forward `capacity` reasons: a device shed in an earlier cycle (capacity
//   binding) keeps a stale capacity reason after `softLimitSource` flips to daily —
//   without this the card reads "Limited by the hard cap" while the hero safe-pace
//   number is the daily-budget pacing. A fresh-this-cycle `shedReasons` entry is
//   left alone — the shedding selector set it with the already-correct source.
//   Guarded by `!capacityBreached`: `softLimitSource` names the BINDING (lower)
//   limit, not the one the draw has crossed; when total is over the capacity limit
//   too, capacity is the constraint doing the work and the daily budget is not a
//   lever that can help. Prod 2026-07-25: a budget-exempt EV charger — shed only
//   because a real breach overrode its exemption — read "Limited by today's daily
//   budget" next to its own "Always on" chip, with a "Let it run now" release that
//   could not create capacity headroom. The condition is deliberately NOT
//   `budgetExempt`: exemption only blocks daily-budget SHEDDING
//   (`shedding/candidates.ts`); restore admission gates on
//   `min(capacitySoftLimit, dailySoftLimit)` with no exemption carve-out, so an
//   off exempt device genuinely can be held by the daily budget, and saying so is
//   correct.
//
// - `insufficientHeadroom` restore holds: a restore rejected on headroom while the
//   DAILY pace is binding is a budget hold, not a power shortage — `availableKw`
//   was derived from the budget-derived pace, so no amount of freed power changes
//   the decision; only budget pacing (or time) does. Without this fold every
//   budget-bound hold surfaces as `insufficientHeadroom`, the card reads "Waiting
//   to resume — X kW more needed" while nothing else is running (prod 2026-08-01:
//   12 devices, house at 0.6 kW, gaps up to 5.2 kW against a 5.0 kW hard cap), and
//   the hero's "to stay within today's budget" sentence can never fire. Gated on
//   `budgetReleasableHeadroomHold`, the producer-resolved flat semantic on
//   `PlanContext` that `planDiagnostics` also reads, so the card label and the
//   rescue widget agree by construction. The numeric admission detail stays in
//   the `restore_rejected` debug log.
//
// Note on `DEFERRED_RESTORE_BLOCK_REASON_CODES`
// (`lib/planContract/planDecisionSemantics.ts`): `dailyBudget` is absent from that
// set, but the coupling is LATENT today — `buildExecutableReleaseIntent` requires
// `plannedState === 'keep'` before it consults the reason, and every re-attributed
// hold is a shed device, so a smart-task binary_restore cannot lift these holds
// through this fold. Pinned in `test/unit/planDecisionSemantics.test.ts`; if
// budget holds ever ride keep-state devices, revisit that set deliberately.
function resolveDailyBindingReattribution(params: {
  reasonCode: DeviceReason['code'];
  shedReasonFresh: boolean;
  softLimitSource: 'capacity' | 'daily' | null;
  capacityBreached: boolean;
  budgetReleasableHeadroomHold: boolean;
}): DeviceReason | null {
  const { reasonCode, shedReasonFresh, softLimitSource, capacityBreached, budgetReleasableHeadroomHold } = params;
  if (softLimitSource !== 'daily' || capacityBreached) return null;
  const reattribute = (reasonCode === PLAN_REASON_CODES.capacity && !shedReasonFresh)
    || (reasonCode === PLAN_REASON_CODES.insufficientHeadroom && budgetReleasableHeadroomHold);
  return reattribute ? { code: PLAN_REASON_CODES.dailyBudget, detail: null } : null;
}

// Surplus dump-load framing: a device the standing "Run on solar surplus" hold
// kept off this cycle reads "Waiting for solar surplus" instead of the misleading
// capacity/dailyBudget default (its baseline is off by opt-in, not by pressure).
// A device in `surplusHoldReasonById` is DEFINITIONALLY a surplus hold this cycle
// (resolveSurplusHold selected it), so its shed IS the standing posture and the
// surplus framing overrides the incidental transient framings — the plan-wide shed
// cooldown (finding A on #1817), the capacity/dailyBudget carry-forward, and keep.
// Two things still win:
//   - a FRESH shed decision this cycle (`shedReasons` — a genuinely capacity/budget-
//     shed dump load, e.g. one that was running then shed): real pressure the user
//     should see, AND the discriminator the stepped-restore-block invariant relies
//     on (`isSurplusOnlyHoldShed` keys on `reason.code === awaitingSolarSurplus`);
//   - a swap reason (the device is being swapped for a higher-priority load): richer
//     user-actionable info. (Shortfall already returned in the caller before this.)
// The adopted reason is producer-built and stable across cycles (no numbers).
function resolveSurplusHoldReasonAdoption(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, DeviceReason>;
  surplusHoldReasonById?: ReadonlyMap<string, DeviceReason>;
  currentReason: ClassifiedPlanReason;
}): DeviceReason | null {
  const reason = params.surplusHoldReasonById?.get(params.dev.id);
  if (!reason) return null;
  if (params.shedReasons.has(params.dev.id)) return null;
  if (isSwapReason(params.currentReason)) return null;
  return reason;
}

// Only override capacity-shaped reasons with the smart-task framing. Swap,
// shortfall, hourlyBudget, dailyBudget, inactive, and the various
// state-machine reasons (`sheddingActive`, etc.) all carry information the
// `deferredObjectiveAvoid` framing would hide, so we leave them alone.
function shouldAdoptDeferredAvoidFraming(
  currentReason: ClassifiedPlanReason,
  baseReason: DeviceReason,
): boolean {
  if (isSwapReason(currentReason) || isShortfallReason(currentReason)) return false;
  if (currentReason.code === PLAN_REASON_CODES.hourlyBudget) return false;
  if (currentReason.code === PLAN_REASON_CODES.dailyBudget) return true;
  if (currentReason.code === PLAN_REASON_CODES.capacity) return true;
  // Reason will normalize to the base reason this cycle — override when the
  // base is capacity- or dailyBudget-shaped.
  return baseReason.code === PLAN_REASON_CODES.capacity
    || baseReason.code === PLAN_REASON_CODES.dailyBudget;
}
