import type {
  LifecycleFallbackDevice,
  LifecycleFallbackObservedState,
} from '../lib/executor/lifecycleFallbackDispatcher';
import type {
  DecoratedDeviceSnapshot,
  ProjectedObservedDeviceState,
} from '../packages/contracts/src/types';
import { isCanSetControl } from '../lib/device/deviceActionProjection';
import { getPrimaryTargetCapability } from '../lib/utils/targetCapabilities';

/** Narrow the app-owned decorated carrier before it crosses into the executor. */
export const projectLifecycleFallbackDevice = (
  device: DecoratedDeviceSnapshot,
): LifecycleFallbackDevice => {
  const targetDescriptor = getPrimaryTargetCapability(device.targets);
  return {
    id: device.id,
    name: device.name,
    communicationModel: device.communicationModel,
    controlAdapter: device.controlAdapter,
    selectedStepId: device.selectedStepId,
    stepCommandPending: device.stepCommandPending,
    stepCommandRetryCount: device.stepCommandRetryCount,
    nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
    desiredStepId: device.desiredStepId,
    previousStepId: device.previousStepId,
    stepCommandStatus: device.stepCommandStatus,
    binaryAxis: isCanSetControl(device) && device.controlCapabilityId !== undefined
      ? {
          state: 'writable',
          descriptor: {
            controlCapabilityId: device.controlCapabilityId,
            flowBackedCapabilityIds: device.flowBackedCapabilityIds,
          },
        }
      : { state: 'unavailable' },
    targetAxis: device.temperatureControlDisabled !== true && targetDescriptor
      ? { state: 'writable', descriptor: targetDescriptor }
      : { state: 'unavailable' },
    stepAxis: device.temperatureControlDisabled !== true && device.steppedLoadProfile
      ? { state: 'writable', profile: device.steppedLoadProfile }
      : { state: 'unavailable' },
  };
};

export type LifecycleFallbackCommandState =
  | { state: 'available'; device: LifecycleFallbackDevice; observedState: LifecycleFallbackObservedState }
  | { state: 'unavailable' };

/**
 * App-owned clean projection for lifecycle fallback commandability. Descriptor
 * presence comes from the cached device snapshot while live availability and
 * control state come from the observer projection; no planner snapshot is
 * consulted.
 */
export const projectLifecycleFallbackCommandState = (params: {
  device: LifecycleFallbackDevice | undefined;
  observedState: ProjectedObservedDeviceState | undefined;
}): LifecycleFallbackCommandState => {
  if (!params.device || !params.observedState || params.observedState.available === false) {
    return { state: 'unavailable' };
  }
  return {
    state: 'available',
    device: params.device,
    observedState: params.observedState,
  };
};
