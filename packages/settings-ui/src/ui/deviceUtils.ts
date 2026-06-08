import type {
  DeviceDescriptor,
  EvBoostConfig,
  ObservedDeviceState,
  TemperatureBoostConfig,
} from '../../../contracts/src/types.ts';

export { isGrayStateDevice } from '../../../shared-domain/src/deviceStatePredicates.ts';

// The device fields the settings-UI device LIST surface reads — the decomposed
// snapshot halves (observed truth + the descriptor config the list shows), NOT
// the raw producer `TargetDeviceSnapshot` / `DecoratedDeviceSnapshot`. The full
// snapshot stays structurally assignable (every descriptor field is optional),
// so callers (e.g. `state.latestDevices`) pass unchanged. First surface of the
// settings-UI snapshot-consumer decoupling (notes/state-management/).
export type SettingsUiDeviceListItem = ObservedDeviceState
  & Pick<DeviceDescriptor,
    | 'deviceClass' | 'deviceType' | 'budgetExempt' | 'flowBacked'
    | 'powerCapable' | 'powerKw' | 'expectedPowerKw' | 'loadKw'
    | 'controlAdapter' | 'controlCapabilityId'
  >;

// The device fields the settings-UI device DETAIL surface reads — a superset of
// the LIST carrier (detail calls the shared list predicates, so its device must
// stay assignable to `SettingsUiDeviceListItem`) plus the extra descriptor
// config the detail panes show and the optimistic boost-config augmentation that
// `state.latestDevices` (`SettingsUiDeviceView`) carries. Still NOT the raw
// producer `TargetDeviceSnapshot` / `DecoratedDeviceSnapshot`; the full snapshot
// stays structurally assignable, so callers pass unchanged.
export type SettingsUiDeviceDetailItem = SettingsUiDeviceListItem
  & Pick<DeviceDescriptor,
    | 'controlWriteCapabilityId' | 'steppedLoadProfile' | 'targetPowerConfig'
    | 'capabilities' | 'flowConflict'
  >
  & {
    temperatureBoost?: TemperatureBoostConfig;
    evBoost?: EvBoostConfig;
  };

export const supportsPowerDevice = (device?: SettingsUiDeviceListItem | null): boolean => {
  if (!device) return false;
  if (device.powerCapable !== undefined) return device.powerCapable;
  return typeof device.powerKw === 'number'
    || typeof device.expectedPowerKw === 'number'
    || typeof device.measuredPowerKw === 'number'
    || typeof device.loadKw === 'number';
};

export const supportsTemperatureDevice = (device?: SettingsUiDeviceListItem | null): boolean => {
  if (!device) return false;
  if (device.deviceType) return device.deviceType === 'temperature';
  return (device.targets?.length ?? 0) > 0;
};

export const supportsManagedDevice = (supportsPower: boolean, supportsTemperature: boolean): boolean => (
  supportsPower || supportsTemperature
);

export const requiresNativeWiringForActivation = (device?: SettingsUiDeviceListItem | null): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && device.controlAdapter.activationRequired === true
  && device.controlAdapter.activationEnabled !== true
  && device.controlCapabilityId !== 'evcharger_charging'
);

export const supportsNativeWiringActivation = (device?: SettingsUiDeviceListItem | null): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && (
    device.controlAdapter.activationRequired === true
    || device.controlAdapter.activationAvailable === true
  )
);
