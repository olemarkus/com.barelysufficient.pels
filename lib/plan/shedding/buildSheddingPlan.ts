import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { NO_SHEDDING_OUTCOME, type PlanEngineState, type SheddingOutcome } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';

import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import {
  type OvershootStats,
  type PlanSheddingResult,
  type ShedCandidateParams,
  type SheddingDeps,
  type SheddingOvershootInput,
  type SheddingPlan,
  type StorageShedTerm,
} from './types';
import {
  emitOvershootEscalationBlocked,
  resolveSameMeasurementSheddingDecision,
  buildOvershootStats,
} from './overshoot';
import {
  candidatesBeyondPendingRelief,
  holdPendingShedDecision,
  latchShedDecision,
  PENDING_RELIEF_EPSILON_KW,
  type PendingShedRelief,
} from './pendingRelief';
import { resolveShedReason, selectShedDevices, type ShedSelection } from './selection';
import {
  buildShedCandidateParams,
  buildSheddingCandidates,
  isExhaustedHourShedding,
  resolveStorageAdjustedDeficitKw,
  summarizeSheddingCandidates,
} from './candidates';
import { resolveSheddingLatch } from './sheddingLatch';
import { reportShortfallToGuard } from './shortfallVerdict';

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export async function buildSheddingPlan(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshoot: SheddingOvershootInput,
  nowTs: number,
  /**
   * What home-battery relief counts against the measured deficit
   * (`lib/plan/battery/storageRelief.ts`). `power` stays the measurement: the
   * shortfall verdict and the latch read it alone.
   */
  storage: StorageShedTerm,
): Promise<SheddingPlan> {
  const selection = planShedding(context, power, state, deps, overshoot.shedActionable, nowTs, storage);
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
  await reportShortfallToGuard(context, power, state, selection, deps);
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
/* eslint-enable functional/immutable-data */

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
    pendingReliefKw: 0,
  };
}

function planShedding(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable: boolean,
  nowTs: number,
  storage: StorageShedTerm,
): PlanSheddingResult {
  const hourlyBudgetExhausted = isExhaustedHourShedding(state, power, storage);
  if (!shouldAttemptShedding(hourlyBudgetExhausted, overshootActionable, power.headroomKw + storage.netCreditKw)) {
    return emptySheddingResult(NO_SHEDDING_OUTCOME, null);
  }

  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementPowerW = resolveMeasurementPowerW(deps.powerTracker);
  const needed = resolveStorageAdjustedDeficitKw(power, storage);
  const measurementDecision = resolveSameMeasurementSheddingDecision(
    state, context.devices, measurementTs, measurementPowerW, nowTs, power.capacityBreached,
  );

  const candidateParams = buildShedCandidateParams(context, power, state, deps, storage);
  // An exhausted hour sheds on every cycle regardless of the sample: the
  // deficit is the whole hour's, not this reading's.
  if (!hourlyBudgetExhausted && measurementDecision.kind === 'skip_same_sample') {
    return skipSheddingAwaitingMeasurement(candidateParams, measurementDecision.pending);
  }
  if (!hourlyBudgetExhausted && measurementDecision.kind === 'credit_pending_relief') {
    return shedBeyondPendingRelief(candidateParams, measurementDecision.pending, measurementTs, nowTs);
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
    // Nothing to shed: any retirement the pending answer found still lands.
    return emptySheddingResult(retainPendingLatch(measurementDecision.pending), overshootStats);
  }
  // The reading and the decision it produced latch as one pair (copied:
  // `shedSet` is mutated downstream when holds are merged in).
  const latch = measurementPowerW === null ? null : latchShedDecision(result, null, measurementPowerW, nowTs);
  return {
    shedSet: result.shedSet,
    shedReasons: result.shedReasons,
    shedStepTargets: result.shedStepTargets,
    outcome: { kind: 'shed', atMs: nowTs, measurementTs, latch, escalatedSameSample },
    overshootStats,
    pendingReliefKw: 0,
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
 * Same-sample skip: this exact measurement already produced a shed, so there is
 * nothing new to act on and no decision to re-derive. A decision still in its
 * window is held where it stands rather than dropped: a rebuild between
 * readings (a settings change, the switch from dry-run to live control) would
 * otherwise lose a shed nothing has countermanded, and with it the command.
 *
 * Unreachable in an exhausted hour (it never withholds), so `needed` here is
 * `deficitKw`, the measured deficit, never the severity sentinel.
 */
function skipSheddingAwaitingMeasurement(
  candidateParams: ShedCandidateParams,
  held: PendingShedRelief | null,
): PlanSheddingResult {
  const { deps, deficitKw: needed, limitSource } = candidateParams;
  if (held === null || held.held.size === 0) {
    const summary = summarizeSheddingCandidates(candidateParams);
    deps.debugStructured?.({ event: 'plan_shed_skipped_awaiting_measurement', heldShedDevices: 0 });
    return emptySheddingResult(retainPendingLatch(held), buildOvershootStats({ needed, ...summary }));
  }
  const candidateSummary = buildSheddingCandidates(candidateParams);
  const decision = holdPendingShedDecision(
    candidateSummary.candidates,
    held,
    resolveShedReason(limitSource, candidateSummary.capacityBreached),
  );
  deps.debugStructured?.({
    event: 'plan_shed_skipped_awaiting_measurement',
    heldShedDevices: decision.shedSet.size,
  });
  return {
    ...decision,
    outcome: retainPendingLatch(held),
    overshootStats: buildCandidateOvershootStats(needed, candidateSummary),
    pendingReliefKw: held.totalKw,
  };
}

/**
 * A new reading that does not yet show relief the last shed counted on
 * (`pendingRelief.ts`). The latched decision is re-asserted where it stands,
 * and only the deficit that relief leaves open is shed anew.
 *
 * Re-asserting rather than returning an empty set matters even when nothing new
 * is shed: dropping a committed decision would lose it — a home still in dry-run
 * plans a shed it never actuates, so losing it from the plan loses the pending
 * command the activation path force-applies.
 *
 * When the credit covers the deficit the outcome is `held`: nothing was
 * mitigated this cycle, so each decision's window keeps running from its real
 * shed and expires on schedule, and only the retirements are committed. When a residual is shed, that is a new decision
 * and it latches with the held decisions carried over on their own stamps, so
 * the next reading is counted against all of them and none is extended.
 *
 * Unreachable in an exhausted hour (it sheds every candidate regardless), so
 * `deficitKw` and `limitSource` here are the measured ones, never the sentinels.
 */
function shedBeyondPendingRelief(
  candidateParams: ShedCandidateParams,
  pending: PendingShedRelief,
  measurementTs: number | null,
  nowTs: number,
): PlanSheddingResult {
  const { deps, deficitKw: needed, limitSource } = candidateParams;
  const candidateSummary = buildSheddingCandidates(candidateParams);
  const { candidates } = candidateSummary;
  const reason = resolveShedReason(limitSource, candidateSummary.capacityBreached);
  const overshootStats = buildCandidateOvershootStats(needed, candidateSummary);
  const held = holdPendingShedDecision(candidates, pending, reason);
  const residualKw = needed - pending.totalKw;
  const creditFields = {
    neededKw: needed,
    pendingReliefKw: pending.totalKw,
    undeliveredReliefKw: pending.undeliveredKw,
    deliveredReliefKw: pending.deliveredKw,
    realisedKw: pending.realisedKw,
    heldShedDevices: held.shedSet.size,
  };
  if (residualKw <= PENDING_RELIEF_EPSILON_KW) {
    deps.debugStructured?.({ event: 'plan_shed_held_pending_relief', ...creditFields });
    return {
      ...held, outcome: retainPendingLatch(pending), overshootStats, pendingReliefKw: pending.totalKw,
    };
  }
  const beyond = selectShedDevices(
    candidatesBeyondPendingRelief(candidates, pending),
    residualKw,
    reason,
    false,
    deps.debugStructured,
  );
  deps.debugStructured?.({
    event: 'plan_shed_beyond_pending_relief',
    ...creditFields,
    residualKw,
    newShedDevices: beyond.shedSet.size,
  });
  const merged = mergeShedDecisions(held, beyond);
  const outcome: SheddingOutcome = beyond.shedSet.size === 0
    ? retainPendingLatch(pending)
    : {
      kind: 'shed',
      atMs: nowTs,
      measurementTs,
      latch: latchShedDecision(beyond, pending, pending.powerW, nowTs),
      escalatedSameSample: false,
    };
  return {
    ...merged, outcome, overshootStats, pendingReliefKw: pending.totalKw,
  };
}

/**
 * A pass that adds nothing still commits the latch as the pending answer left
 * it, so a decision it retired stays retired. Without a pending answer there is
 * nothing to commit.
 */
function retainPendingLatch(pending: PendingShedRelief | null): SheddingOutcome {
  return pending === null ? NO_SHEDDING_OUTCOME : { kind: 'held', latch: pending.retained };
}

/** The overshoot stats of one candidate walk, for the two paths that hold a decision. */
function buildCandidateOvershootStats(
  needed: number,
  candidateSummary: ReturnType<typeof buildSheddingCandidates>,
): OvershootStats {
  return buildOvershootStats({
    needed,
    eligibleCandidateCount: candidateSummary.candidates.length,
    blockedCandidateCount: candidateSummary.blockedCandidateCount,
    reducibleControlledKw: candidateSummary.reducibleControlledKw,
    blockedReducibleControlledKw: candidateSummary.blockedReducibleControlledKw,
    skippedCandidateCount: candidateSummary.skippedCandidateCount,
    skippedCandidateReasons: candidateSummary.skippedCandidateReasons,
  });
}

/**
 * The held decision with this cycle's additions laid over it. A device chosen
 * again goes where the new choice puts it — including no rung at all, for a
 * held stepped device whose next relief is its binary off.
 */
function mergeShedDecisions(
  held: Omit<ShedSelection, 'creditedKw'>,
  beyond: ShedSelection,
): Omit<ShedSelection, 'creditedKw'> {
  const shedSet = new Set([...held.shedSet, ...beyond.shedSet]);
  const shedReasons = new Map([...held.shedReasons, ...beyond.shedReasons]);
  const shedStepTargets = new Map(held.shedStepTargets);
  for (const deviceId of beyond.shedSet) {
    const stepId = beyond.shedStepTargets.get(deviceId);
    if (stepId === undefined) shedStepTargets.delete(deviceId);
    else shedStepTargets.set(deviceId, stepId);
  }
  return { shedSet, shedReasons, shedStepTargets };
}

function shouldAttemptShedding(
  hourlyBudgetExhausted: boolean,
  overshootActionable: boolean,
  headroom: number,
): boolean {
  return hourlyBudgetExhausted || (overshootActionable && shouldPlanShedding(headroom));
}
