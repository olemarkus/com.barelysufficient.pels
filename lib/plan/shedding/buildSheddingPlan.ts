import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { NO_SHEDDING_OUTCOME, type PlanEngineState, type ShedPlanLatch, type SheddingOutcome } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';

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
  type SameMeasurementSheddingDecision,
} from './overshoot';
import { resolveShedReason, selectShedDevices } from './selection';
import { buildShedCandidateParams, buildSheddingCandidates, summarizeSheddingCandidates } from './candidates';
import { resolveSheddingLatch } from './sheddingLatch';
import { reportShortfallToGuard } from './shortfallVerdict';

export async function buildSheddingPlan(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshoot: SheddingOvershootInput,
  nowTs: number = Date.now(),
): Promise<SheddingPlan> {
  const selection = planShedding(context, power, state, deps, overshoot.shedActionable, nowTs);
  const {
    shedSet,
    shedReasons,
    shedStepTargets,
    outcome,
    overshootStats,
  } = selection;
  const wasSheddingActive = state.sheddingActive;
  // Resolved before the guard hears about the reading: its shortfall path
  // awaits a settings write, and the latch must read the hour this build
  // decided on (`PlanBuilder.computeDynamicSoftLimit`).
  const sheddingActive = resolveSheddingLatch(power, state, overshoot, shedSet);
  await reportShortfallToGuard(context, power, state, selection, deps, nowTs);
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  state.sheddingActive = sheddingActive;
  const guardInShortfall = deps.capacityGuard.isInShortfall();
  const recoveredFromShedding = wasSheddingActive && !sheddingActive;
  return {
    shedSet,
    shedReasons,
    shedStepTargets,
    sheddingActive,
    guardInShortfall,
    outcome,
    recoveredAtMs: recoveredFromShedding ? nowTs : null,
    overshootStats,
  };
}

function shouldPlanShedding(headroom: number): boolean {
  return headroom < 0;
}

function emptySheddingResult(
  outcome: SheddingOutcome,
  overshootStats: PlanSheddingResult['overshootStats'],
): PlanSheddingResult {
  return {
    shedSet: new Set<string>(),
    shedReasons: new Map<string, DeviceReason>(),
    shedStepTargets: new Map<string, string>(),
    outcome,
    overshootStats,
  };
}

function planShedding(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable: boolean,
  nowTs: number,
): PlanSheddingResult {
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  if (!shouldAttemptShedding(hourlyBudgetExhausted, overshootActionable, power.headroomKw)) {
    return emptySheddingResult(NO_SHEDDING_OUTCOME, null);
  }

  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementPowerW = resolveMeasurementPowerW(deps.powerTracker);
  const needed = Math.max(0, -power.headroomKw);
  const measurementDecision = resolveSameMeasurementSheddingDecision(
    state, measurementTs, measurementPowerW, needed, nowTs, power.capacityBreached,
  );

  const candidateParams = buildShedCandidateParams(context, power, state, deps);
  // An exhausted hour sheds on every cycle regardless of the sample: the
  // deficit is the whole hour's, not this reading's.
  if (!hourlyBudgetExhausted && measurementDecision.kind !== 'proceed') {
    return resolveWithheldShedding(candidateParams, measurementDecision);
  }
  const escalatedSameSample = measurementDecision.kind === 'proceed' && measurementDecision.escalatedSameSample;
  if (escalatedSameSample) {
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
    if (escalatedSameSample) {
      const controllableDeviceCount = context.devices
        .filter((device) => device.control.commandAuthority)
        .length;
      if (controllableDeviceCount > 0) {
        emitOvershootEscalationBlocked(
          deps.capacityGuard, needed, candidates.length, measurementTs, nowTs, deps.structuredLog,
        );
      }
      return emptySheddingResult({ kind: 'escalation_blocked', atMs: nowTs }, overshootStats);
    }
    return emptySheddingResult(NO_SHEDDING_OUTCOME, overshootStats);
  }
  // The reading and the decision it produced latch as one pair; the copy is
  // required because `shedSet` is mutated downstream when holds are merged in.
  const latch: ShedPlanLatch | null = measurementPowerW === null
    ? null
    : { powerW: measurementPowerW, shedIds: new Set(result.shedSet), atMs: nowTs, neededKw: needed };
  return {
    ...result,
    outcome: { kind: 'shed', atMs: nowTs, measurementTs, latch, escalatedSameSample },
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
 * The two withheld cycles: either the measurement is the very one the last shed
 * was planned from, or a later sample re-delivered its watts unchanged.
 *
 * `candidateParams` is the only input the helpers below need. It already carries
 * `state` and `deps`, and — on every path that reaches here — the same `needed`
 * and `limitSource` the caller used to pass beside it. `ShedCandidateParams`
 * substitutes a severity sentinel for both (`Number.POSITIVE_INFINITY`, and
 * `'daily'`) while the hour is exhausted, but an exhausted hour never withholds,
 * so neither helper is reachable in that state. `deficitKw` on the same object
 * is the measured deficit regardless.
 */
function resolveWithheldShedding(
  candidateParams: ShedCandidateParams,
  decision: Exclude<SameMeasurementSheddingDecision, { kind: 'proceed' }>,
): PlanSheddingResult {
  return decision.kind === 'hold'
    ? holdSheddingAtLastDecision(candidateParams, decision.latch)
    : skipSheddingAwaitingMeasurement(candidateParams);
}

/**
 * Same-sample skip: this exact measurement already produced a shed, so there is
 * nothing new to act on and no decision to re-derive.
 */
function skipSheddingAwaitingMeasurement(candidateParams: ShedCandidateParams): PlanSheddingResult {
  const { deps, deficitKw: needed } = candidateParams;
  const summary = summarizeSheddingCandidates(candidateParams);
  deps.debugStructured?.({ event: 'plan_shed_skipped_awaiting_measurement' });
  return emptySheddingResult(NO_SHEDDING_OUTCOME, buildOvershootStats({ needed, ...summary }));
}

/**
 * Unchanged-reading hold: re-assert the shed this module already decided on the
 * latched reading, and add nothing new. Returning an empty shed set here would
 * DROP a committed decision rather than freeze it — a home still in dry-run
 * plans a shed it never actuates, so losing it from the plan loses the pending
 * command the activation path force-applies. Narrowing selection to
 * the latch's `shedIds` freezes the decision instead: devices already chosen stay
 * chosen, the deficit that the unchanged reading still claims buys no additional
 * device. The outcome is `none` — nothing was mitigated this cycle, so the
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
  latch: ShedPlanLatch,
): PlanSheddingResult {
  // `deficitKw` is the measured deficit on every path; `needed` on the same
  // object is the severity sentinel in an exhausted hour, which cannot reach
  // here (an exhausted hour never withholds).
  const { deps, deficitKw: needed, limitSource } = candidateParams;
  const candidateSummary = buildSheddingCandidates(candidateParams);
  const alreadyDecided = candidateSummary.candidates
    .filter((candidate) => latch.shedIds.has(candidate.id));
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
    unchangedPowerW: latch.powerW,
    reassertedShedDevices: shedSet.size,
  });
  return {
    shedSet,
    shedReasons,
    // Re-priced on this cycle's candidates, like the reasons beside them: the
    // hold freezes WHICH devices stay limited, not the rung each sits at.
    shedStepTargets,
    outcome: NO_SHEDDING_OUTCOME,
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
