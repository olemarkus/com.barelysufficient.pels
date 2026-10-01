import type {
  DeviceControlModel,
  ProjectedObservedDeviceState,
  SteppedLoadDecoration,
} from '../../packages/contracts/src/types';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';

/** Runtime device input formed from configuration and an accepted observation. */
export type RuntimeDeviceRead = DeviceConfigurationRead & ProjectedObservedDeviceState;

/** What the device-control decorator (`deviceControlProjection.ts`) adds, and nothing else. */
export type DeviceControlDecoration = SteppedLoadDecoration & {
  controlModel?: DeviceControlModel;
  restorePreparedStepId?: string;
};

/**
 * Planner input as `getPlanInputSnapshot` serves it: the runtime read plus its
 * control decoration. No inventory metadata (class, zone, Flow conflicts): a
 * consumer that needs a fact about the device reads the resolved one on
 * `DeviceConfigurationRead`.
 */
export type PlanInputSnapshotDevice = RuntimeDeviceRead & DeviceControlDecoration;

export const readRuntimeDevice = (
  configuration: DeviceConfigurationRead | undefined,
  observed: ProjectedObservedDeviceState | undefined,
): RuntimeDeviceRead | undefined => {
  if (!configuration || !observed) return undefined;
  const { steppedLoadProfile: _observedProfile, ...state } = observed;
  return { ...state, ...configuration };
};

export const readRuntimeDevices = (
  configurations: readonly DeviceConfigurationRead[],
  getObservedRecord: (deviceId: string) => ProjectedObservedDeviceState | undefined,
): RuntimeDeviceRead[] => configurations.flatMap((configuration) => {
  const device = readRuntimeDevice(configuration, getObservedRecord(configuration.id));
  return device ? [device] : [];
});
