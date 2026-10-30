import {
  buildSettingsUiBootstrap,
  getSettingsUiDeviceDiagnosticsPayload,
  getSettingsUiDeviceLogPayload,
  getSettingsUiDevicesPayload,
  getSettingsUiPlanPayload,
  getSettingsUiPowerPayload,
  logSettingsUiMessage,
  refreshSettingsUiDevices,
  resetSettingsUiPowerStats,
} from '../settingsUiApi';
import { refreshSettingsUiFlowConflicts } from '../settingsUiFlowConflictApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const settingsUiCoreRoutes = defineRoutes({
  ui_bootstrap: ({ homey }: ApiContext) => buildSettingsUiBootstrap({ homey }),
  // The three `?homeId=`-aware reads. The app-API transport hands every handler
  // `{ query, params, body }` alongside `homey` (the same seam `body` already
  // arrives on for ui_homes_save); `setup/settingsUiHomeScope.ts` owns the
  // complete classification of the raw bag, so this layer only forwards it.
  ui_devices: ({ homey, query }: ApiContext & { query?: unknown }) => getSettingsUiDevicesPayload({ homey, query }),
  ui_plan: ({ homey, query }: ApiContext & { query?: unknown }) => getSettingsUiPlanPayload({ homey, query }),
  ui_power: ({ homey, query }: ApiContext & { query?: unknown }) => getSettingsUiPowerPayload({ homey, query }),
  ui_device_diagnostics: ({ homey }: ApiContext) => getSettingsUiDeviceDiagnosticsPayload({ homey }),
  ui_device_log: ({ homey }: ApiContext) => getSettingsUiDeviceLogPayload({ homey }),
  ui_refresh_devices: ({ homey }: ApiContext) => refreshSettingsUiDevices({ homey }),
  ui_refresh_flow_conflicts: ({ homey }: ApiContext) => refreshSettingsUiFlowConflicts({ homey }),
  settings_ui_log: ({ homey, body }: ApiContext & { body?: unknown }) => logSettingsUiMessage({ homey, body }),
  ui_reset_power_stats: ({ homey }: ApiContext) => resetSettingsUiPowerStats({ homey }),
});
