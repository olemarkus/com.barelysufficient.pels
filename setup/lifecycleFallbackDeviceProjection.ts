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
