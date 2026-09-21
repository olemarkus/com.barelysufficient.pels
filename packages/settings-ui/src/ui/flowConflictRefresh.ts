import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH,
  type SettingsUiFlowConflictRefreshDevice,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  callApi,
  invalidateApiCacheForAllHomes,
} from './homey.ts';
import { state, type SettingsUiDeviceView } from './state.ts';

let refreshInFlight: Promise<SettingsUiFlowConflictRefreshDevice[]> | undefined;
const REFRESH_ERROR_MESSAGE = 'Could not check Homey Flows. Try again.';

const hasValidFlowConflict = (
  value: unknown,
): value is SettingsUiFlowConflictRefreshDevice['flowConflict'] => {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const conflict = value as { conflictingCapabilities?: unknown; flowName?: unknown };
  return Array.isArray(conflict.conflictingCapabilities)
    && conflict.conflictingCapabilities.every((capability) => typeof capability === 'string')
    && (conflict.flowName === undefined || typeof conflict.flowName === 'string');
};

const hasValidControlAdapter = (
  value: unknown,
): value is SettingsUiFlowConflictRefreshDevice['controlAdapter'] => {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const adapter = value as Record<string, unknown>;
  return adapter.kind === 'capability_adapter'
    && typeof adapter.activationRequired === 'boolean'
    && typeof adapter.activationEnabled === 'boolean'
    && (adapter.activationAvailable === undefined || typeof adapter.activationAvailable === 'boolean');
};

const hasFlowConflictRefreshShape = (
  value: unknown,
): value is SettingsUiFlowConflictRefreshDevice => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return typeof device.id === 'string'
    && hasValidFlowConflict(device.flowConflict)
    && hasValidControlAdapter(device.controlAdapter);
};

const parseRefreshedDevices = (value: unknown): SettingsUiFlowConflictRefreshDevice[] => {
  if (!Array.isArray(value) || !value.every(hasFlowConflictRefreshShape)) {
    throw new TypeError(REFRESH_ERROR_MESSAGE);
  }
  if (new Set(value.map((device) => device.id)).size !== value.length) {
    throw new TypeError(REFRESH_ERROR_MESSAGE);
  }
  return value;
};

const withRefreshedNativeControlFacts = (
  device: SettingsUiDeviceView,
  refreshed: SettingsUiFlowConflictRefreshDevice,
): SettingsUiDeviceView => ({
  ...device,
  flowConflict: refreshed.flowConflict,
  controlAdapter: refreshed.controlAdapter,
});

const refreshFlowConflictDevices = async (): Promise<SettingsUiFlowConflictRefreshDevice[]> => {
  const response = await callApi<unknown>(
    'POST',
    SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH,
    {},
  );
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new TypeError(REFRESH_ERROR_MESSAGE);
  }
  const payload = response as Record<string, unknown>;
  const refreshedDevices = parseRefreshedDevices(payload.devices);
  const refreshedById = new Map(refreshedDevices.map((device) => [device.id, device]));
  const devices = state.latestDevices.map((device) => {
    const refreshed = refreshedById.get(device.id);
    return refreshed ? withRefreshedNativeControlFacts(device, refreshed) : device;
  });
  // The command response contains only the facts it refreshed. Drop the full
  // read-model cache rather than putting a partial device into that trusted
  // cache; the next ordinary read repopulates it through `/ui_devices`.
  invalidateApiCacheForAllHomes(SETTINGS_UI_DEVICES_PATH);
  state.latestDevices = devices;
  state.devicesLoaded = true;
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices } }));
  return refreshedDevices;
};

export const checkFlowConflictNow = async (deviceId: string): Promise<boolean> => {
  refreshInFlight ??= refreshFlowConflictDevices().finally(() => { refreshInFlight = undefined; });
  const refreshedDevices = await refreshInFlight;
  if (!refreshedDevices.some((device) => device.id === deviceId)) {
    throw new Error(REFRESH_ERROR_MESSAGE);
  }
  const device = state.latestDevices.find((entry) => entry.id === deviceId);
  if (!device) throw new Error(REFRESH_ERROR_MESSAGE);
  return (device.flowConflict?.conflictingCapabilities.length ?? 0) > 0;
};
