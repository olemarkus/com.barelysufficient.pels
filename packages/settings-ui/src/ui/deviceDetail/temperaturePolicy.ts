import {
  resolveTemperatureControlMode, type TemperatureControlMode,
} from '../../../../shared-domain/src/settings/temperatureControl.ts';
import { state } from '../state.ts';
import {
  supportsPowerDevice, supportsTemperatureControlDevice, supportsTemperatureDevice, type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import { isSteppedLoadControlModel } from '../deviceKind.ts';
import { POWER_READING_REMEDY } from '../deviceControlAvailability.ts';

export function followsDeviceTemperature(device: SettingsUiDeviceDetailItem | null): boolean {
  return device !== null && resolveTemperatureControlMode(
    state.temperatureControlModes, state.temperatureControlDisabledMap, device.id,
  ) === 'update_mode';
}

/** Solar offsets: switched off under both non-default temperature policies. */
export function supportsTemperatureAdjustments(device: SettingsUiDeviceDetailItem | null): boolean {
  return supportsTemperatureControlDevice(device) && !followsDeviceTemperature(device);
}

/** Price shifts remain available when manual target changes are saved to a mode. */
export function supportsPriceTemperatureAdjustments(device: SettingsUiDeviceDetailItem | null): boolean {
  return supportsTemperatureControlDevice(device);
}

/**
 * Power limiting by setpoint is a narrower denial than the offsets above. "Save
 * as current mode target" keeps the owner's limit in force — a temperature chosen
 * while the device is limited is drift PELS reconciles, not a new target — so
 * only "Keep the new temperature" (temperature control off) denies it, which is
 * exactly what `supportsTemperatureControlDevice` answers.
 */
export function supportsPowerLimiting(device: SettingsUiDeviceDetailItem | null): boolean {
  return supportsPowerDevice(device) && (!supportsTemperatureDevice(device) || supportsTemperatureControlDevice(device)
    || device?.binaryControllable === true || isSteppedLoadControlModel(device));
}

export function temperatureAdjustmentGateHint(device: SettingsUiDeviceDetailItem | null): string {
  return followsDeviceTemperature(device)
    ? 'Not applied while PELS saves temperature changes as the current mode target. Your saved settings are kept.'
    : 'Not applied while PELS keeps the new temperature. Your saved settings are kept.';
}

/**
 * What power limiting means under a non-default temperature policy.
 *
 * "Save as current mode target" leaves limiting exactly as configured — the
 * owner's limit is still a limit — so the only thing worth saying is what it
 * changes: a temperature set by hand while the device is limited is drift PELS
 * reconciles, not a new target. "Keep the new temperature" is the policy that
 * takes the setpoint away, and the sentence names what is left.
 */
export function manualTemperaturePowerHint(
  device: SettingsUiDeviceDetailItem,
  policy: Exclude<TemperatureControlMode, 'mode'>,
): string {
  if (!supportsPowerDevice(device)) return `PELS cannot limit this device’s power. It needs ${POWER_READING_REMEDY}.`;
  if (policy === 'update_mode') {
    return 'PELS still limits this device’s power as configured. '
      + 'While PELS is limiting its temperature, a change made outside PELS is not saved as the mode target.';
  }
  if (isSteppedLoadControlModel(device)) return 'PELS can still limit power using this device’s power levels.';
  if (device.binaryControllable === true) return 'PELS can still limit power by turning this device off and on.';
  return 'PELS cannot limit this device’s power without changing its temperature.';
}
