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
  deviceDetailShedTempLabel,
} from '../dom.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { resolveSetpointShedFloorC } from '../../../../shared-domain/src/utils/airtreatmentShedTemperature.ts';
import { getPrimaryTargetCapability } from '../../../../shared-domain/src/targetCapabilities.ts';

type HeatingLimitChoice = 'automatic' | 'fixed' | 'switchable';

const describeAutomaticHeatingLimit = (device: SettingsUiDeviceDetailItem): string => {
  const minimum = resolveSetpointShedFloorC(device);
  const source = getPrimaryTargetCapability(device.targets)?.min === undefined
    ? 'PELS’s default minimum' : 'the device’s minimum target';
  return `Automatic: uses ${source}, ${minimum} °C, when limiting.`;
};

/**
 * Whether the device reports which way it is moving demand. Only then does a
 * second limit mean anything: without a mode axis the device is a heater, and
 * its one limit is a floor.
 */
export const reportsThermostatMode = (device: SettingsUiDeviceDetailItem): boolean => (
  device.capabilities?.includes('thermostat_mode') === true
);

const describeHeatingLimit = (device: SettingsUiDeviceDetailItem, choice: HeatingLimitChoice): string => {
  if (choice === 'automatic') return describeAutomaticHeatingLimit(device);
  if (choice === 'fixed') return 'Uses this target when limiting, in every mode. '
    + 'Keep it below each mode’s temperature so PELS can reduce heating.';
  return reportsThermostatMode(device)
    ? 'While heating, PELS lowers its target to this instead of turning it off.'
    : 'Use this target instead of turning the device off.';
};

const describeLimitFields = (device: SettingsUiDeviceDetailItem, choice: HeatingLimitChoice): {
  heatingLabel: string;
  heatingHint: string;
  coolingHint: string;
} => {
  const reversible = reportsThermostatMode(device);
  return {
    heatingLabel: reversible ? 'Limited temperature when heating' : 'Limited temperature',
    heatingHint: describeHeatingLimit(device, choice),
    coolingHint: 'While cooling, PELS raises its target to this instead of turning it off.',
  };
};

/** Write the wording onto the fields. Guarded per handle: the stub harnesses omit some. */
export const applyLimitWording = (device: SettingsUiDeviceDetailItem, choice: HeatingLimitChoice): void => {
  const wording = describeLimitFields(device, choice);
  // Material's floating label hides an empty field's placeholder until focus.
  // A persistent external label keeps Automatic visible even before editing.
  const externalLabel = choice !== 'switchable';
  if (deviceDetailShedTempLabel) {
    deviceDetailShedTempLabel.hidden = !externalLabel;
    deviceDetailShedTempLabel.textContent = wording.heatingLabel;
  }
  if (deviceDetailShedTemp) {
    deviceDetailShedTemp.label = externalLabel ? '' : wording.heatingLabel;
    deviceDetailShedTemp.ariaLabel = wording.heatingLabel;
  }
  if (deviceDetailShedTempHint) deviceDetailShedTempHint.textContent = wording.heatingHint;
  if (deviceDetailShedCoolingTempHint) deviceDetailShedCoolingTempHint.textContent = wording.coolingHint;
};
