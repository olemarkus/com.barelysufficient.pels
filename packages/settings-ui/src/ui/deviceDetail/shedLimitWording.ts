/**
 * The two limit fields, worded for the device in front of the owner.
 *
 * On a reversible unit the first limit is the HEATING floor, and both hints say
 * which direction they govern.
 */
import {
  deviceDetailShedCoolingTempHint,
  deviceDetailShedTemp,
  deviceDetailShedTempHint,
} from '../dom.ts';
import { isTemperatureDeviceWithoutOnOff, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';

/**
 * Whether the device reports which way it is moving demand. Only then does a
 * second limit mean anything: without a mode axis the device is a heater, and
 * its one limit is a floor.
 */
export const reportsThermostatMode = (device: SettingsUiDeviceDetailItem): boolean => (
  device.capabilities?.includes('thermostat_mode') === true
);

export const describeLimitFields = (device: SettingsUiDeviceDetailItem): {
  heatingLabel: string;
  heatingHint: string;
  coolingHint: string;
} => {
  const reversible = reportsThermostatMode(device);
  // With no on/off, the target is PELS's only way to limit the device, so a
  // limit at or above a mode's temperature leaves nothing to lower in that mode.
  const setpointOnly = isTemperatureDeviceWithoutOnOff(device);
  const keepBelow = setpointOnly
    ? ' Keep it below each mode\'s temperature, or PELS cannot limit the device in that mode.'
    : '';
  let heatingHint = 'Use this target instead of turning the device off.';
  if (reversible) heatingHint = 'While heating, PELS lowers its target to this instead of turning it off.';
  else if (setpointOnly) heatingHint = 'PELS lowers the target to this while it limits the device.';
  return {
    heatingLabel: reversible ? 'Limited temperature when heating' : 'Limited temperature',
    heatingHint: heatingHint + keepBelow,
    coolingHint: 'While cooling, PELS raises its target to this instead of turning it off.',
  };
};

/** Write the wording onto the fields. Guarded per handle: the stub harnesses omit some. */
export const applyLimitWording = (device: SettingsUiDeviceDetailItem): void => {
  const wording = describeLimitFields(device);
  if (deviceDetailShedTemp) deviceDetailShedTemp.label = wording.heatingLabel;
  if (deviceDetailShedTempHint) deviceDetailShedTempHint.textContent = wording.heatingHint;
  if (deviceDetailShedCoolingTempHint) deviceDetailShedCoolingTempHint.textContent = wording.coolingHint;
};
