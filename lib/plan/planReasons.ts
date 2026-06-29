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

function buildBaseReason(
  dev: DevicePlanDevice,
  shedReasons: Map<string, DeviceReason>,
  softLimitSource: 'capacity' | 'daily' | null,
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
  if (
    !shedReasons.has(dev.id)
    && resolved.code === PLAN_REASON_CODES.capacity
    && softLimitSource === 'daily'
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
  // Plan-level binding-constraint signal. When `'daily'`, carry-forward
  // `capacity` reasons re-attribute to `dailyBudget` so the device card label
  // matches the current binding constraint instead of the constraint that was
  // binding when the device was first shed.
  softLimitSource?: 'capacity' | 'daily' | null;
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
    softLimitSource = null,
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
    softLimitSource,
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
  softLimitSource?: 'capacity' | 'daily' | null;
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
    softLimitSource = null,
  } = params;

  if (dev.plannedState !== 'shed') return dev;

  const currentReason = classifyPlanReason(dev.reason);
  const baseReason = buildBaseReason(dev, shedReasons, softLimitSource);

  const shortfallReason = maybeApplyShortfallReason({
    dev,
    guardInShortfall,
    currentReason,
    headroomRaw,
  });
  if (shortfallReason) return { ...dev, reason: renderPlanReasonDecision(shortfallReason) };

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
  ) {
    return { ...dev, reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null } };
  }

  if (shouldNormalizeReason(currentReason)) {
    return { ...dev, reason: baseReason };
  }
  return dev;
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
