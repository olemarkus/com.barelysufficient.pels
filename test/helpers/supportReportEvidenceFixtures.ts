import type {
  SettingsUiDeviceActivityEntry, SettingsUiDeviceLogPayload,
} from '../../packages/contracts/src/settingsUiApi';

export const REPORT_HOUR_MS = 60 * 60 * 1000;
export const REPORT_CAPTURE_MS = Date.UTC(2026, 9, 23, 12);

export const reportActivityFixture = (
  overrides: Partial<SettingsUiDeviceActivityEntry> = {},
): SettingsUiDeviceActivityEntry => ({
  id: 'row', deviceId: 'heater', deviceName: 'Hall heater',
  atMs: REPORT_CAPTURE_MS - REPORT_HOUR_MS,
  recordingStartedAtMs: REPORT_CAPTURE_MS - 30 * REPORT_HOUR_MS,
  stateKind: 'held', stateTone: 'held', stateMsg: 'Waiting',
  powerMsg: '1.8 kW when running', usageMsg: 'Using 0 W', statusMsg: 'Waiting for capacity',
  ...overrides,
});

export const reportHistoryFixture = (
  entries: SettingsUiDeviceActivityEntry[] = [],
): SettingsUiDeviceLogPayload => ({
  version: 2, entries, retentionDays: 7, maxEntries: 1000, maxEntriesPerDevice: 100, persistence: 'stored',
});
