import type { DeviceConfigurationStore } from './deviceConfiguration';
import { createDeviceConfiguration } from './deviceConfiguration';
import type { DeviceReadStore } from './deviceReads';
import { createDeviceReads } from './deviceReads';

/** The transport read owners built over the same accepted snapshot. */
export type DeviceReadSource = DeviceReadStore & {
  readonly deviceConfigurationStore: DeviceConfigurationStore;
};

export const createDeviceReadSources = (getStore: () => DeviceReadSource) => ({
  deviceReads: createDeviceReads(getStore),
  deviceConfiguration: createDeviceConfiguration(() => getStore().deviceConfigurationStore),
});
