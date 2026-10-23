import type {
  SettingsUiDeviceActivityEntry,
} from '../../contracts/src/settingsUiApi';

const text = (value: unknown): value is string => typeof value === 'string';
const timestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);

/** Both SQLite rows and browser API responses are external reads. */
export const parseDeviceActivityEntry = (raw: unknown): SettingsUiDeviceActivityEntry | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!['id', 'deviceId', 'deviceName', 'stateMsg', 'stateKind', 'stateTone', 'usageMsg', 'statusMsg']
    .every((key) => text(value[key]))) return undefined;
  if (!value.id || !value.deviceId || !timestamp(value.atMs) || !timestamp(value.recordingStartedAtMs)
    || !(value.powerMsg === null || text(value.powerMsg))) return undefined;
  return value as SettingsUiDeviceActivityEntry;
};
