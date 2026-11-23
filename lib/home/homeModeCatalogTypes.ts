import type { HomeBatteryDevicesRead } from '../ports/homeBatteryDevices';
import type { DeviceControlAdapterSnapshot } from '../../packages/contracts/src/types';
import type { ModePriorityCatalog } from '../../packages/shared-domain/src/settings/modePriorities';

export type HomeModePriorityDevices = {
  readHomeBatteryDevices(): HomeBatteryDevicesRead;
  readDeviceControlAdapter(deviceId: string): DeviceControlAdapterSnapshot | undefined;
};

/** Persisted mode settings that the active mode is resolved against. */
export type HomeModeCatalogConfiguration = {
  aliases: Record<string, string>;
  priorities: Record<string, Record<string, number>>;
  modePriorityCatalog: ModePriorityCatalog;
  targets: Record<string, Record<string, number>>;
};

/** One accepted generation of mode settings for a single home. */
export type HomeModeCatalogSnapshot = HomeModeCatalogConfiguration & { operatingMode: string };

/** Stateless read result for a catalog whose owning bundle may not be live. */
export type PersistedHomeModeCatalogRead =
  | { state: 'resolved'; snapshot: HomeModeCatalogSnapshot }
  | { state: 'legacy' }
  | { state: 'unavailable' };
