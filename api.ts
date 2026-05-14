import type Homey from 'homey';
import type { DailyBudgetModelPreviewResponse, DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import type { HomeyDeviceLike } from './lib/utils/types';
import { getHomeyDevicesForDebugFromApp, logHomeyDeviceForDebugFromApp } from './lib/app/appDebugHelpers';
import {
  buildSettingsUiBootstrap,
  getSettingsUiDeferredObjectivePlanHistoryPayload,
  getSettingsUiDeviceDiagnosticsPayload,
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
} from './lib/app/settingsUiApi';

type ApiContext = {
  homey: Homey.App['homey'];
};

type DailyBudgetApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
  recomputeDailyBudgetToday?: () => DailyBudgetUiPayload | null;
};

const hasDeviceId = (device: HomeyDeviceLike): device is HomeyDeviceLike & { id: string } => (
  typeof device.id === 'string'
);

const getApp = (homey: Homey.App['homey']): DailyBudgetApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as DailyBudgetApp;
};

// Wrap an async API handler so any thrown error is logged via `app.error`
// before the rejection propagates to the Homey API transport. Without this,
// handler exceptions become opaque "Network request failed" responses on the
// client and never reach `/tmp/pels`, leaving the failure undiagnosable.
//
// During app restart `homey.app` may not be wired yet; fall back to
// `console.error` so the cause still lands in the app's stderr log instead of
// disappearing because no logger was reachable.
const withApiLogging = <Ctx extends ApiContext, R>(
  name: string,
  handler: (ctx: Ctx) => Promise<R> | R,
) => async (ctx: Ctx): Promise<R> => {
  try {
    return await handler(ctx);
  } catch (error) {
    const app = getApp(ctx.homey);
    if (app?.error) app.error(`api ${name} failed`, error as Error);
    else console.error(`api ${name} failed`, error);
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
  ui_power: withApiLogging('ui_power', ({ homey }: ApiContext) => (
    getSettingsUiPowerPayload({ homey })
  )),
  ui_prices: withApiLogging('ui_prices', ({ homey }: ApiContext) => (
    getSettingsUiPricesPayload({ homey })
  )),
  ui_device_diagnostics: withApiLogging('ui_device_diagnostics', ({ homey }: ApiContext) => (
    getSettingsUiDeviceDiagnosticsPayload({ homey })
  )),
  ui_deferred_objective_history: withApiLogging('ui_deferred_objective_history', ({ homey }: ApiContext) => (
    getSettingsUiDeferredObjectivePlanHistoryPayload({ homey })
  )),
  get_daily_budget: withApiLogging('get_daily_budget', ({ homey }: ApiContext): DailyBudgetUiPayload | null => {
    const app = getApp(homey);
    if (!app?.getDailyBudgetUiPayload) return null;
    return app.getDailyBudgetUiPayload();
  }),
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
  ): Promise<Array<{ id: string; name: string; class?: string }>> => {
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
        };
      });
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
