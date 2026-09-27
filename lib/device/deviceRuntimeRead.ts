import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';

/** Runtime device input formed from configuration and an accepted observation. */
export type RuntimeDeviceRead = DeviceConfigurationRead & ProjectedObservedDeviceState;

export const readRuntimeDevice = (
  configuration: DeviceConfigurationRead | undefined,
  observed: ProjectedObservedDeviceState | undefined,
): RuntimeDeviceRead | undefined => (
  configuration && observed ? { ...observed, ...configuration } : undefined
);

export const readRuntimeDevices = (
  configurations: readonly DeviceConfigurationRead[],
  getObservedRecord: (deviceId: string) => ProjectedObservedDeviceState | undefined,
): RuntimeDeviceRead[] => configurations.flatMap((configuration) => {
  const device = readRuntimeDevice(configuration, getObservedRecord(configuration.id));
  return device ? [device] : [];
});
