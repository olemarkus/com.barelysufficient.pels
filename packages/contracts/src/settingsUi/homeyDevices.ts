/**
 * One Homey device as the `homey_devices` route lists it: every device on the
 * Homey, whether or not PELS lists it on Devices. The route backs pickers that
 * must reach beyond PELS's own device list (Advanced's device logger, the
 * Weather insight sensors, the "Missing a device?" picker).
 */
export type HomeyDeviceListEntry = {
  id: string;
  name: string;
  /** Homey's device class; absent when Homey reports none. */
  class?: string;
  /** The device's zone name; `null` when the zone tree has not loaded or does not hold the zone. */
  zoneName: string | null;
  /** Whether the device exposes `measure_temperature`. */
  hasTemperature: boolean;
  /** Whether the device reports power or energy (`measure_power` or `meter_power`). */
  hasPower: boolean;
};
