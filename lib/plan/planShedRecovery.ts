import type { PlanEngineState } from './planState';
import type { PlanInputDevice } from './planTypes';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isStartPolicyHeldDevice } from './shedding/startPolicyHold';

/**
 * A non-stepped device counts as "recovering" when it is currently observed off
 * because we shed (or swapped) it and have not yet restored it: the previous
 * plan still held it shed. Stepped-load devices and uncontrollable devices are
 * excluded.
 *
 * Shared by the stepped-shed resolution paths in `shedding/steppedCandidates.ts`
 * and `planSteppedShedResolution.ts` so the recovery rule has a single definition.
 */
export function isNonSteppedDeviceRecovering(
  candidate: PlanInputDevice,
  state: PlanEngineState,
): boolean {
  // "Observed off" is meaningful only for binary devices; a non-binary or
  // binary-but-on candidate is not recovering. (Stepped devices are excluded
  // above, so the remaining binary devices read `currentOn` directly.)
  if (candidate.control.commandAuthority === false || isSteppedLoadDevice(candidate)
    || !isBinaryPlanDevice(candidate) || candidate.currentOn) {
    return false;
  }
  // Held off by its smart task this hour, or by "Only PELS starts this device": no
  // amount of room brings it back, so no stepped device owes it a rung. It
  // stays in the shed set, so it counts again once the hold ends.
  if (candidate.deferredHoldActive === true || isStartPolicyHeldDevice(candidate)) return false;
  if (state.swapLedger.isDonor(candidate.id) || state.swapLedger.reservationFor(candidate.id) !== undefined) {
    return true;
  }
  return state.shedDecisions.lastPlannedShedIds.has(candidate.id);
}
