import type { DevicePlanDevice, MeteredKind, SteppedPlanDevice } from '../planTypes';
import { isReserveAdmitted, resolveReserveAdmission, resolveActivationRestoreBlock } from '../admission';
import { countFairnessLimitedDevices } from './coordination';
import { canAdmitWithinBatch, recordBatchAdmission } from './batch';
import type { RestoreCycle, RestoreLoopState } from './types';
import { chargingPhaseAdmissionDebit } from '../chargingPhasePlanning';
import type { ChargingPhasePlanningCycle } from '../chargingPhasePlanning';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { isOffSteppedRestoreCandidate, type RestoreCandidate } from './devices';
import { applySteppedDeviceGates } from './steppedRestoreGates';
import { hasUnreleasedSwapDonors } from './swap';
import { setRestorePlanDevice } from './planDeviceUpdates';

/** A qualified-but-not-issued phase start must earn the same ranked turn on every meter cycle. */
export function withChargingPhaseOffCandidates(
  devices: readonly DevicePlanDevice[], ordinary: RestoreCandidate[], phases: ChargingPhasePlanningCycle,
): RestoreCandidate[] {
  const included = new Set(ordinary.map((candidate) => candidate.device.id));
  const extra = devices.filter((device): device is SteppedPlanDevice & MeteredKind => (
    !included.has(device.id) && phases.hasCandidate(device.id)
    && isSteppedLoadDevice(device) && isMeteredPlanDevice(device) && isOffSteppedRestoreCandidate(device)
  ));
  return [...ordinary, ...extra.map((device) => ({ kind: 'charging_phase' as const, device }))];
}

/** A kept charger which idles may qualify a phase operation without becoming a new ordinary start. */
export function planKeptChargingPhase(
  cycle: RestoreCycle, device: SteppedPlanDevice & MeteredKind, loop: RestoreLoopState,
): RestoreLoopState {
  if (!isOffSteppedRestoreCandidate(device)) return loop;
  if (hasUnreleasedSwapDonors(cycle.swapLedger, device.id, cycle.deviceMap)) return loop;
  const target = cycle.swapLedger.blockingTarget(device, cycle.deviceMap);
  if (target !== undefined && cycle.swapLedger.donorRelease(device.id) !== undefined) return loop;
  if (applySteppedDeviceGates(cycle, device, loop, false, null, 'preserve_kept')) return loop;
  if (resolveActivationRestoreBlock(cycle.state, device.id, cycle.timing.nowTs) !== null) return loop;
  return tryPlanChargingPhaseRestore(cycle, device, loop) ?? loop;
}

function hasPhaseRestoreOffer(device: SteppedPlanDevice, phases: ChargingPhasePlanningCycle): boolean {
  if (!phases.hasCandidate(device.id)) return false;
  return !device.surplusTracking || device.boostActive || phases.hasSolarOffer(device.id);
}

/** A physical phase alternative shares the ordinary restore gates and priority turn. */
export function tryPlanChargingPhaseRestore(
  cycle: RestoreCycle, device: SteppedPlanDevice & MeteredKind, loop: RestoreLoopState,
): RestoreLoopState | undefined {
  const phases = cycle.state.chargingPhaseCycle;
  if (!hasPhaseRestoreOffer(device, phases)) return undefined;
  const chosen = phases.chooseRestore(device.id, device.budgetExempt);
  if (!chosen) return undefined;
  const neededKw = chargingPhaseAdmissionDebit(chosen.debit).totalKw;
  // A 1p→3p operation can add nothing on the old single phase. Its old-footprint scalar
  // must not reject room which the independently checked incoming vector actually fits.
  const admitted = resolveReserveAdmission(
    device, phases.aggregateRoom(device.id, device.budgetExempt), neededKw, cycle.headroomReserves,
  );
  const fairnessBlocked = neededKw > 0
    && !device.boostActive && countFairnessLimitedDevices(cycle.deviceMap, device, cycle.state.shedDecisions) > 0;
  const batchBlocked = loop.restoredOneThisCycle && (!cycle.batchState.enabled
    || !canAdmitWithinBatch(cycle.batchState, neededKw));
  if (!isReserveAdmitted(admitted) || fairnessBlocked || batchBlocked) {
    phases.decline(device.id);
    return undefined;
  }
  applyAdmittedPhaseFloor(cycle, device, chosen.decision.target.currentA);
  recordBatchAdmission(cycle.batchState, neededKw);
  cycle.restoredThisCycle.add(device.id);
  // The candidate-loop commits the typed vector, not a scalar on the old footprint.
  return { ...loop, restoredOneThisCycle: true };
}

function applyAdmittedPhaseFloor(
  cycle: RestoreCycle, device: SteppedPlanDevice & MeteredKind, currentA: number,
): void {
  const step = device.steppedLoadProfile.steps.find((entry) => entry.planningCurrentA === currentA);
  if (!step) return;
  setRestorePlanDevice(cycle.deviceMap, device.id, { desiredStepId: step.id });
  if (!device.surplusTracking) return;
  const state = cycle.state;
  // eslint-disable-next-line functional/immutable-data -- The restore cycle owns its admitted solar ceiling.
  state.surplusTrackingByDevice[device.id] = { kind: 'rung', stepId: step.id, funded: false };
}
