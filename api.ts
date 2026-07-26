import type Homey from 'homey';
import type { DailyBudgetModelPreviewResponse, DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import type { Logger as PinoLogger } from 'pino';
import type { HomeyDeviceLike } from './lib/utils/types';
import { normalizeError } from './lib/utils/errorUtils';
import { hasPowerCapability } from './lib/device/transport/managerParse';
import {
  getHomeyDevicesForDebugFromApp,
  getHomeyEnergyMetersFromApp,
  logHomeyDeviceForDebugFromApp,
} from './setup/appDebugHelpers';
import type { HomeyEnergyMeterEntry } from './packages/contracts/src/settingsUiApi';
import {
  buildSettingsUiBootstrap,
  getSettingsUiDeferredObjectivePlanHistoryPayload,
  getSettingsUiDeferredObjectiveSettingsPayload,
  getSettingsUiDeviceDiagnosticsPayload,
  getSettingsUiWeatherAdvisorReadout,
  getSettingsUiDeviceLogPayload,
  getSettingsUiDevicesPayload,
  getSettingsUiPlanPayload,
  getSettingsUiPowerPayload,
  getSettingsUiPricesPayload,
  logSettingsUiMessage,
  applySettingsUiDailyBudgetModel,
  previewSettingsUiDailyBudgetModel,
  refreshSettingsUiDevices,
  refreshSettingsUiGridTariff,
  refreshSettingsUiPrices,
  recomputeSettingsUiDailyBudget,
  resetSettingsUiPowerStats,
} from './setup/settingsUiApi';
import {
  getSettingsUiHomesPayload,
  saveSettingsUiHomesConfig,
} from './setup/settingsUiHomesApi';
import {
  createSettingsUiStarvationRescue,
  getSettingsUiStarvationRescueDevices,
  previewSettingsUiStarvationRescue,
} from './setup/settingsUiStarvationRescueApi';
import {
  cancelSettingsUiSmartTask,
  previewSettingsUiSmartTask,
  updateSettingsUiSmartTask,
} from './setup/settingsUiSmartTaskApi';

type ApiContext = {
  homey: Homey.App['homey'];
};

type DailyBudgetApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
  recomputeDailyBudgetToday?: () => DailyBudgetUiPayload | null;
  getApiStructuredLogger?: () => PinoLogger | undefined;
};

const hasDeviceId = (device: HomeyDeviceLike): device is HomeyDeviceLike & { id: string } => (
  typeof device.id === 'string'
);

const getApp = (homey: Homey.App['homey']): DailyBudgetApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as DailyBudgetApp;
};

// Wrap an async API handler so any thrown error is logged through the runtime's
// structured pino logger before the rejection propagates to the Homey API
// transport. Without this, handler exceptions become opaque "Network request
// failed" responses on the client and never reach `/tmp/pels`, leaving the
// failure undiagnosable.
//
// During app restart `homey.app` (or its structured logger) may not be wired
// yet; fall back to `console.error` so the cause still lands in the app's
// stderr log instead of disappearing because no logger was reachable.
const withApiLogging = <Ctx extends ApiContext, R>(
  name: string,
  handler: (ctx: Ctx) => Promise<R> | R,
) => async (ctx: Ctx): Promise<R> => {
  try {
    return await handler(ctx);
  } catch (error) {
    const app = getApp(ctx.homey);
    const logger = app?.getApiStructuredLogger?.();
    if (logger) {
      logger.error({ event: 'api_handler_failed', handler: name, err: normalizeError(error) });
    } else {
      console.error(`api ${name} failed`, error);
    }
    throw error;
  }
};

export = {
  ui_bootstrap: withApiLogging('ui_bootstrap', ({ homey }: ApiContext) => (
    buildSettingsUiBootstrap({ homey })
  )),
  ui_devices: withApiLogging('ui_devices', ({ homey }: ApiContext) => (
    getSettingsUiDevicesPayload({ homey })
  )),
  ui_plan: withApiLogging('ui_plan', ({ homey }: ApiContext) => (
    getSettingsUiPlanPayload({ homey })
  )),
  ui_homes: withApiLogging('ui_homes', ({ homey }: ApiContext) => (
    getSettingsUiHomesPayload({ homey })
  )),
  ui_homes_save: withApiLogging('ui_homes_save', ({ homey, body }: ApiContext & { body?: unknown }) => (
    saveSettingsUiHomesConfig({ homey, body })
  )),
  ui_power: withApiLogging('ui_power', ({ homey }: ApiContext) => (
    getSettingsUiPowerPayload({ homey })
  )),
  ui_prices: withApiLogging('ui_prices', ({ homey }: ApiContext) => (
    getSettingsUiPricesPayload({ homey })
  )),
  ui_device_diagnostics: withApiLogging('ui_device_diagnostics', ({ homey }: ApiContext) => (
    getSettingsUiDeviceDiagnosticsPayload({ homey })
  )),
  ui_device_log: withApiLogging('ui_device_log', ({ homey }: ApiContext) => (
    getSettingsUiDeviceLogPayload({ homey })
  )),
  ui_deferred_objective_history: withApiLogging('ui_deferred_objective_history', ({ homey }: ApiContext) => (
    getSettingsUiDeferredObjectivePlanHistoryPayload({ homey })
  )),
  ui_deferred_objective_settings: withApiLogging('ui_deferred_objective_settings', ({ homey }: ApiContext) => (
    getSettingsUiDeferredObjectiveSettingsPayload({ homey })
  )),
  get_daily_budget: withApiLogging('get_daily_budget', ({ homey }: ApiContext): DailyBudgetUiPayload | null => {
    const app = getApp(homey);
    if (!app?.getDailyBudgetUiPayload) return null;
    return app.getDailyBudgetUiPayload();
  }),
  ui_weather_advisor_readout: withApiLogging('ui_weather_advisor_readout', ({ homey }: ApiContext) => (
    getSettingsUiWeatherAdvisorReadout({ homey })
  )),
  ui_recompute_daily_budget: withApiLogging('ui_recompute_daily_budget', ({ homey }: ApiContext) => (
    recomputeSettingsUiDailyBudget({ homey })
  )),
  ui_preview_daily_budget_model: withApiLogging(
    'ui_preview_daily_budget_model',
    ({ homey, body }: ApiContext & { body?: unknown }): DailyBudgetModelPreviewResponse | null => (
      previewSettingsUiDailyBudgetModel({ homey, body })
    ),
  ),
  ui_apply_daily_budget_model: withApiLogging(
    'ui_apply_daily_budget_model',
    ({ homey, body }: ApiContext & { body?: unknown }): DailyBudgetUiPayload | null => (
      applySettingsUiDailyBudgetModel({ homey, body })
    ),
  ),
  homey_devices: withApiLogging('homey_devices', async (
    { homey }: ApiContext,
  ): Promise<Array<{ id: string; name: string; class?: string; hasTemperature: boolean; hasPower: boolean }>> => {
    const app = getApp(homey);
    if (!app) return [];
    const devices = await getHomeyDevicesForDebugFromApp(app);
    return devices
      .filter(hasDeviceId)
      .map((device) => {
        const deviceClass = typeof device.class === 'string' ? device.class : undefined;
        return {
          id: device.id,
          name: device.name,
          class: deviceClass,
          // Whether the device exposes a bare measure_temperature capability —
          // lets the Weather insight pickers filter to temperature devices.
          // Array.isArray-guarded (matching the runtime's other capability checks)
          // since `device` crosses the SDK boundary and types aren't guaranteed.
          hasTemperature: Array.isArray(device.capabilities)
            && device.capabilities.includes('measure_temperature'),
          // Whether the runtime considers the device power-capable
          // (measure_power or meter_power — same predicate as managerParse) —
          // lets the whole-home meter picker filter to power-reporting devices.
          hasPower: Array.isArray(device.capabilities)
            && hasPowerCapability(device.capabilities.filter((cap): cap is string => typeof cap === 'string')),
        };
      });
  }),
  // Backs both whole-home meter pickers: the meters the Homey Energy live report
  // actually exposes (the same seam a selection is read against), so every pick
  // is guaranteed readable — unlike a capability/class filter over the device list.
  homey_energy_meters: withApiLogging('homey_energy_meters', async (
    { homey }: ApiContext,
  ): Promise<HomeyEnergyMeterEntry[]> => {
    const app = getApp(homey);
    return app ? getHomeyEnergyMetersFromApp(app) : [];
  }),
  ui_refresh_devices: withApiLogging('ui_refresh_devices', ({ homey }: ApiContext) => (
    refreshSettingsUiDevices({ homey })
  )),
  ui_refresh_prices: withApiLogging('ui_refresh_prices', ({ homey }: ApiContext) => (
    refreshSettingsUiPrices({ homey })
  )),
  ui_refresh_grid_tariff: withApiLogging('ui_refresh_grid_tariff', ({ homey }: ApiContext) => (
    refreshSettingsUiGridTariff({ homey })
  )),
  settings_ui_log: withApiLogging('settings_ui_log', ({ homey, body }: ApiContext & { body?: unknown }) => (
    logSettingsUiMessage({ homey, body })
  )),
  ui_reset_power_stats: withApiLogging('ui_reset_power_stats', ({ homey }: ApiContext) => (
    resetSettingsUiPowerStats({ homey })
  )),
  ui_starvation_rescue_devices: withApiLogging('ui_starvation_rescue_devices', ({ homey }: ApiContext) => (
    getSettingsUiStarvationRescueDevices({ homey })
  )),
  ui_starvation_rescue_preview: withApiLogging(
    'ui_starvation_rescue_preview',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      previewSettingsUiStarvationRescue({ homey, body })
    ),
  ),
  ui_starvation_rescue_create: withApiLogging(
    'ui_starvation_rescue_create',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      createSettingsUiStarvationRescue({ homey, body })
    ),
  ),
  ui_smart_task_preview: withApiLogging(
    'ui_smart_task_preview',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      previewSettingsUiSmartTask({ homey, body })
    ),
  ),
  ui_smart_task_update: withApiLogging(
    'ui_smart_task_update',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      updateSettingsUiSmartTask({ homey, body })
    ),
  ),
  ui_smart_task_cancel: withApiLogging(
    'ui_smart_task_cancel',
    ({ homey, body }: ApiContext & { body?: unknown }) => (
      cancelSettingsUiSmartTask({ homey, body })
    ),
  ),
  log_homey_device: withApiLogging('log_homey_device', async (
    { homey, body }: ApiContext & { body?: { id?: string } },
  ): Promise<{ ok: boolean; error?: string }> => {
    const app = getApp(homey);
    if (!app) {
      return { ok: false, error: 'LOGGING_NOT_AVAILABLE' };
    }
    const deviceId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!deviceId) {
      app?.error?.('Homey device log API called without valid device id');
      return { ok: false, error: 'INVALID_DEVICE_ID' };
    }
    const ok = await logHomeyDeviceForDebugFromApp({ app, deviceId });
    if (!ok) {
      return { ok: false, error: 'DEVICE_NOT_FOUND' };
    }
    return { ok: true };
  }),
};
