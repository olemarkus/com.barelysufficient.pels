import {
  getSteppedLoadLowestActiveStep, getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { buildPlannedSteppedCommand } from './planSteppedCommand';
import { isRestoreAdmissionHoldReason, isSwapTargetPendingReason } from '../planContract/planDecisionSemantics';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type { DevicePlanDevice, PlanInputDevice, SteppedPlanDevice } from './planTypes';

/** Switch members at the bottom of the ladder once the shared limit has stepped down. */
export function toInstallationSwitch(
  main: DevicePlanDevice, member: PlanInputDevice, measured: boolean,
): boolean | null {
  const watts = member.chargingInstallationLoad?.level?.watts;
  if (!isSteppedLoadDevice(main)) return toSwitchOnlyDecision(main, watts, measured);
  if (main.plannedShedTargetKind === 'binary_off') {
    // The outage pass must finish without another meter sample. The executor
    // attempts the preparation first, then pauses the chargers even if the
    // current command could not be delivered or confirmed.
    if (!measured || watts === undefined) return false;
    const minimum = getSteppedLoadLowestActiveStep(main.steppedLoadProfile);
    return minimum && watts <= minimum.planningPowerW ? false : null;
  }
  if (!measured || main.plannedState !== 'keep' || watts === undefined) return null;
  return readyToResume(main, watts) ? true : null;
}

function toSwitchOnlyDecision(
  main: DevicePlanDevice, watts: number | undefined, measured: boolean,
): boolean | null {
  if (main.plannedShedTargetKind === 'binary_off') return false;
  return measured && main.commandableNow && main.plannedState === 'keep' && (watts ?? 0) > 0
    && !isRestoreAdmissionHoldReason(main.reason) && !isSwapTargetPendingReason(main.reason) ? true : null;
}

function readyToResume(main: SteppedPlanDevice, watts: number): boolean {
  const command = buildPlannedSteppedCommand(main);
  const desired = getSteppedLoadStep(main.steppedLoadProfile, command?.desired.stepId);
  return desired !== null && watts > 0 && watts <= desired.planningPowerW;
}
