import { isOverShortfallThreshold } from '../../power/capacityGuard';
import { applyShortfallPeriodCoverage } from './shortfallAvailability';
import type { PlanInputCapacityStateSummary } from '../../power/capacityStateSummary';
import { splitControlledUsageKwFor } from '../../power/usageAttribution';
import type { MeasuredPower, PlanContext } from '../planContext';
import { countPlanInputDevices } from '../planLogging';
import {
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
} from '../planRemainingSheddableLoad';
import type { PlanEngineState } from '../planState';
import { toMeteredUsageDevices } from '../planUsage';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { buildShedCandidateParams, buildSheddingCandidates } from './candidates';
import { NO_STORAGE_SHED_TERM, type PlanSheddingResult, type ShedCandidate, type SheddingDeps } from './types';
import type { StorageRelief } from '../battery/storageRelief';

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
  /** This cycle's storage stage: the holds a battery's candidate is priced from. */
  storage: StorageRelief,
  lastResortCutId?: string,
): Promise<void> {
  // The capacity axis owns both its pace and shortfall threshold. An off axis
  // has no hard-cap question to ask.
  if (context.capacity.kind === 'off') return;
  const { shortfallThresholdKw } = context.capacity;
  if (!applyShortfallPeriodCoverage(deps.capacityGuard, context.capacityPeriodCoverageComplete)) return;
  // The previous verdict counted relief from the failed dispatch. Its measurement cannot
  // establish that the house still needs those watts after the failure.
  const afterMs = state.relayShedVerdictAfterMs;
  if (afterMs !== undefined
    && (power.sampledAtMs <= afterMs || !state.isNewRelayMeterDecision(power.sampledAtMs))) return;
  if (!isOverShortfallThreshold(power.drawKw, shortfallThresholdKw)) {
    await deps.capacityGuard.recordCompletePeriodReading(power.drawKw, shortfallThresholdKw);
    return;
  }
  await deps.capacityGuard.recordPlanVerdict(
    power.drawKw,
    shortfallThresholdKw,
    // Walked only over the threshold, not on every rebuild.
    buildShortfallCapacityStateSummary(context, power, state, selection, deps, storage, lastResortCutId),
  );
}

function buildShortfallCapacityStateSummary(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  selection: PlanSheddingResult,
  deps: SheddingDeps,
  storage: StorageRelief,
  lastResortCutId: string | undefined,
): PlanInputCapacityStateSummary {
  const { devices } = context;
  const { shedSet } = selection;
  // The published split, bounded by the total, so the incident record cannot
  // claim more managed usage than the house drew.
  const { controlledKw, uncontrolledKw } = splitControlledUsageKwFor({
    devices: toMeteredUsageDevices(devices),
    totalKw: power.drawKw,
  }, (device) => device.control.commandAuthority);
  const bindingSource = context.binding.kind === 'bound' ? context.binding.source : 'none';
  const remainingReducibleControlledLoadW = roundPowerW(sumRemainingSheddableLoadKw(
    // Only a device with a power axis has reducible load to count.
    devices.filter(isMeteredPlanDevice)
      .filter((device) => !device.relayShedNoAck)
      .map(toInputRemainingSheddableDevice),
    (device) => shedSet.has(device.id),
    state.capacityPeriodSpentFor(context) ? 'daily' : bindingSource,
    // Capacity only: the hard-cap incident is a capacity question.
    power.capacityBreached,
  ));
  const candidates = walkShedCandidates(context, power, state, deps, storage);
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
    remainingActionableControlledLoad: remainingActionableControlledLoadW > 0 || devices.some((device) => (
      device.lastResort && device.control.commandAuthority && device.commandableNow && device.currentState === 'on'
      && !state.lastResortShedAttempts.has(device.id)
    )),
    // Over the actual-cap projection a requested temperature target is not
    // electrical relief in flight, even while its command awaits confirmation.
    shedReliefInFlight: lastResortCutId !== undefined || hasElectricalReliefInFlight(selection, candidates)
      || devices.some((device) => device.lastResort && deps.pendingBinaryCommandStore.hasActiveTurnOff(device.id)),
    summarySource: 'plan_input',
    summarySourceAtMs: context.nowTs,
  };
}

function hasElectricalReliefInFlight(selection: PlanSheddingResult, candidates: readonly ShedCandidate[]): boolean {
  if (selection.pendingReliefKw > 0) return true;
  const electrical = candidates.filter((candidate) => candidate.kind !== 'temperature'
    && !(candidate.kind === 'binary' && candidate.relayShedNoAck));
  return electrical.some((candidate) => candidate.unconfirmedRelief)
    || (selection.outcome.kind === 'shed' && (selection.storageSetpoints.size > 0
      || electrical.some((candidate) => selection.shedSet.has(candidate.id))));
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
  storage: StorageRelief,
): ShedCandidate[] {
  return buildSheddingCandidates(
    // The verdict reads the measurement alone: no battery credit or debit. A
    // held battery is still priced from its hold.
    buildShedCandidateParams(context, power, state, deps, { ...storage, shed: NO_STORAGE_SHED_TERM }),
    context.nowTs,
  ).candidates;
}

/**
 * What a shed candidate can still relieve once selection has chosen. An
 * unchosen candidate keeps all of it. A chosen one keeps only the deeper rungs
 * of its ladder below the one it was parked at (a battery, the rest of its
 * discharge below its setpoint): limiting a charger to its
 * middle step leaves the step to off still on the table, and reading that as
 * nothing left would open an incident with an option in hand.
 */
function resolveReliefLeftKw(candidate: ShedCandidate, selection: PlanSheddingResult): number {
  if (candidate.kind === 'temperature' || (candidate.kind === 'binary' && candidate.relayShedNoAck)) return 0;
  if (candidate.kind === 'storage') {
    // A battery chosen keeps the rest of its ladder below the setpoint it was spent at.
    const chosen = selection.storageSetpoints.get(candidate.id);
    if (chosen === undefined) return candidate.effectivePower;
    return Math.max(0, candidate.effectivePower - (candidate.baseW - chosen.setpointW) / 1000);
  }
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
