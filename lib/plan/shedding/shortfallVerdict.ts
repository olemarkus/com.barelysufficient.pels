import { isOverShortfallThreshold } from '../../power/capacityGuard';
import type { PlanInputCapacityStateSummary } from '../../power/capacityStateSummary';
import { splitControlledUsageKw } from '../../power/usageAttribution';
import type { MeasuredPower, PlanContext } from '../planContext';
import { countPlanInputDevices } from '../planLogging';
import {
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
} from '../planRemainingSheddableLoad';
import type { PlanEngineState } from '../planState';
import { toUsageDevice } from '../planUsage';
import { buildShedCandidateParams, buildSheddingCandidates } from './candidates';
import type { PlanSheddingResult, ShedCandidate, SheddingDeps } from './types';

/**
 * What one build tells the capacity guard about its reading. Over the hard-cap
 * threshold, the build's verdict: the capacity state it decided from, whose
 * actionable load says whether any shed candidate could still relieve the
 * breach, and whether shed relief already decided is still on its way. At or
 * under it, only the reading.
 *
 * It lives beside selection because the verdict IS a question about selection's
 * candidates. The rebuild throttle once answered it without them, from a rebuild
 * that changed nothing — the planner also changes nothing while it waits out a
 * shed grace — and opened incidents, firing the owner's Flow, with kilowatts
 * still reducible. A separate count of "load on managed devices" fails the other
 * way: it credits devices the candidate walk skips (on/off not writable, a limit
 * that would add demand, no lower step), and holds a genuine incident shut.
 */
export async function reportShortfallToGuard(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  selection: PlanSheddingResult,
  deps: SheddingDeps,
): Promise<void> {
  if (!context.capacityPeriodCoverageComplete) {
    deps.capacityGuard.recordShortfallUnavailable();
    return;
  }
  if (!isOverShortfallThreshold(power.drawKw, deps.shortfallThresholdKw)) {
    await deps.capacityGuard.recordCompletePeriodReading(power.drawKw, deps.shortfallThresholdKw);
    return;
  }
  await deps.capacityGuard.recordPlanVerdict(
    power.drawKw,
    deps.shortfallThresholdKw,
    // Walked only over the threshold, not on every rebuild.
    buildShortfallCapacityStateSummary(context, power, state, selection, deps),
  );
}

function buildShortfallCapacityStateSummary(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  selection: PlanSheddingResult,
  deps: SheddingDeps,
): PlanInputCapacityStateSummary {
  const { devices } = context;
  const { shedSet } = selection;
  // The published split, bounded by the total, so the incident record cannot
  // claim more managed usage than the house drew.
  const { controlledKw, uncontrolledKw } = splitControlledUsageKw({
    devices: devices.map(toUsageDevice),
    totalKw: power.drawKw,
  });
  const remainingReducibleControlledLoadW = roundPowerW(sumRemainingSheddableLoadKw({
    devices: devices.map(toInputRemainingSheddableDevice),
    isAlreadyShed: (device) => shedSet.has(device.id),
    limitSource: state.hourlyBudgetExhausted ? 'daily' : context.softLimitSource,
    capacityBreached: power.capacityBreached,
  }));
  const candidates = walkShedCandidates(context, power, state, deps);
  const remainingActionableControlledLoadW = roundPowerW(
    candidates.reduce((sumKw, candidate) => sumKw + resolveReliefLeftKw(candidate, selection), 0),
  );

  return {
    // Any direction: the incident record counts devices mid-actuation, and a
    // turn-OFF in flight is as much in flight as a turn-ON.
    ...countPlanInputDevices(devices, shedSet, (deviceId) => deps.pendingBinaryCommandStore.hasActiveCommand(deviceId)),
    controlledPowerW: roundPowerW(controlledKw),
    uncontrolledPowerW: roundPowerW(uncontrolledKw),
    remainingReducibleControlledLoadW,
    remainingReducibleControlledLoad: remainingReducibleControlledLoadW > 0,
    remainingActionableControlledLoadW,
    remainingActionableControlledLoad: remainingActionableControlledLoadW > 0,
    // This build chose a shed its commands have not yet delivered, or a
    // candidate's own relief is still unconfirmed (a turn-off, a lower step or a
    // limit PELS sent and the device has not yet reported).
    shedReliefInFlight: selection.outcome.kind === 'shed'
      || candidates.some((candidate) => candidate.unconfirmedRelief),
    summarySource: 'plan_input',
    summarySourceAtMs: Date.now(),
  };
}

/**
 * The candidates selection sheds from. Walked again rather than taken from the
 * selection pass, which does not walk at all while a grace defers the shed —
 * the very cycle the verdict must still get right. Quiet, so the skip roll-up
 * stays the selection's own log line.
 */
function walkShedCandidates(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
): ShedCandidate[] {
  return buildSheddingCandidates({
    ...buildShedCandidateParams(context, power, state, deps),
    deps: { ...deps, debugStructured: undefined },
  }).candidates;
}

/**
 * What a shed candidate can still relieve once selection has chosen. An
 * unchosen candidate keeps all of it. A chosen one keeps only the deeper rungs
 * of its ladder below the one it was parked at: limiting a charger to its
 * middle step leaves the step to off still on the table, and reading that as
 * nothing left would open an incident with an option in hand.
 */
function resolveReliefLeftKw(candidate: ShedCandidate, selection: PlanSheddingResult): number {
  if (!selection.shedSet.has(candidate.id)) return candidate.effectivePower;
  if (candidate.kind !== 'stepped') return 0;
  const parkedAt = selection.shedStepTargets.get(candidate.id);
  const chosenRung = candidate.rungs.find((rung) => rung.toStepId === parkedAt);
  if (chosenRung === undefined) return 0;
  const deepestReliefKw = Math.max(...candidate.rungs.map((rung) => rung.reliefKw));
  return Math.max(0, deepestReliefKw - chosenRung.reliefKw);
}

function roundPowerW(powerKw: number): number {
  return Math.round(Math.max(0, powerKw * 1000));
}
