import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanEngineState } from '../planState';
import type { PlanContext } from '../planContext';

import { isCapacityBreached } from '../planRemainingSheddableLoad';
import { updateGuardState, resolvePlanningTotalPower } from '../admission';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import {
  type PlanSheddingResult,
  type ShedCandidateParams,
  type SheddingDeps,
  type SheddingPlan,
} from './types';
import {
  emitOvershootEscalationBlocked,
  resolveSameMeasurementSheddingDecision,
  buildOvershootStats,
} from './overshoot';
import { resolveShedReason, selectShedDevices } from './selection';
import { buildSheddingCandidates, summarizeSheddingCandidates } from './candidates';

export async function buildSheddingPlan(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable = context.headroom < 0,
): Promise<SheddingPlan> {
  const planningTotal = resolvePlanningTotalPower(context.total, context.powerKnown);
  const {
    shedSet,
    shedReasons,
    updates,
    overshootStats,
  } = planShedding(context, state, deps, overshootActionable);
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  const sheddingActionable = overshootActionable || hourlyBudgetExhausted;
  const sheddingLimitSource = hourlyBudgetExhausted ? 'daily' : context.softLimitSource;
  const wasSheddingActive = deps.capacityGuard?.isSheddingActive() ?? false;
  const guardResult = await updateGuardState({
    headroom: context.headroom,
    powerKnown: context.powerKnown,
    overshootActionable: sheddingActionable,
    capacitySoftLimit: context.capacitySoftLimit,
    total: planningTotal,
    devices: context.devices,
    shedSet,
    softLimitSource: sheddingLimitSource,
    getShedBehavior: deps.getShedBehavior,
    capacityGuard: deps.capacityGuard,
  });
  const guardInShortfall = deps.capacityGuard?.isInShortfall() ?? false;
  const recoveredFromShedding = wasSheddingActive && !guardResult.sheddingActive;
  const mergedUpdates = recoveredFromShedding
    ? { ...updates, lastRecoveryMs: Date.now() }
    : updates;
  return {
    shedSet,
    shedReasons,
    sheddingActive: guardResult.sheddingActive,
    guardInShortfall,
    updates: mergedUpdates,
    overshootStats,
  };
}

function shouldPlanShedding(headroom: number): boolean {
  return headroom < 0;
}

function emptySheddingResult(
  updates: PlanSheddingResult['updates'] = {},
  overshootStats: PlanSheddingResult['overshootStats'] = null,
): PlanSheddingResult {
  return {
    shedSet: new Set<string>(),
    shedReasons: new Map<string, DeviceReason>(),
    updates,
    overshootStats,
  };
}

function planShedding(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable: boolean,
): PlanSheddingResult {
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  if (!shouldAttemptShedding({ hourlyBudgetExhausted, overshootActionable, headroom: context.headroom })) {
    return emptySheddingResult();
  }

  const nowTs = Date.now();
  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementPowerW = resolveMeasurementPowerW(deps.powerTracker);
  const planningTotal = resolvePlanningTotalPower(context.total, context.powerKnown);
  const needed = Math.max(0, -context.headroom);
  const measurementDecision = resolveSameMeasurementSheddingDecision({
    state,
    measurementTs,
    measurementPowerW,
    neededKw: needed,
    nowTs,
    allowEscalation: isCapacityBreached(planningTotal, context.capacitySoftLimit),
  });

  const candidateParams: ShedCandidateParams = {
    devices: context.devices,
    needed: hourlyBudgetExhausted ? Number.POSITIVE_INFINITY : needed,
    limitSource: hourlyBudgetExhausted ? 'daily' : context.softLimitSource,
    total: planningTotal,
    capacitySoftLimit: context.capacitySoftLimit,
    state,
    deps,
  };
  if (shouldSkipSameMeasurement({ hourlyBudgetExhausted, skip: measurementDecision.skip })) {
    return resolveWithheldShedding({
      candidateParams,
      state,
      deps,
      needed,
      limitSource: context.softLimitSource,
      unchangedPowerW: measurementPowerW,
      heldOnUnchangedReading: measurementDecision.heldOnUnchangedReading,
    });
  }
  if (measurementDecision.escalatedSameSample) {
    deps.debugStructured?.({ event: 'plan_shed_escalating_unchanged_measurement' });
  }
  const candidateSummary = buildSheddingCandidates(candidateParams);
  const { candidates } = candidateSummary;
  const overshootStats = buildOvershootStats({
    needed,
    eligibleCandidateCount: candidates.length,
    blockedCandidateCount: candidateSummary.blockedCandidateCount,
    reducibleControlledKw: candidateSummary.reducibleControlledKw,
    blockedReducibleControlledKw: candidateSummary.blockedReducibleControlledKw,
  });
  const result = selectShedDevices({
    candidates,
    needed,
    reason: resolveShedReason(
      hourlyBudgetExhausted ? 'daily' : context.softLimitSource,
      candidateSummary.capacityBreached,
    ),
    debugStructured: deps.debugStructured,
    shedAllCandidates: hourlyBudgetExhausted,
  });

  if (result.shedSet.size === 0) {
    if (measurementDecision.escalatedSameSample) {
      const controllableDeviceCount = context.devices
        .filter((device) => device.controllable !== false)
        .length;
      if (controllableDeviceCount > 0) {
        emitOvershootEscalationBlocked({
          structuredLog: deps.structuredLog,
          capacityGuard: deps.capacityGuard,
          neededKw: needed,
          remainingCandidates: candidates.length,
          measurementTs,
          nowTs,
        });
      }
      return emptySheddingResult({
        lastOvershootEscalationMs: nowTs,
        lastOvershootMitigationMs: nowTs,
      }, overshootStats);
    }
    return emptySheddingResult({}, overshootStats);
  }
  const updates = {
    lastInstabilityMs: nowTs,
    ...(measurementTs !== null ? { lastShedPlanMeasurementTs: measurementTs } : {}),
    // The reading and the decision it produced latch as one pair; the copy is
    // required because `shedSet` is mutated downstream when holds are merged in.
    ...(measurementPowerW !== null
      ? {
        lastShedPlanPowerW: measurementPowerW,
        lastShedPlanShedIds: new Set(result.shedSet),
        lastShedPlanAtMs: nowTs,
        lastShedPlanNeededKw: needed,
      }
      : {}),
    lastOvershootMitigationMs: nowTs,
    ...(measurementDecision.escalatedSameSample ? { lastOvershootEscalationMs: nowTs } : {}),
  };
  return {
    ...result,
    updates,
    overshootStats,
  };
}

/**
 * The tracker's latched watts, finiteness-gated at the read: a junk latch must
 * never become the value a shed decision is held against.
 */
function resolveMeasurementPowerW(powerTracker: SheddingDeps['powerTracker']): number | null {
  return isFiniteNumber(powerTracker.lastPowerW) ? powerTracker.lastPowerW : null;
}

/**
 * Shedding is withheld this cycle: either the measurement is the very one the
 * last shed was planned from, or a later sample re-delivered its watts unchanged.
 */
function resolveWithheldShedding(params: {
  candidateParams: ShedCandidateParams;
  state: PlanEngineState;
  deps: SheddingDeps;
  needed: number;
  limitSource: PlanContext['softLimitSource'];
  unchangedPowerW: number | null;
  heldOnUnchangedReading: boolean;
}): PlanSheddingResult {
  const {
    candidateParams, state, deps, needed, limitSource, unchangedPowerW, heldOnUnchangedReading,
  } = params;
  if (!heldOnUnchangedReading) {
    return skipSheddingAwaitingMeasurement({ candidateParams, deps, needed });
  }
  return holdSheddingAtLastDecision({
    candidateParams, state, deps, needed, limitSource, unchangedPowerW,
  });
}

/**
 * Same-sample skip: this exact measurement already produced a shed, so there is
 * nothing new to act on and no decision to re-derive.
 */
function skipSheddingAwaitingMeasurement(params: {
  candidateParams: ShedCandidateParams;
  deps: SheddingDeps;
  needed: number;
}): PlanSheddingResult {
  const { candidateParams, deps, needed } = params;
  const summary = summarizeSheddingCandidates(candidateParams);
  deps.debugStructured?.({ event: 'plan_shed_skipped_awaiting_measurement' });
  return emptySheddingResult({}, buildOvershootStats({ needed, ...summary }));
}

/**
 * Unchanged-reading hold: re-assert the shed this module already decided on the
 * latched reading, and add nothing new. Returning an empty shed set here would
 * DROP a committed decision rather than freeze it — a home still in dry-run
 * plans a shed it never actuates, so losing it from the plan loses the pending
 * command the activation path force-applies. Narrowing selection to
 * `lastShedPlanShedIds` freezes the decision instead: devices already chosen stay
 * chosen, the deficit that the stale reading still claims buys no additional
 * device. No `updates` are returned — nothing was mitigated this cycle, so the
 * hold window keeps running from the real shed and expires on schedule.
 *
 * "Re-assert" is bounded by candidacy, and deliberately so: a decided device
 * that is now confirmed off is not a candidate (`isEligibleForShedding`) and so
 * leaves the shed set here, exactly as it would on an ordinary cycle. Nothing is
 * lost by that — an off device needs no off command, and whether it stays off is
 * the restore lane's decision. What the hold prevents is the opposite direction:
 * a device the last pass did NOT choose being added on a reading that carries no
 * new evidence.
 */
function holdSheddingAtLastDecision(params: {
  candidateParams: ShedCandidateParams;
  state: PlanEngineState;
  deps: SheddingDeps;
  needed: number;
  limitSource: PlanContext['softLimitSource'];
  unchangedPowerW: number | null;
}): PlanSheddingResult {
  const {
    candidateParams, state, deps, needed, limitSource, unchangedPowerW,
  } = params;
  const candidateSummary = buildSheddingCandidates(candidateParams);
  const alreadyDecided = candidateSummary.candidates
    .filter((candidate) => state.lastShedPlanShedIds.has(candidate.id));
  const { shedSet, shedReasons } = selectShedDevices({
    candidates: alreadyDecided,
    needed,
    reason: resolveShedReason(limitSource, candidateSummary.capacityBreached),
    // Every candidate here is one the last plan already shed, so re-assert the
    // whole set instead of re-deriving it from the deficit.
    shedAllCandidates: true,
  });
  // Its own event, not the awaiting-measurement one: a new measurement DID
  // arrive here and was refused, so log review can count this class directly.
  deps.debugStructured?.({
    event: 'plan_shed_held_unchanged_reading',
    unchangedPowerW,
    reassertedShedDevices: shedSet.size,
  });
  return {
    shedSet,
    shedReasons,
    updates: {},
    overshootStats: buildOvershootStats({
      needed,
      eligibleCandidateCount: candidateSummary.candidates.length,
      blockedCandidateCount: candidateSummary.blockedCandidateCount,
      reducibleControlledKw: candidateSummary.reducibleControlledKw,
      blockedReducibleControlledKw: candidateSummary.blockedReducibleControlledKw,
    }),
  };
}

function shouldAttemptShedding(params: {
  hourlyBudgetExhausted: boolean;
  overshootActionable: boolean;
  headroom: number;
}): boolean {
  return params.hourlyBudgetExhausted
    || (params.overshootActionable && shouldPlanShedding(params.headroom));
}

function shouldSkipSameMeasurement(params: { hourlyBudgetExhausted: boolean; skip: boolean }): boolean {
  return !params.hourlyBudgetExhausted && params.skip;
}
