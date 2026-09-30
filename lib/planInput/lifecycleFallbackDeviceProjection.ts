import type {
  LifecycleFallbackDevice,
  LifecycleFallbackObservedState,
} from '../executor/lifecycleFallbackDispatcher';
import type {
  DecoratedDeviceSnapshot,
  ProjectedObservedDeviceState,
} from '../../packages/contracts/src/types';
import { isCanSetControl } from '../device/deviceActionProjection';
import { getPrimaryTargetCapability } from '../../packages/shared-domain/src/targetCapabilities';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';

/** Narrow the app-owned decorated carrier before it crosses into the executor. */
export const projectLifecycleFallbackDevice = (
  device: DecoratedDeviceSnapshot,
): LifecycleFallbackDevice => {
  const targetDescriptor = getPrimaryTargetCapability(device.targets);
  return {
    id: device.id,
    name: device.name,
    controlAdapter: device.controlAdapter,
    selectedStepId: device.selectedStepId,
    stepCommandPending: device.stepCommandPending,
    stepCommandRetryCount: device.stepCommandRetryCount,
    nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
    desiredStepId: device.desiredStepId,
    previousStepId: device.previousStepId,
    stepCommandStatus: device.stepCommandStatus,
    binaryAxis: isCanSetControl(device)
      ? { state: 'writable' }
      : { state: 'unavailable' },
    targetAxis: device.temperatureControlDisabled !== true && targetDescriptor
      ? { state: 'writable', target: 'temperature' }
      : { state: 'unavailable' },
    // Only `targetAxis` above answers to "Disable temperature control". A
    // ladder is a separate axis and stays writable, so a flagged stepped device
    // can still be trimmed to a lower rung by lifecycle fallback.
    stepAxis: device.steppedLoadProfile
      ? { state: 'writable', profile: device.steppedLoadProfile }
      : { state: 'unavailable' },
  };
};

export type LifecycleFallbackCommandState =
  | { state: 'available'; device: LifecycleFallbackDevice; observedState: LifecycleFallbackObservedState }
  | { state: 'unavailable' };

/**
 * App-owned clean projection for lifecycle fallback commandability. Descriptor
 * presence comes from the cached device snapshot while availability, control
 * state, and the last trusted power reading come from the observer projection;
 * no planner snapshot is consulted.
 */
export const projectLifecycleFallbackCommandState = (
  device: LifecycleFallbackDevice | undefined,
  observedState: ProjectedObservedDeviceState | undefined,
): LifecycleFallbackCommandState => {
  if (
    !device
    || !observedState
    || observedState.available === false
    || !hasObservedMeasuredPower(observedState)
  ) {
    return { state: 'unavailable' };
  }
  return {
    state: 'available',
    device: device,
    observedState: observedState,
  };
};
