import type { PlanEngineState } from './planState';
import type { PlanInputDevice } from './planTypes';
import { isObservedOff } from '../observer/observedState';
import { isSteppedLoadDevice } from './planSteppedLoad';

/**
 * A non-stepped device counts as "recovering" when it is currently observed off
 * because we shed (or swapped) it and have not yet restored it. Stepped-load
 * devices and uncontrollable devices are excluded.
 *
 * Shared by the stepped-shed resolution paths in `candidates.ts` and
 * `planSteppedShedResolution.ts` so the recovery rule has a single definition.
 */
export function isNonSteppedDeviceRecovering(
  candidate: PlanInputDevice,
  state: Pick<PlanEngineState, 'shedDecidedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>,
): boolean {
  if (candidate.controllable === false || isSteppedLoadDevice(candidate) || !isObservedOff(candidate)) {
    return false;
  }
  if (state.swapByDevice[candidate.id]?.swappedOutFor || state.swapByDevice[candidate.id]?.pendingTarget) {
    return true;
  }
  const shedDecidedMs = state.shedDecidedMs[candidate.id];
  if (shedDecidedMs == null) return false;
  const lastRestoreMs = state.lastDeviceRestoreMs[candidate.id];
  return lastRestoreMs == null || lastRestoreMs < shedDecidedMs;
}
