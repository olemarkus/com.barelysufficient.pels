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
import { SettingsUiHomeScopeAdapter } from '../settingsUiHomeScope';
import { readPelsHost } from '../../lib/app/pelsHost';
import type { SettingsUiDevicesPayload } from '../../packages/contracts/src/settingsUi/devices';

type DevicesReadContext = ApiContext & { query?: unknown };
type PreparationReadContext = ApiContext & { query: { modePreparation: 'next'; homeId?: never } };
type PreparationPayload = Pick<SettingsUiDevicesPayload, 'schedules'>;

const devicesRead = ({ homey, query }: DevicesReadContext): SettingsUiDevicesPayload | PreparationPayload => {
  if (SettingsUiHomeScopeAdapter.includesModePreparation(query)
    && SettingsUiHomeScopeAdapter.parseRequestedScope(query).state === 'whole_home') {
    return {
      schedules: readPelsHost(homey)?.readSchedules(true)
        ?? { ok: false, error: 'Schedules are starting. Try again.' },
    };
  }
  return getSettingsUiDevicesPayload({ homey, query });
};

const coreRoutes = defineRoutes({
  ui_bootstrap: ({ homey }: ApiContext) => buildSettingsUiBootstrap({ homey }),
  // The three `?homeId=`-aware reads. The app-API transport hands every handler
  // `{ query, params, body }` alongside `homey` (the same seam `body` already
  // arrives on for ui_homes_save); `setup/settingsUiHomeScope.ts` owns the
  // complete classification of the raw bag, so this layer only forwards it.
  ui_devices: devicesRead,
  ui_plan: ({ homey, query }: ApiContext & { query?: unknown }) => getSettingsUiPlanPayload({ homey, query }),
  ui_power: ({ homey, query }: ApiContext & { query?: unknown }) => getSettingsUiPowerPayload({ homey, query }),
  ui_device_diagnostics: ({ homey }: ApiContext) => getSettingsUiDeviceDiagnosticsPayload({ homey }),
  ui_device_log: ({ homey }: ApiContext) => getSettingsUiDeviceLogPayload({ homey }),
  ui_refresh_devices: ({ homey }: ApiContext) => refreshSettingsUiDevices({ homey }),
  ui_refresh_flow_conflicts: ({ homey }: ApiContext) => refreshSettingsUiFlowConflicts({ homey }),
  settings_ui_log: ({ homey, body }: ApiContext & { body?: unknown }) => logSettingsUiMessage({ homey, body }),
  ui_reset_power_stats: ({ homey }: ApiContext) => resetSettingsUiPowerStats({ homey }),
});

// The logging wrapper adds a Promise and forwards the query unchanged.
type DevicesRoute = {
  (context: ApiContext & { query?: undefined }): Promise<SettingsUiDevicesPayload>;
  (context: PreparationReadContext): Promise<PreparationPayload>;
  (context: DevicesReadContext): Promise<SettingsUiDevicesPayload | PreparationPayload>;
};

export const settingsUiCoreRoutes = coreRoutes as Omit<typeof coreRoutes, 'ui_devices'> & {
  ui_devices: DevicesRoute;
};
