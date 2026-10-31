import type { DevicePlanDevice, SteppedPlanDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import {
  getSteppedLoadHighestStep,
  getSteppedLoadStep,
  isSteppedLoadStepOff,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { PLAN_REASON_CODES, type PlanReasonCode } from '../../packages/shared-domain/src/planReasonSemantics';

// The reasons a lasting wait to step up carries once the cut and the restore lane's
// countdowns are over: `keep` while the shedding latch stops a step-up from being
// tried, `insufficientHeadroom` once a tried step-up is refused. Every other reason
// keeps its own line: the shed and restore cooldowns, the restore queue and a meter
// settle are transitional, and the remaining holds name a cause other than room.
const STEP_UP_WAIT_REASON_CODES: ReadonlySet<PlanReasonCode> = new Set([
  PLAN_REASON_CODES.keep,
  PLAN_REASON_CODES.insufficientHeadroom,
]);

// Settled where PELS last put it, below its top step: the step it commanded,
// confirmed by the device, with no move planned this cycle. A device its owner left
// at a lower step was not commanded there, and a step-up the plan admits is a move,
// not a wait.
const isSettledBelowTopStep = (device: SteppedPlanDevice): boolean => {
  const commandedStepId = device.lastDesiredStepId;
  if (device.stepCommandPending || commandedStepId === undefined) return false;
  if (device.desiredStepId !== commandedStepId || device.reportedStepId !== commandedStepId) return false;
  const profile = device.steppedLoadProfile;
  const step = getSteppedLoadStep(profile, commandedStepId);
  const highest = getSteppedLoadHighestStep(profile);
  return step !== null && highest !== null && !isSteppedLoadStepOff(step) && step.id !== highest.id;
};

const isHeldBelowTopStep = (device: DevicePlanDevice): boolean => {
  if (!isSteppedLoadDevice(device)) return false;
  // A non-capacity reduction is not a wait for room, a device tracking solar
  // surplus is capped by its surplus ceiling, and the fairness hold states its own
  // rule.
  if (device.nonCapacityHoldShed === true || device.surplusTracking === true) return false;
  if (device.steppedFairnessHold !== undefined) return false;
  if (!device.control.commandAuthority || !device.hasStandingDemand) return false;
  if (device.plannedState !== 'keep' || device.currentState !== 'on') return false;
  return STEP_UP_WAIT_REASON_CODES.has(device.reason.code) && isSettledBelowTopStep(device);
};

/**
 * Stamp the lasting wait to step up on the devices it holds this cycle, from the
 * final plan, after the stepped fairness hold. A running stepped device PELS put
 * below its top step stays there, planned `keep`, until a step-up is admitted:
 * no restore lane owns its reason for long (`keep` while the shedding latch holds,
 * `insufficientHeadroom` once a step-up is refused), and neither reads as a hold.
 * The card reads this instead (`Limited · Low`, `Waiting to increase`) until a
 * step-up is admitted, the device reaches its top step or its demand ends.
 * Presentation only: actuation, fairness, restore admission and starvation keep
 * reading `reason`. Plan devices are rebuilt from input every cycle, so a device
 * no longer held simply carries no stamp.
 */
export function stampSteppedStepUpHolds(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  return planDevices.map((device) => (
    isHeldBelowTopStep(device) ? { ...device, steppedStepUpHold: true } : device
  ));
}
