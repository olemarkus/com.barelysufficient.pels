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
): DeviceReason {
  const classifiedReason = classifyPlanReason(dev.reason);
  const keepReason = shouldNormalizeReason(classifiedReason) ? null : classifiedReason.reason;
  const resolved = shedReasons.get(dev.id) ?? keepReason ?? { code: PLAN_REASON_CODES.capacity, detail: null };
  // Re-attribute a carry-forward `capacity` reason to `dailyBudget` whenever
  // the binding constraint is currently the daily-budget pacing. The shedding
  // selector (`lib/plan/shedding/selection.ts:resolveShedReason`) already does
  // this at shed-time, but devices that were shed in earlier cycles keep their
  // stale `capacity` reason after `softLimitSource` flips to `daily` — without
  // this guard the device-card label reads "Limited by the hard cap" while
  // the hero hovers well under the hard cap and the daily budget is the only
  // constraint actually doing work. The shedReasons map is the fresh-this-
  // cycle decision and is left alone (it was set by the selector with the
  // already-correct source).
  //
  // Only while capacity is not ALSO breached. `softLimitSource` names the
  // BINDING (lower) soft limit, not the one the draw has actually crossed; when
  // total is over the capacity limit too, capacity is the constraint doing the
  // work and the daily budget is not a lever that can help. Prod 2026-07-25: a
  // budget-exempt EV charger — shed only because a real breach (6.60 kW over a
  // 5.12 kW capacity soft limit) overrode its exemption — read "Limited by today's
  // daily budget" next to its own "Always on" chip, and was offered a
  // "Let it run now" release that could not create capacity headroom.
  //
  // The condition is deliberately NOT `budgetExempt`: an exempt device is only
  // immune to daily-budget SHEDDING (`shedding/candidates.ts`). Restore admission
  // gates on `min(capacitySoftLimit, dailySoftLimit)` with no exemption carve-out,
  // and the daily limit adds back only an exempt device's LIVE draw — zero while
  // it is off — so an off exempt device genuinely can be held by the daily budget,
  // and saying so is correct.
  if (
    !shedReasons.has(dev.id)
    && resolved.code === PLAN_REASON_CODES.capacity
    && softLimitSource === 'daily'
    && !capacityBreached
  ) {
    return { code: PLAN_REASON_CODES.dailyBudget, detail: null };
  }
  return resolved;
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
  // re-derive it; see the re-attribution guards in `buildBaseReason`.
  capacityBreached?: boolean;
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
  // re-derive it; see the re-attribution guards in `buildBaseReason`.
  capacityBreached?: boolean;
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
  } = params;

  if (dev.plannedState !== 'shed') return dev;

  const currentReason = classifyPlanReason(dev.reason);
  const baseReason = buildBaseReason(dev, shedReasons, softLimitSource, capacityBreached);

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

  // Carry-forward `capacity` reasons re-attribute to `dailyBudget` whenever
  // the binding constraint is currently the daily-budget pacing. Without
  // this, a device shed in an earlier cycle (capacity binding) keeps a
  // stale capacity reason after softLimitSource flips to daily — the
  // device card then reads "Limited by the hard cap" while the hero
  // safe-pace number is the daily-budget pacing. The fresh-this-cycle
  // entry in `shedReasons` is left alone — the shedding selector set it
  // with the already-correct source.
  if (
    softLimitSource === 'daily'
    && currentReason.code === PLAN_REASON_CODES.capacity
    && !shedReasons.has(dev.id)
    // Same breach carve-out as `buildBaseReason` — without it this sibling path
    // undoes that guard on the very next cycle, once the device drops out of
    // `shedReasons` and is re-labelled while capacity is still breached.
    && !capacityBreached
  ) {
    return { ...dev, reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null } };
  }

  if (shouldNormalizeReason(currentReason)) {
    return { ...dev, reason: baseReason };
  }
  return dev;
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
