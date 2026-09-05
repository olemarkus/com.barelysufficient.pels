import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanEngineState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';

import { updateGuardState } from '../admission';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import {
  type PlanSheddingResult,
  type ShedCandidateParams,
  type SheddingDeps,
  type SheddingOvershootInput,
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
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshoot: SheddingOvershootInput = {
    actionable: power.headroomKw < 0,
    shedActionable: power.headroomKw < 0,
  },
): Promise<SheddingPlan> {
  const {
    shedSet,
    shedReasons,
    shedStepTargets,
    updates,
    overshootStats,
  } = planShedding(context, power, state, deps, overshoot.shedActionable);
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  // `actionable`, not `shedActionable`: the latch answers "is the house in an
  // overshoot", which a deferred shed does not change. See
  // `SheddingOvershootInput` for what tying it to the shed choice cost.
  const sheddingActionable = overshoot.actionable || hourlyBudgetExhausted;
  const sheddingLimitSource = hourlyBudgetExhausted ? 'daily' : context.softLimitSource;
  const wasSheddingActive = state.sheddingActive;
  const guardResult = await updateGuardState({
    headroom: power.headroomKw,
    drawKw: power.drawKw,
    capacityBreached: power.capacityBreached,
    overshootActionable: sheddingActionable,
    devices: context.devices,
    shedSet,
    softLimitSource: sheddingLimitSource,
    capacityGuard: deps.capacityGuard,
    shortfallThresholdKw: deps.shortfallThresholdKw,
    sheddingActive: wasSheddingActive,
    hourlyBudgetExhausted,
    // Any direction: the shortfall log counts devices mid-actuation, and a
    // turn-OFF in flight is as much in flight as a turn-ON. Kept a callback
    // rather than a prebuilt id set so the `deficitKw <= 0` early return still
    // spares every ordinary rebuild the device walk.
    isBinaryCommandPending: (deviceId) => deps.pendingBinaryCommandStore.hasActiveCommand(deviceId),
  });
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  state.sheddingActive = guardResult.sheddingActive;
  const guardInShortfall = deps.capacityGuard.isInShortfall() ?? false;
  const recoveredFromShedding = wasSheddingActive && !guardResult.sheddingActive;
  const mergedUpdates = recoveredFromShedding
    ? { ...updates, lastRecoveryMs: Date.now() }
    : updates;
  return {
    shedSet,
    shedReasons,
    shedStepTargets,
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
    shedStepTargets: new Map<string, string>(),
    updates,
    overshootStats,
  };
}

function planShedding(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable: boolean,
): PlanSheddingResult {
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  if (!shouldAttemptShedding(hourlyBudgetExhausted, overshootActionable, power.headroomKw)) {
    return emptySheddingResult();
  }

  const nowTs = Date.now();
  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementPowerW = resolveMeasurementPowerW(deps.powerTracker);
  const needed = Math.max(0, -power.headroomKw);
  const measurementDecision = resolveSameMeasurementSheddingDecision(
    state, measurementTs, measurementPowerW, needed, nowTs, power.capacityBreached,
  );

  const candidateParams: ShedCandidateParams = {
    devices: context.devices,
    needed: hourlyBudgetExhausted ? Number.POSITIVE_INFINITY : needed,
    // The measured deficit, never the severity sentinel: rung sizing compares
    // kW against it. See `ShedCandidateParams`.
    deficitKw: needed,
    limitSource: hourlyBudgetExhausted ? 'daily' : context.softLimitSource,
    // Resolved once on the measurement; no candidate walk re-derives it from a total.
    capacityBreached: power.capacityBreached,
    state,
    deps,
  };
  if (shouldSkipSameMeasurement(hourlyBudgetExhausted, measurementDecision.skip)) {
    return resolveWithheldShedding(
      candidateParams,
      measurementPowerW,
      measurementDecision.heldOnUnchangedReading,
    );
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
    skippedCandidateCount: candidateSummary.skippedCandidateCount,
    skippedCandidateReasons: candidateSummary.skippedCandidateReasons,
  });
  const result = selectShedDevices(
    candidates,
    needed,
    // The flag short-circuits inside `resolveShedReason`, so the limit source
    // is passed plain — the old `exhausted ? 'daily' : …` alias only fed the
    // pre-2026-08 reason mapping.
    resolveShedReason(
      context.softLimitSource,
      candidateSummary.capacityBreached,
      hourlyBudgetExhausted,
    ),
    hourlyBudgetExhausted,
    deps.debugStructured,
  );

  if (result.shedSet.size === 0) {
    if (measurementDecision.escalatedSameSample) {
      const controllableDeviceCount = context.devices
        .filter((device) => device.controllable)
        .length;
      if (controllableDeviceCount > 0) {
        emitOvershootEscalationBlocked(
          deps.capacityGuard, needed, candidates.length, measurementTs, nowTs, deps.structuredLog,
        );
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
 *
 * `candidateParams` is the only input the helpers below need. It already carries
 * `state` and `deps`, and — on every path that reaches here — the same `needed`
 * and `limitSource` the caller used to pass beside it. `ShedCandidateParams`
 * substitutes a severity sentinel for both (`Number.POSITIVE_INFINITY`, and
 * `'daily'`) while the hour is exhausted, but `shouldSkipSameMeasurement` is
 * `!hourlyBudgetExhausted && skip`, so this whole withheld path is unreachable
 * in that state. `deficitKw` on the same object is the measured deficit
 * regardless.
 */
function resolveWithheldShedding(
  candidateParams: ShedCandidateParams,
  unchangedPowerW: number | null,
  heldOnUnchangedReading: boolean,
): PlanSheddingResult {
  if (!heldOnUnchangedReading) return skipSheddingAwaitingMeasurement(candidateParams);
  return holdSheddingAtLastDecision(candidateParams, unchangedPowerW);
}

/**
 * Same-sample skip: this exact measurement already produced a shed, so there is
 * nothing new to act on and no decision to re-derive.
 */
function skipSheddingAwaitingMeasurement(candidateParams: ShedCandidateParams): PlanSheddingResult {
  const { deps, deficitKw: needed } = candidateParams;
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
 * chosen, the deficit that the unchanged reading still claims buys no additional
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
function holdSheddingAtLastDecision(
  candidateParams: ShedCandidateParams,
  unchangedPowerW: number | null,
): PlanSheddingResult {
  // `deficitKw` is the measured deficit on every path; `needed` on the same
  // object is the severity sentinel in an exhausted hour, which cannot reach
  // here (see `resolveWithheldShedding`).
  const { state, deps, deficitKw: needed, limitSource } = candidateParams;
  const candidateSummary = buildSheddingCandidates(candidateParams);
  const alreadyDecided = candidateSummary.candidates
    .filter((candidate) => state.lastShedPlanShedIds.has(candidate.id));
  const { shedSet, shedReasons, shedStepTargets } = selectShedDevices(
    alreadyDecided,
    needed,
    resolveShedReason(limitSource, candidateSummary.capacityBreached),
    // Every candidate here is one the last plan already shed, so re-assert the
    // whole set instead of re-deriving it from the deficit.
    true,
  );
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
    // Re-priced on this cycle's candidates, like the reasons beside them: the
    // hold freezes WHICH devices stay limited, not the rung each sits at.
    shedStepTargets,
    updates: {},
    overshootStats: buildOvershootStats({
      needed,
      eligibleCandidateCount: candidateSummary.candidates.length,
      blockedCandidateCount: candidateSummary.blockedCandidateCount,
      reducibleControlledKw: candidateSummary.reducibleControlledKw,
      blockedReducibleControlledKw: candidateSummary.blockedReducibleControlledKw,
      skippedCandidateCount: candidateSummary.skippedCandidateCount,
      skippedCandidateReasons: candidateSummary.skippedCandidateReasons,
    }),
  };
}

function shouldAttemptShedding(
  hourlyBudgetExhausted: boolean,
  overshootActionable: boolean,
  headroom: number,
): boolean {
  return hourlyBudgetExhausted || (overshootActionable && shouldPlanShedding(headroom));
}

function shouldSkipSameMeasurement(hourlyBudgetExhausted: boolean, skip: boolean): boolean {
  return !hourlyBudgetExhausted && skip;
}
