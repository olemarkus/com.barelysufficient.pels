import type { DeviceOverviewSteppedLoad } from '../../packages/shared-domain/src/deviceOverview';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { DeviceExecutionState } from '../../packages/contracts/src/deviceStatus';
import { getSteppedLoadHighestStep, getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type { DevicePlanDevice } from './planTypes';

// Where the device actually is, for when the desired step is not on the ladder shown.
function resolveObservedStepId(profile: SteppedLoadProfile, observedStepId: string | null): string | null {
  return getSteppedLoadStep(profile, observedStepId)?.id
    ?? getSteppedLoadHighestStep(profile)?.id
    ?? null;
}

/**
 * Internal presentation input: the plan owns the ladder and planning power;
 * execution supplies reported position, desired position, and pending work.
 * Missing step feedback stays absent. No planning fallback becomes evidence.
 * UI and logs receive only the complete status built from this input.
 *
 * A desired step that is not on the confirmed ladder is planner-only intent: an
 * EV probe asks for the rung above it, or the ladder was trimmed under it. The
 * card shows where the device is and no movement it cannot place on its rail.
 */
export function buildOverviewSteppedLoad(
  device: DevicePlanDevice,
  execution: DeviceExecutionState,
  confirmedProfile?: SteppedLoadProfile,
): DeviceOverviewSteppedLoad | undefined {
  if (!isSteppedLoadDevice(device)) return undefined;
  const profile = confirmedProfile ?? device.steppedLoadProfile;
  const plannerOnlyTarget = execution.desiredStepId !== null
    && getSteppedLoadStep(profile, execution.desiredStepId) === null;
  return {
    profile,
    reportedStepId: execution.observedStepId,
    targetStepId: plannerOnlyTarget
      ? resolveObservedStepId(profile, execution.observedStepId)
      : execution.desiredStepId,
    selectedStepId: device.selectedStepId,
    planningPowerKw: device.planningPowerKw,
    commandPending: !plannerOnlyTarget && execution.steppedTransitionPending,
  };
}
