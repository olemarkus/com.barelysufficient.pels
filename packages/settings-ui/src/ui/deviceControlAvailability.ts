export type RowSwitchTitles = { managed: string; limit: string; price: string };

// This is a static capability fact (the device has no temperature target), not
// an actionable per-device state the owner can toggle. It is stated once in the
// Devices "Explain" expander rather than repeated under every on/off device row.
export const PRICE_TEMPERATURE_ONLY_REASON = 'Price works with temperature devices only.';

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
  if (nativeWiringRequired) return 'Managed requires built-in device control to be enabled in Homey.';
  if (!supportsManage) return 'Managed requires a temperature target or power capability.';
  return null;
};

export const getLimitDisabledReason = (params: {
  isLoadingComplete: boolean;
  supportsPower: boolean;
  isManaged: boolean;
}): string | null => {
  const { isLoadingComplete, supportsPower, isManaged } = params;
  if (!isLoadingComplete) return 'Controls are available after device settings load.';
  if (!supportsPower) return 'Limit requires power measurement or a configured load.';
  if (!isManaged) return 'Limit requires Managed to be on first.';
  return null;
};

export const getPriceDisabledReason = (params: {
  isLoadingComplete: boolean;
  supportsTemperature: boolean;
  isManaged: boolean;
}): string | null => {
  const { isLoadingComplete, supportsTemperature, isManaged } = params;
  if (!isLoadingComplete) return 'Controls are available after device settings load.';
  if (!supportsTemperature) return PRICE_TEMPERATURE_ONLY_REASON;
  if (!isManaged) return 'Price requires Managed to be on first.';
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
      ? getPriceDisabledReason({
        isLoadingComplete,
        supportsTemperature: manageability.supportsTemperature,
        isManaged: manageability.isManaged,
      })
      : null,
  };
};
