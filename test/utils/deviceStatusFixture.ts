import type { DeviceExecutionState } from '../../packages/contracts/src/deviceStatus';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { isMeteredPlanDevice } from '../../lib/plan/planMeteredDevice';

/** Explicit executor output for tests whose fixture describes a settled observation. */
export function executionStateFixture(device: DevicePlanDevice): DeviceExecutionState {
  let physicalState: DeviceExecutionState['physicalState'] = 'on';
  if (device.currentState === 'off') physicalState = 'off';
  if (device.currentState === 'not_applicable') physicalState = 'not_applicable';
  return {
    available: device.available !== false,
    physicalState,
    observedStepId: isSteppedLoadDevice(device) ? device.reportedStepId ?? null : null,
    ...(isMeteredPlanDevice(device) ? { currentDrawKw: device.currentDrawKw } : {}),
    desiredBinary: device.plannedState === 'keep' && device.currentState !== 'not_applicable' ? 'on' : null,
    desiredStepId: device.desiredStepId ?? null,
    desiredTarget: null,
    binaryProgress: device.binaryCommandPending ? 'pending' : 'settled',
    stepProgress: device.stepCommandPending ? 'pending' : 'settled',
    targetProgress: device.pendingTargetCommand ? 'pending' : 'settled',
    externalOffHeld: false,
  };
}
