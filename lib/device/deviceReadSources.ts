import type { DeviceConfigurationStore } from './deviceConfiguration';
import { createDeviceConfiguration } from './deviceConfiguration';
import type { DeviceReadStore } from './deviceReads';
import { createDeviceReads } from './deviceReads';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { DeviceDescriptorRead, ProjectedObservedDeviceState } from '../../packages/contracts/src/types';

/** Join inventory metadata with accepted Observer records for consumers needing both. */
export const joinObservedDeviceDescriptors = (
  descriptors: readonly DeviceDescriptorRead[],
  getObserved: (deviceId: string) => ProjectedObservedDeviceState | undefined,
): DeviceSurfaces[] => descriptors.flatMap((descriptor) => {
  const observed = getObserved(descriptor.id);
  return observed ? [{ ...observed, ...descriptor }] : [];
});

/** The transport read owners built over the same accepted snapshot. */
export type DeviceReadSource = DeviceReadStore & {
  readonly deviceConfigurationStore: DeviceConfigurationStore;
};

export const createDeviceReadSources = (getStore: () => DeviceReadSource) => ({
  deviceReads: createDeviceReads(getStore),
  deviceConfiguration: createDeviceConfiguration(() => getStore().deviceConfigurationStore),
});
