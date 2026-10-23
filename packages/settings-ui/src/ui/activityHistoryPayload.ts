import type { SettingsUiDeviceLogPayload } from '../../../contracts/src/settingsUiApi.ts';
import { parseDeviceActivityEntry } from '../../../shared-domain/src/deviceActivity.ts';

const positiveInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);

export const parseDeviceActivityPayload = (raw: unknown): SettingsUiDeviceLogPayload => {
  if (raw === null || typeof raw !== 'object') throw new Error('Activity history unavailable');
  const value = raw as Record<string, unknown>;
  if (value.version !== 2 || !Array.isArray(value.entries)
    || !value.entries.every((entry) => parseDeviceActivityEntry(entry) !== undefined)
    || !positiveInteger(value.retentionDays)
    || !positiveInteger(value.maxEntriesPerDevice)
    || !positiveInteger(value.maxEntries)
    || (value.persistence !== 'stored' && value.persistence !== 'pending')) {
    throw new Error('Activity history unavailable');
  }
  return value as SettingsUiDeviceLogPayload;
};
