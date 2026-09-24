export type RowSwitchTitles = { managed: string; limit: string; price: string };

// This is a static capability fact (the device has no temperature target), not
// an actionable per-device state the owner can toggle. It is stated once in the
// Devices "Explain" expander rather than repeated under every on/off device row.
const PRICE_TEMPERATURE_ONLY_REASON = 'Price works with temperature devices only.';

// "Turn Managed on first" is the same sentence for every unmanaged device, and
// on a new install that is every row: two grey lines under each of them. It is
// stated once in the Devices "Explain" expander and stays on the disabled
// toggle's own title; turning Managed on is also what turns Limit on.
const LIMIT_NEEDS_MANAGED_REASON = 'Limit requires Managed to be on first.';
const PRICE_NEEDS_MANAGED_REASON = 'Price requires Managed to be on first.';

/** Reasons true of whole classes of rows, said once in the legend rather than per row. */
export const LEGEND_ONLY_REASONS: ReadonlySet<string> = new Set([
  PRICE_TEMPERATURE_ONLY_REASON,
  LIMIT_NEEDS_MANAGED_REASON,
  PRICE_NEEDS_MANAGED_REASON,
]);

/**
 * The one way an owner makes a device limitable, named once so every surface
 * that turns power-limit control away says the same thing. A configured load
 * (`settings.load`) is deliberately NOT offered: it refines the expected-power
 * estimate but is not an eligibility source (`isDevicePowerCapable` in
 * `lib/device/transport/managerParseDevice.ts`), and a hint that named it sent
 * owners to a setting that changed nothing. "Energy used when on" is Homey's
 * own label for the field, as an owner read it off the device's Advanced
 * settings; the Energy section is named too, so the hint still finds the field
 * if Homey words that label differently (it matches `docs/configuration.md`).
 */
export const POWER_READING_REMEDY = 'a power meter, or "Energy used when on" under Energy in the device’s'
  + ' Advanced settings in Homey';

export const DEVICE_POWER_SUPPORT_HINT = 'PELS needs power readings from this device to manage it. '
  + 'Use a power meter or configure "Energy used when on" under Energy in the device’s Advanced settings in Homey. '
  + 'Control starts when readings arrive.';

export type RowDisabledReasons = {
  managed: string | null;
  limit: string | null;
  price: string | null;
};

export type DeviceControlAvailabilityState = {
  supportsManage: boolean;
  nativeWiringRequired: boolean;
  supportsPower: boolean;
  supportsTemperature: boolean;
  isManaged: boolean;
};

export type RowDisabledState = {
  managed: boolean;
  limit: boolean;
  price: boolean;
};

export const getManagedDisabledReason = (
  isLoadingComplete: boolean,
  supportsManage: boolean,
  nativeWiringRequired: boolean,
): string | null => {
  if (!isLoadingComplete) return 'Controls are available after device settings load.';
  if (!supportsManage) return DEVICE_POWER_SUPPORT_HINT;
  if (nativeWiringRequired) return 'Managed requires built-in device control to be enabled in Homey.';
  return null;
};

export const getLimitDisabledReason = (params: {
  isLoadingComplete: boolean;
  supportsPower: boolean;
  isManaged: boolean;
}): string | null => {
  const { isLoadingComplete, supportsPower, isManaged } = params;
  if (!isLoadingComplete) return 'Controls are available after device settings load.';
  if (!supportsPower) return `Limit needs a power reading: ${POWER_READING_REMEDY}.`;
  if (!isManaged) return LIMIT_NEEDS_MANAGED_REASON;
  return null;
};

export const getPriceDisabledReason = (
  isLoadingComplete: boolean,
  manageability: DeviceControlAvailabilityState,
): string | null => {
  if (!isLoadingComplete) return 'Controls are available after device settings load.';
  if (!manageability.supportsTemperature) return PRICE_TEMPERATURE_ONLY_REASON;
  if (!manageability.isManaged) return PRICE_NEEDS_MANAGED_REASON;
  return null;
};

export const getRowDisabledReasons = (params: {
  isLoadingComplete: boolean;
  manageability: DeviceControlAvailabilityState;
  disabled: RowDisabledState;
}): RowDisabledReasons => {
  const { isLoadingComplete, manageability, disabled } = params;
  return {
    managed: disabled.managed
      ? getManagedDisabledReason(
        isLoadingComplete,
        manageability.supportsManage,
        manageability.nativeWiringRequired,
      )
      : null,
    limit: disabled.limit
      ? getLimitDisabledReason({
        isLoadingComplete,
        supportsPower: manageability.supportsPower,
        isManaged: manageability.isManaged,
      })
      : null,
    price: disabled.price
      ? getPriceDisabledReason(isLoadingComplete, manageability)
      : null,
  };
};
