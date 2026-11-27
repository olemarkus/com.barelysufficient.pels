import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';

const hasValidFlowConflict = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isUnknownRecord(value)) return false;
  const conflict = value as { conflictingCapabilities?: unknown; flowName?: unknown };
  return Array.isArray(conflict.conflictingCapabilities)
    && conflict.conflictingCapabilities.every((capability) => typeof capability === 'string')
    && (conflict.flowName === undefined || typeof conflict.flowName === 'string');
};

const isDeviceType = (value: unknown): boolean => value === 'temperature' || value === 'onoff';

const hasResolvedAvailability = (value: unknown): value is SettingsUiDeviceListItem => (
  typeof value === 'object'
  && value !== null
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { name?: unknown }).name === 'string'
  && typeof (value as { available?: unknown }).available === 'boolean'
  // Required on the wire: the charger and on/off checks read them straight.
  && typeof (value as { isEvCharger?: unknown }).isEvCharger === 'boolean'
  && typeof (value as { binaryControllable?: unknown }).binaryControllable === 'boolean'
  && typeof (value as { isBatteryOrSolar?: unknown }).isBatteryOrSolar === 'boolean'
  && typeof (value as { managed?: unknown }).managed === 'boolean'
  && typeof (value as { deviceClass?: unknown }).deviceClass === 'string'
  && isDeviceType((value as { deviceType?: unknown }).deviceType)
  && hasValidFlowConflict((value as { flowConflict?: unknown }).flowConflict)
);

export const parseDeviceList = (value: unknown): SettingsUiDeviceListItem[] => {
  if (!Array.isArray(value) || !value.every(hasResolvedAvailability)) {
    throw new TypeError('Invalid device list response.');
  }
  return value;
};
