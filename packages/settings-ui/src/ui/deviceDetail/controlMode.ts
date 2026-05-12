import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  getEffectiveControlModel,
  getStoredTargetPowerConfig,
  isNativeSteppedLoadProfileActive,
} from '../deviceControlProfiles.ts';
import type { MdFilledSelectElement } from '../dom.ts';
import {
  createContinuousTargetPowerConfig,
  createEvTargetPowerConfig,
} from './targetPowerConfig.ts';

export type DeviceDetailControlMode =
  | 'default'
  | 'stepped_load'
  | 'continuous'
  | 'ev_charger_1_phase'
  | 'ev_charger_3_phase';

export type DeviceDetailControlModeOption = {
  value: DeviceDetailControlMode;
  label: string;
};

export function getDeviceDetailControlModeOptions(
  device: TargetDeviceSnapshot | null,
): DeviceDetailControlModeOption[] {
  const options: DeviceDetailControlModeOption[] = [
    { value: 'default', label: 'Default' },
  ];

  if (isNativeSteppedLoadProfileActive(device)) {
    options.push({ value: 'stepped_load', label: 'Stepped load' });
  } else if (!isNativeEvWiringActive(device)) {
    options.push(
      { value: 'stepped_load', label: 'Stepped load' },
      { value: 'continuous', label: 'Continuous' },
    );
  }

  if (canUseEvTargetPowerPreset(device)) {
    options.push(
      { value: 'ev_charger_1_phase', label: 'EV 1-phase' },
      { value: 'ev_charger_3_phase', label: 'EV 3-phase' },
    );
  }
  return options;
}

export function syncDeviceDetailControlModeOptions(
  select: MdFilledSelectElement | null,
  device: TargetDeviceSnapshot | null,
  selectedValue?: string,
): void {
  if (!select) return;
  const allowed = new Set<string>(getDeviceDetailControlModeOptions(device).map((option) => option.value));
  // The full option set lives in the HTML so md-filled-select indexes them at
  // mount; toggle visibility/disabled rather than replacing children, which
  // would leave the trigger headline blank.
  const options = select.querySelectorAll('md-select-option');
  options.forEach((option) => {
    const value = option.getAttribute('value') ?? '';
    const isAllowed = allowed.has(value);
    option.toggleAttribute('disabled', !isAllowed);
    option.toggleAttribute('hidden', !isAllowed);
    if (selectedValue !== undefined && value === selectedValue) {
      option.setAttribute('selected', '');
    } else {
      option.removeAttribute('selected');
    }
  });
}

export function resolveDeviceDetailControlMode(device: TargetDeviceSnapshot): DeviceDetailControlMode {
  const targetPowerConfig = getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig;
  if (targetPowerConfig?.enabled !== false) {
    if (targetPowerConfig?.preset === 'ev_charger_1_phase') return 'ev_charger_1_phase';
    if (targetPowerConfig?.preset === 'ev_charger_3_phase') return 'ev_charger_3_phase';
    if (targetPowerConfig) return isNativeEvWiringActive(device) ? 'default' : 'continuous';
  }
  if (getEffectiveControlModel(device) === 'stepped_load') return 'stepped_load';
  return 'default';
}

export function isNativeEvWiringActive(device: TargetDeviceSnapshot | null | undefined): boolean {
  return device?.controlAdapter?.kind === 'capability_adapter'
    && device.controlAdapter.activationEnabled === true
    && device.controlWriteCapabilityId === 'charging_button';
}

export function hasEvTargetPowerPreset(device: TargetDeviceSnapshot | null | undefined): boolean {
  const targetPowerConfig = device ? getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig : undefined;
  return targetPowerConfig?.enabled !== false
    && (
      targetPowerConfig?.preset === 'ev_charger_1_phase'
      || targetPowerConfig?.preset === 'ev_charger_3_phase'
    );
}

function isEvChargerDevice(device: TargetDeviceSnapshot | null | undefined): boolean {
  return device?.deviceClass === 'evcharger';
}

function canUseEvTargetPowerPreset(device: TargetDeviceSnapshot | null | undefined): boolean {
  return isEvChargerDevice(device) || hasEvTargetPowerPreset(device);
}

export function normalizeDeviceDetailControlMode(value: string): DeviceDetailControlMode | null {
  if (
    value === 'default'
    || value === 'stepped_load'
    || value === 'continuous'
    || value === 'ev_charger_1_phase'
    || value === 'ev_charger_3_phase'
  ) return value;
  return null;
}

export function isControlModeAllowedForDevice(
  controlMode: DeviceDetailControlMode,
  device: TargetDeviceSnapshot,
): boolean {
  const isEvPreset = controlMode === 'ev_charger_1_phase' || controlMode === 'ev_charger_3_phase';
  if (isEvPreset) return canUseEvTargetPowerPreset(device);
  if (!isNativeEvWiringActive(device)) return true;
  return controlMode === 'default';
}

export function resolveTargetPowerConfigForControlMode(
  controlMode: DeviceDetailControlMode,
  device: TargetDeviceSnapshot,
) {
  if (controlMode === 'ev_charger_1_phase' || controlMode === 'ev_charger_3_phase') {
    return createEvTargetPowerConfig(controlMode);
  }
  if (controlMode === 'continuous') return createContinuousTargetPowerConfig(device);
  return null;
}
