import { isNativeSteppedLoadProfileActive } from '../deviceControlProfiles.ts';
import {
  canUseEvTargetPowerPreset,
  isNativeEvWiringActive,
  type DeviceDetailControlMode,
} from '../deviceKind.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import type { MdFilledSelectElement } from '../dom.ts';
import {
  createContinuousTargetPowerConfig,
  createEvTargetPowerConfig,
} from './targetPowerConfig.ts';

// Re-exported so existing importers keep one import site while the resolver
// migrates to deviceKind.ts (this PR keeps the churn to the definitions).
export { resolveDeviceDetailControlMode, type DeviceDetailControlMode } from '../deviceKind.ts';

export type DeviceDetailControlModeOption = {
  value: DeviceDetailControlMode;
  label: string;
};

export function getDeviceDetailControlModeOptions(
  device: SettingsUiDeviceDetailItem | null,
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
  device: SettingsUiDeviceDetailItem | null,
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

// Display label for the Charging card's control-mode readout. A static total
// map, deliberately NOT filtered through the option list: the readout states
// the mode that IS resolved, and falling back to "Default" for a mode missing
// from the current options would reinterpret an unexpected state as a benign
// one (resolution-in-the-producer rule).
const CONTROL_MODE_DISPLAY_LABELS: Record<DeviceDetailControlMode, string> = {
  default: 'Default',
  stepped_load: 'Stepped load',
  continuous: 'Continuous',
  ev_charger_1_phase: 'EV 1-phase',
  ev_charger_3_phase: 'EV 3-phase',
};

export function getControlModeDisplayLabel(controlMode: DeviceDetailControlMode): string {
  return CONTROL_MODE_DISPLAY_LABELS[controlMode];
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
  device: SettingsUiDeviceDetailItem,
): boolean {
  const isEvPreset = controlMode === 'ev_charger_1_phase' || controlMode === 'ev_charger_3_phase';
  if (isEvPreset) return canUseEvTargetPowerPreset(device);
  if (!isNativeEvWiringActive(device)) return true;
  return controlMode === 'default';
}

export function resolveTargetPowerConfigForControlMode(
  controlMode: DeviceDetailControlMode,
  device: SettingsUiDeviceDetailItem,
) {
  if (controlMode === 'ev_charger_1_phase' || controlMode === 'ev_charger_3_phase') {
    return createEvTargetPowerConfig(controlMode);
  }
  if (controlMode === 'continuous') return createContinuousTargetPowerConfig(device);
  return null;
}
