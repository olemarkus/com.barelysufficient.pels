import type {
  DeviceControlModel,
  ObservedDeviceState,
  ReportedStepObservedProbe,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  resolveSteppedLoadPlanningPowerKw,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import type { SteppedCommandStore } from '../executor/steppedCommandStore';
import { resolveCurrentOn } from '../observer/observedState';
import { resolveTemperatureDeniedControlModel } from './temperatureControlDenial';
import type { DeviceConfiguration } from '../device/deviceConfiguration';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import { readRuntimeDevice, type DeviceControlDecoration } from './runtimeDeviceRead';
import { projectLifecycleFallbackDevice } from './lifecycleFallbackDeviceProjection';

/**
 * What the decorator reads: the chosen control axis and the accepted step
 * report. Declared as exactly that, not as an inventory snapshot, so planner
 * input (configuration joined with the Observer record, no inventory metadata)
 * passes without claiming fields it does not carry.
 */
export type DeviceControlProjectionSource = Pick<ObservedDeviceState, 'id' | 'binaryControl'>
  & ReportedStepObservedProbe
  & { controlModel?: DeviceControlModel; steppedLoadProfile?: SteppedLoadProfile };


/** Pure composition: the device owner has already chosen the profile and admitted its report. */
export function decorateSnapshotWithDeviceControl<T extends DeviceControlProjectionSource>(
  snapshot: T,
  store: SteppedCommandStore,
  temperatureControlDisabled: boolean,
  temperatureAdjustmentsDisabled: boolean,
): T & DeviceControlDecoration {
  const device = {
    ...snapshot,
    temperatureControlDisabled: temperatureControlDisabled ? true as const : undefined,
    temperatureAdjustmentsDisabled: temperatureAdjustmentsDisabled ? true as const : undefined,
  };
  const profile = device.steppedLoadProfile;
  if (!profile) {
    return { ...device, controlModel: temperatureControlDisabled
      ? resolveTemperatureDeniedControlModel(device.controlModel) : device.controlModel };
  }
  return projectSteppedDeviceControl(device, profile, store);
}

function projectSteppedDeviceControl<T extends DeviceControlProjectionSource>(
  device: T, profile: SteppedLoadProfile, store: SteppedCommandStore,
): T & DeviceControlDecoration {
  const currentDesired = store.getDesired(device.id);
  const targetStepId = getSteppedLoadStep(profile, currentDesired?.stepId)?.id;
  const selectedStepId = device.reportedStepId ?? getSteppedLoadLowestActiveStep(profile)?.id;
  return {
    ...device,
    targetStepId,
    desiredStepId: targetStepId,
    selectedStepId,
    controlModel: 'stepped_load',
    previousStepId: currentDesired?.previousStepId,
    planningPowerKw: resolveSteppedLoadPlanningPowerKw(profile, selectedStepId),
    binaryControl: { on: resolveCurrentOn({
      binaryControl: device.binaryControl,
      steppedLoadProfile: profile,
      selectedStepId,
    }) },
    lastStepCommandIssuedAt: currentDesired?.lastIssuedAtMs,
    stepCommandRetryCount: currentDesired?.retryCount,
    nextStepCommandRetryAtMs: currentDesired?.nextRetryAtMs,
    stepCommandPending: currentDesired?.pending ?? false,
    stepCommandStatus: currentDesired?.status ?? 'idle',
  };
}

export class DeviceControlProjection {
  constructor(
    private readonly store: SteppedCommandStore,
    private readonly configuration: DeviceConfiguration,
    private readonly getObservedRecord: (deviceId: string) => ProjectedObservedDeviceState | undefined,
    private readonly isTemperatureControlDisabled: (deviceId: string) => boolean,
    private readonly allowsTemperatureAdjustments: (deviceId: string) => boolean,
  ) {}

  getLifecycleFallbackDevice(deviceId: string) {
    const device = readRuntimeDevice(this.configuration.get(deviceId), this.getObservedRecord(deviceId));
    if (!device) return undefined;
    return projectLifecycleFallbackDevice(decorateSnapshotWithDeviceControl(device, this.store,
      this.isTemperatureControlDisabled(deviceId), !this.allowsTemperatureAdjustments(deviceId)));
  }

  decorateTargetSnapshotList<T extends DeviceControlProjectionSource>(devices: T[]): (T & DeviceControlDecoration)[] {
    return devices.map((device) => decorateSnapshotWithDeviceControl(
      device, this.store, this.isTemperatureControlDisabled(device.id),
      !this.allowsTemperatureAdjustments(device.id),
    ));
  }
}
