import {
  getEffectiveControlModel,
  getStoredTargetPowerConfig,
} from './deviceControlProfiles.ts';
import {
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from './deviceUtils.ts';

// The device-detail surface composes per-kind: which sections exist and in what
// order is decided once, here, instead of each section module re-deriving its
// own flavour of "is this an EV charger". Row-level gating (can this row show
// for this device) stays with the capability predicates in deviceUtils.ts and
// deviceControlProfiles.ts — the kind decides the page, not every row.
export type DeviceDetailKind = 'ev_charger' | 'temperature' | 'stepped' | 'binary';

export type DeviceDetailControlMode =
  | 'default'
  | 'stepped_load'
  | 'continuous'
  | 'ev_charger_1_phase'
  | 'ev_charger_3_phase';

export const isEvChargerDevice = (device: SettingsUiDeviceDetailItem | null | undefined): boolean => (
  device?.deviceClass === 'evcharger'
);

export const hasEvChargingControl = (device: SettingsUiDeviceDetailItem | null | undefined): boolean => (
  device?.deviceRole === 'ev_charger' && device.binaryControllable === true
);

export const isNativeEvWiringActive = (device: SettingsUiDeviceDetailItem | null | undefined): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && device.controlAdapter.activationEnabled === true
  && device.deviceRole === 'ev_charger'
);

export const hasEvTargetPowerPreset = (device: SettingsUiDeviceDetailItem | null | undefined): boolean => {
  const targetPowerConfig = device ? getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig : undefined;
  return targetPowerConfig?.enabled !== false
    && (
      targetPowerConfig?.preset === 'ev_charger_1_phase'
      || targetPowerConfig?.preset === 'ev_charger_3_phase'
    );
};

export const canUseEvTargetPowerPreset = (device: SettingsUiDeviceDetailItem | null | undefined): boolean => (
  isEvChargerDevice(device) || hasEvTargetPowerPreset(device)
);

export function resolveDeviceDetailControlMode(device: SettingsUiDeviceDetailItem): DeviceDetailControlMode {
  const targetPowerConfig = getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig;
  if (targetPowerConfig?.enabled !== false) {
    if (targetPowerConfig?.preset === 'ev_charger_1_phase') return 'ev_charger_1_phase';
    if (targetPowerConfig?.preset === 'ev_charger_3_phase') return 'ev_charger_3_phase';
    if (targetPowerConfig) return isNativeEvWiringActive(device) ? 'default' : 'continuous';
  }
  if (getEffectiveControlModel(device) === 'stepped_load') return 'stepped_load';
  return 'default';
}

export const isSteppedLoadControlModel = (device: SettingsUiDeviceDetailItem | null): boolean => (
  Boolean(device && resolveDeviceDetailControlMode(device) === 'stepped_load')
);

// Kind precedence: an EV charger stays an EV charger even when its preset is
// cleared (deviceClass) or when only its config marks it as one (preset /
// native EV wiring / charging control on a device whose class says otherwise).
// Temperature beats stepped: a thermostat given a stepped control model still
// composes as a temperature page that happens to show the step editor.
export const resolveDeviceDetailKind = (
  device: SettingsUiDeviceDetailItem | null | undefined,
): DeviceDetailKind => {
  if (!device) return 'binary';
  if (
    isEvChargerDevice(device)
    || hasEvTargetPowerPreset(device)
    || isNativeEvWiringActive(device)
    || hasEvChargingControl(device)
  ) return 'ev_charger';
  if (supportsTemperatureDevice(device)) return 'temperature';
  if (isSteppedLoadControlModel(device)) return 'stepped';
  return 'binary';
};
