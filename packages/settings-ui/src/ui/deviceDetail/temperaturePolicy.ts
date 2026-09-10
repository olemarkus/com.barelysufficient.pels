import { resolveTemperatureControlMode } from '../../../../shared-domain/src/settings/temperatureControl.ts';
import { state } from '../state.ts';
import {
  supportsPowerDevice, supportsTemperatureControlDevice, supportsTemperatureDevice, type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import { isSteppedLoadControlModel } from '../deviceKind.ts';

export function followsDeviceTemperature(device: SettingsUiDeviceDetailItem | null): boolean {
  return device !== null && resolveTemperatureControlMode(
    state.temperatureControlModes, state.temperatureControlDisabledMap, device.id,
  ) === 'update_mode';
}

export function supportsTemperatureAdjustments(device: SettingsUiDeviceDetailItem | null): boolean {
  return supportsTemperatureControlDevice(device) && !followsDeviceTemperature(device);
}

export function supportsPowerLimiting(device: SettingsUiDeviceDetailItem | null): boolean {
  return supportsPowerDevice(device) && (!supportsTemperatureDevice(device) || supportsTemperatureAdjustments(device)
    || device?.binaryControllable === true || isSteppedLoadControlModel(device));
}

export function temperatureAdjustmentGateHint(device: SettingsUiDeviceDetailItem | null): string {
  return followsDeviceTemperature(device)
    ? 'Not applied while PELS saves temperature changes as the current mode target. Your saved settings are kept.'
    : 'Not applied while PELS keeps the new temperature. Your saved settings are kept.';
}

export function manualTemperaturePowerHint(device: SettingsUiDeviceDetailItem | null): string {
  if (!supportsPowerDevice(device)) return 'PELS cannot limit this device’s power.';
  if (isSteppedLoadControlModel(device)) return 'PELS can still limit power using this device’s power levels.';
  if (device?.binaryControllable === true) return 'PELS can still limit power by turning this device off and on.';
  return 'PELS cannot limit this device’s power without changing its temperature.';
}
