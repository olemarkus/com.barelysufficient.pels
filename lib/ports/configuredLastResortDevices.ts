/**
 * The device-control owner's configured last-resort relays, read by modules
 * that must not open `last_resort_devices` themselves. `unavailable` means the
 * owner has never accepted a read of the setting, so its empty map is no answer.
 */
export type ConfiguredLastResortDevicesRead =
  | { status: 'resolved'; deviceIds: readonly string[] }
  | { status: 'unavailable' };

/** What the external-off owner reads from the device-control owner. */
export type ConfiguredLastResortDevices = {
  isConfigured: (deviceId: string) => boolean;
  read: () => ConfiguredLastResortDevicesRead;
};
