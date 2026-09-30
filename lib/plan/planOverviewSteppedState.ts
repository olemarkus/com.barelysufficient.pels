import type { DeviceOverviewSteppedLoad } from '../../packages/shared-domain/src/deviceOverview';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { DeviceExecutionState } from '../../packages/contracts/src/deviceStatus';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type { DevicePlanDevice } from './planTypes';

/**
 * Internal presentation input: the plan owns the ladder and planning power;
 * execution supplies reported position, desired position, and pending work.
 * Missing step feedback stays absent. No planning fallback becomes evidence.
 * UI and logs receive only the complete status built from this input.
 */
export function buildOverviewSteppedLoad(
  device: DevicePlanDevice,
  execution: DeviceExecutionState,
  confirmedProfile?: SteppedLoadProfile,
): DeviceOverviewSteppedLoad | undefined {
  if (!isSteppedLoadDevice(device)) return undefined;
  return {
    profile: confirmedProfile ?? device.steppedLoadProfile,
    reportedStepId: execution.observedStepId,
    targetStepId: execution.desiredStepId,
    selectedStepId: device.selectedStepId,
    planningPowerKw: device.planningPowerKw,
    commandPending: execution.steppedTransitionPending,
  };
}
