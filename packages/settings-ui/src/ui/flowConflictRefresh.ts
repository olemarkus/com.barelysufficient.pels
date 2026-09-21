import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH,
  type SettingsUiEvSocFlowReporter,
  type SettingsUiFlowConflictRefreshDevice,
  type SettingsUiFlowConflictRefreshPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  callApi,
  invalidateApiCacheForAllHomes,
} from './homey.ts';
import { state, type SettingsUiDeviceView } from './state.ts';

export type EvSocFlowReportersRead =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'resolved'; reporters: readonly SettingsUiEvSocFlowReporter[] }
  | { state: 'stale'; reporters: readonly SettingsUiEvSocFlowReporter[] };

let refreshInFlight: Promise<SettingsUiFlowConflictRefreshPayload> | undefined;
let evSocFlowReportersRead: EvSocFlowReportersRead = { state: 'loading' };
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

const hasEvSocFlowReporterShape = (value: unknown): value is SettingsUiEvSocFlowReporter => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const reporter = value as Record<string, unknown>;
  return typeof reporter.chargerDeviceId === 'string'
    && reporter.chargerDeviceId.length > 0
    && reporter.chargerDeviceId === reporter.chargerDeviceId.trim()
    && (reporter.flowName === undefined || (
      typeof reporter.flowName === 'string'
      && reporter.flowName.length > 0
      && reporter.flowName === reporter.flowName.trim()
    ));
};

const parseEvSocFlowReporters = (value: unknown): SettingsUiEvSocFlowReporter[] => {
  if (!Array.isArray(value) || !value.every(hasEvSocFlowReporterShape)) {
    throw new TypeError(REFRESH_ERROR_MESSAGE);
  }
  if (new Set(value.map((reporter) => reporter.chargerDeviceId)).size !== value.length) {
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

const refreshFlowConflictDevices = async (): Promise<SettingsUiFlowConflictRefreshPayload> => {
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
  const evSocReporters = parseEvSocFlowReporters(payload.evSocReporters);
  const refreshedById = new Map(refreshedDevices.map((device) => [device.id, device]));
  // The command response contains only the facts it refreshed. Drop the full
  // read-model cache rather than putting a partial device into that trusted
  // cache. This is unconditional so an older cold-boot read cannot commit
  // into the cache after the backend scan changed native-control facts.
  invalidateApiCacheForAllHomes(SETTINGS_UI_DEVICES_PATH);
  if (state.devicesLoaded) {
    const devices = state.latestDevices.map((device) => {
      const refreshed = refreshedById.get(device.id);
      return refreshed ? withRefreshedNativeControlFacts(device, refreshed) : device;
    });
    state.latestDevices = devices;
    document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices } }));
  }
  return { devices: refreshedDevices, evSocReporters };
};

export const readEvSocFlowReporters = (): EvSocFlowReportersRead => evSocFlowReportersRead;

const runFlowConflictRefresh = async (): Promise<SettingsUiFlowConflictRefreshPayload> => {
  refreshInFlight ??= refreshFlowConflictDevices().finally(() => { refreshInFlight = undefined; });
  try {
    const payload = await refreshInFlight;
    evSocFlowReportersRead = { state: 'resolved', reporters: payload.evSocReporters };
    return payload;
  } catch (error) {
    evSocFlowReportersRead = evSocFlowReportersRead.state === 'resolved'
      || evSocFlowReportersRead.state === 'stale'
      ? { state: 'stale', reporters: evSocFlowReportersRead.reporters }
      : { state: 'unavailable' };
    throw error;
  }
};

/** Advisory callers may share one scan; they only need the latest available facts. */
export const refreshFlowConflictFacts = (): Promise<SettingsUiFlowConflictRefreshPayload> => (
  runFlowConflictRefresh()
);

/** A user check starts after any older scan so it observes edits made before the click. */
export const refreshFlowConflictFactsExplicit = async (): Promise<SettingsUiFlowConflictRefreshPayload> => {
  const predecessor = refreshInFlight;
  if (predecessor) {
    try {
      await predecessor;
    } catch {
      // The explicit scan is still owed after an unavailable advisory scan.
    }
  }
  return runFlowConflictRefresh();
};

export const hasEvSocFlowReporter = (deviceId: string): boolean => (
  (evSocFlowReportersRead.state === 'resolved' || evSocFlowReportersRead.state === 'stale')
  && evSocFlowReportersRead.reporters.some((reporter) => reporter.chargerDeviceId === deviceId)
);

export const checkFlowConflictNow = async (deviceId: string): Promise<boolean> => {
  const { devices: refreshedDevices } = await refreshFlowConflictFactsExplicit();
  if (!refreshedDevices.some((device) => device.id === deviceId)) {
    throw new Error(REFRESH_ERROR_MESSAGE);
  }
  const device = state.latestDevices.find((entry) => entry.id === deviceId);
  if (!device) throw new Error(REFRESH_ERROR_MESSAGE);
  return (device.flowConflict?.conflictingCapabilities.length ?? 0) > 0;
};
