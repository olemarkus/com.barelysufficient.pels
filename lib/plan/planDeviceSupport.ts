import { isTemperaturePlanDevice } from './planTemperatureDevice';

/**
 * What a device without power support (`powerCapable: false`) still gets from
 * the plan, for the settings pass that keeps the owner's choices consistent
 * with it (`disableUnsupportedDevices`, `setup/appDeviceSupport.ts`).
 *
 * A temperature device is price-only: the plan still sets its mode target and
 * price shift, so it keeps Managed and Price and loses only Power-limit
 * control. Any other unsupported device has nothing the plan can do for it and
 * loses all three. This is the temperature arm of `isPlannableDevice`
 * (`planMeteredDevice.ts`) applied to a device that can never have a power
 * axis; the two must agree, which is why both live in the planner.
 */
export type UnsupportedDeviceSupport<T> = {
  /** Every device without power support: Power-limit control is off for all of them. */
  unsupported: T[];
  unsupportedIds: string[];
  /** The unsupported devices the plan cannot act on at all: Managed and Price are off too. */
  fullyUnsupportedIds: string[];
  /** The unsupported temperature devices: Managed and Price stay. */
  priceOnly: T[];
};

export function classifyUnsupportedDevices<T extends { id: string; powerCapable?: boolean; deviceType?: string }>(
  snapshot: readonly T[],
): UnsupportedDeviceSupport<T> {
  const unsupported = snapshot.filter((device) => device.powerCapable === false);
  return {
    unsupported,
    unsupportedIds: unsupported.map((device) => device.id),
    fullyUnsupportedIds: unsupported
      .filter((device) => !isTemperaturePlanDevice(device))
      .map((device) => device.id),
    priceOnly: unsupported.filter((device) => isTemperaturePlanDevice(device)),
  };
}
