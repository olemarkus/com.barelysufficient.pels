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
  type StorageSetpoint,
  type StorageShedTerm,
} from './types';
import type { StorageRelief } from '../battery/storageRelief';
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
  resolveExhaustedHourAnswer,
} from './candidates';
import { isDrivableLimitScope } from './storageCandidate';
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
   * This cycle's storage stage (`lib/plan/battery/storageRelief.ts`): what
   * home-battery relief counts against the measured deficit (`shed`), and the
   * holds a battery's candidate is priced from (`levers`). `power` stays the
   * measurement: the shortfall verdict and the latch read it alone.
   */
  storage: StorageRelief,
): Promise<SheddingPlan> {
  const selection = planShedding(context, power, state, deps, overshoot, nowTs, storage);
  const {
    shedSet,
    shedReasons,
    shedStepTargets,
    storageSetpoints,
    outcome,
    overshootStats,
  } = selection;
  const wasSheddingActive = state.sheddingActive;
  // Resolved before the guard hears about the reading: its shortfall path
  // awaits a settings write, and the latch must read the hour this build
  // decided on (`PlanBuilder.computeDynamicSoftLimit`). A battery limited this
  // cycle is something limited, as a shed device is.
  const sheddingActive = resolveSheddingLatch(
    power, state, overshoot, new Set([...shedSet, ...storageSetpoints.keys()]),
  );
  await reportShortfallToGuard(context, power, state, selection, deps, storage);
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  state.sheddingActive = sheddingActive;
  const guardInShortfall = deps.capacityGuard.isInShortfall();
  const recoveredFromShedding = wasSheddingActive && !sheddingActive;
  return {
    shedSet,
    shedReasons,
    shedStepTargets,
    storageSetpoints,
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
    storageSetpoints: new Map<string, StorageSetpoint>(),
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
  overshoot: SheddingOvershootInput,
  nowTs: number,
  storage: StorageRelief,
): PlanSheddingResult {
  const entry = resolveShedEntry(context, power, state, overshoot, storage.shed);
  if (entry.kind === 'none') return emptySheddingResult(NO_SHEDDING_OUTCOME, null);
  const { hourlyBudgetExhausted, shedsEverything, leadingStorageOnly } = entry;

  const candidateParams = buildShedCandidateParams(context, power, state, deps, storage);
  const walked = restrictToLeadingStorage(buildSheddingCandidates(candidateParams), leadingStorageOnly);
  // The grace defers every device: with no battery ranked ahead of them there
  // is nothing to decide, exactly as without a battery.
  if (leadingStorageOnly && walked.candidates.length === 0) return emptySheddingResult(NO_SHEDDING_OUTCOME, null);
  const needed = candidateParams.deficitKw;

  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementPowerW = resolveMeasurementPowerW(deps.powerTracker);
  const measurementDecision = resolveSameMeasurementSheddingDecision(
    state, context.devices, measurementTs, measurementPowerW, nowTs, power.capacityBreached, storage.levers,
  );
  // Shedding every candidate goes on every cycle regardless of the sample: the
  // deficit is the whole hour's, not this reading's. An hour a battery answers
  // in priority order is held to the readings like any deficit.
  if (!shedsEverything && measurementDecision.kind === 'skip_same_sample') {
    return skipSheddingAwaitingMeasurement(candidateParams, walked, measurementDecision.pending, hourlyBudgetExhausted);
  }
  if (!shedsEverything && measurementDecision.kind === 'credit_pending_relief') {
    return shedBeyondPendingRelief(
      candidateParams, walked, measurementDecision.pending, measurementTs, nowTs, hourlyBudgetExhausted,
    );
  }
  const escalatedSameSample = measurementDecision.kind === 'proceed' && measurementDecision.escalatedSameSample;
  if (escalatedSameSample) {
    deps.debugStructured?.({ event: 'plan_shed_escalating_unchanged_measurement' });
  }
  const candidateSummary = walked;
  const { candidates } = candidateSummary;
  const overshootStats = buildCandidateOvershootStats(needed, candidateSummary);
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
    shedsEverything,
    deps.debugStructured,
  );

  if (isEmptySelection(result)) {
    if (!escalatedSameSample) {
      // Nothing to shed: any retirement the pending answer found still lands.
      return emptySheddingResult(retainPendingLatch(measurementDecision.pending), overshootStats);
    }
    return blockEscalation(context, deps, overshootStats, candidates.length, measurementTs, nowTs);
  }
  // The reading and the decision it produced latch as one pair (copied:
  // `shedSet` is mutated downstream when holds are merged in).
  const latch = measurementPowerW === null ? null : latchShedDecision(result, null, measurementPowerW, nowTs);
  return {
    shedSet: result.shedSet,
    shedReasons: result.shedReasons,
    shedStepTargets: result.shedStepTargets,
    storageSetpoints: result.storageSetpoints,
    outcome: { kind: 'shed', atMs: nowTs, measurementTs, latch, escalatedSameSample },
    overshootStats,
    pendingReliefKw: 0,
  };
}

/**
 * Whether this cycle selects at all, and how. An exhausted hour always does:
 * shedding everything, or, with a battery to answer it, down to an import
 * target in priority order. Otherwise only on a deficit, once the shed grace
 * is over. The grace defers a device's shed while the deficit may be a
 * restore PELS itself is driving; limiting a battery ranked ahead of every
 * device costs no comfort, so the grace does not defer that
 * (`leadingStorageOnly`).
 */
function resolveShedEntry(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  overshoot: SheddingOvershootInput,
  storage: StorageShedTerm,
): { kind: 'none' } | {
  kind: 'select'; hourlyBudgetExhausted: boolean; shedsEverything: boolean; leadingStorageOnly: boolean;
} {
  const hour = resolveExhaustedHourAnswer(context.devices, state, power, storage);
  if (hour.kind !== 'not_exhausted') {
    const shedsEverything = hour.kind === 'shed_everything';
    return { kind: 'select', hourlyBudgetExhausted: true, shedsEverything, leadingStorageOnly: false };
  }
  if (!shouldPlanShedding(power.headroomKw + storage.netCreditKw)) return { kind: 'none' };
  if (overshoot.shedActionable) {
    return { kind: 'select', hourlyBudgetExhausted: false, shedsEverything: false, leadingStorageOnly: false };
  }
  const graceLimitsStorage = overshoot.actionable && context.devices.some(isDrivableLimitScope);
  return graceLimitsStorage
    ? { kind: 'select', hourlyBudgetExhausted: false, shedsEverything: false, leadingStorageOnly: true }
    : { kind: 'none' };
}

/**
 * During the shed grace only the batteries ranked ahead of every load may be
 * limited: the ranked candidates up to the first load. Without the grace the
 * walk is the whole ranking.
 */
function restrictToLeadingStorage(
  walked: ReturnType<typeof buildSheddingCandidates>,
  leadingStorageOnly: boolean,
): ReturnType<typeof buildSheddingCandidates> {
  if (!leadingStorageOnly) return walked;
  const firstLoad = walked.candidates.findIndex((candidate) => candidate.kind !== 'storage');
  return { ...walked, candidates: firstLoad === -1 ? walked.candidates : walked.candidates.slice(0, firstLoad) };
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
 * Unreachable in an hour that sheds everything (it never withholds), so
 * `needed` here is `deficitKw`, never the severity sentinel: the measured
 * deficit, or the import a battery answers an exhausted hour down to.
 */
function skipSheddingAwaitingMeasurement(
  candidateParams: ShedCandidateParams,
  candidateSummary: ReturnType<typeof buildSheddingCandidates>,
  held: PendingShedRelief | null,
  hourlyBudgetExhausted: boolean,
): PlanSheddingResult {
  const { deps, deficitKw: needed, limitSource } = candidateParams;
  if (held === null || held.held.size === 0) {
    deps.debugStructured?.({ event: 'plan_shed_skipped_awaiting_measurement', heldShedDevices: 0 });
    return emptySheddingResult(retainPendingLatch(held), buildCandidateOvershootStats(needed, candidateSummary));
  }
  const decision = holdPendingShedDecision(
    candidateSummary.candidates,
    held,
    resolveShedReason(limitSource, candidateSummary.capacityBreached, hourlyBudgetExhausted),
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
 * Unreachable in an hour that sheds everything, so `deficitKw` here is never
 * the sentinel: the measured deficit, or the import a battery answers an
 * exhausted hour down to, from which the pending relief is taken.
 */
function shedBeyondPendingRelief(
  candidateParams: ShedCandidateParams,
  candidateSummary: ReturnType<typeof buildSheddingCandidates>,
  pending: PendingShedRelief,
  measurementTs: number | null,
  nowTs: number,
  hourlyBudgetExhausted: boolean,
): PlanSheddingResult {
  const { deps, deficitKw: needed, limitSource } = candidateParams;
  const { candidates } = candidateSummary;
  const reason = resolveShedReason(limitSource, candidateSummary.capacityBreached, hourlyBudgetExhausted);
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
  const outcome: SheddingOutcome = isEmptySelection(beyond)
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
  const storageSetpoints = new Map([...held.storageSetpoints, ...beyond.storageSetpoints]);
  return { shedSet, shedReasons, shedStepTargets, storageSetpoints };
}

/** An escalation on an unchanged reading that found nothing to shed. */
function blockEscalation(
  context: PlanContext,
  deps: SheddingDeps,
  overshootStats: OvershootStats,
  candidateCount: number,
  measurementTs: number | null,
  nowTs: number,
): PlanSheddingResult {
  if (context.devices.some((device) => device.control.commandAuthority)) {
    emitOvershootEscalationBlocked(
      deps.capacityGuard, overshootStats.needed, candidateCount, measurementTs, nowTs, deps.structuredLog,
    );
  }
  return emptySheddingResult({ kind: 'escalation_blocked', atMs: nowTs }, overshootStats);
}

/** Whether a selection limited nothing: no device shed and no battery limited. */
function isEmptySelection(selection: Pick<ShedSelection, 'shedSet' | 'storageSetpoints'>): boolean {
  return selection.shedSet.size === 0 && selection.storageSetpoints.size === 0;
}

