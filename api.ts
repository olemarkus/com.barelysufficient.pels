import type Homey from 'homey';
import type { DailyBudgetModelPreviewResponse, DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import type { HomeyDeviceLike } from './lib/utils/types';
import { getHomeyDevicesForDebugFromApp, logHomeyDeviceForDebugFromApp } from './lib/app/appDebugHelpers';
import {
  buildSettingsUiBootstrap,
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

export = {
  async ui_bootstrap({ homey }: ApiContext) {
    return buildSettingsUiBootstrap({ homey });
  },
  async ui_devices({ homey }: ApiContext) {
    return getSettingsUiDevicesPayload({ homey });
  },
  async ui_plan({ homey }: ApiContext) {
    return getSettingsUiPlanPayload({ homey });
  },
  async ui_power({ homey }: ApiContext) {
    return getSettingsUiPowerPayload({ homey });
  },
  async ui_prices({ homey }: ApiContext) {
    return getSettingsUiPricesPayload({ homey });
  },
  async ui_device_diagnostics({ homey }: ApiContext) {
    return getSettingsUiDeviceDiagnosticsPayload({ homey });
  },
  async get_daily_budget({ homey }: ApiContext): Promise<DailyBudgetUiPayload | null> {
    const app = getApp(homey);
    if (!app?.getDailyBudgetUiPayload) return null;
    try {
      return app.getDailyBudgetUiPayload();
    } catch (error) {
      app?.error?.('Daily budget API failed', error as Error);
      return null;
    }
  },
  async ui_recompute_daily_budget({ homey }: ApiContext): Promise<DailyBudgetUiPayload | null> {
    return recomputeSettingsUiDailyBudget({ homey });
  },
  async ui_preview_daily_budget_model(
    { homey, body }: ApiContext & { body?: unknown },
  ): Promise<DailyBudgetModelPreviewResponse | null> {
    return previewSettingsUiDailyBudgetModel({ homey, body });
  },
  async ui_apply_daily_budget_model(
    { homey, body }: ApiContext & { body?: unknown },
  ): Promise<DailyBudgetUiPayload | null> {
    return applySettingsUiDailyBudgetModel({ homey, body });
  },
  async homey_devices({ homey }: ApiContext): Promise<Array<{ id: string; name: string; class?: string }>> {
    const app = getApp(homey);
    if (!app) return [];
    try {
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
    } catch (error) {
      app?.error?.('Homey devices API failed', error as Error);
      return [];
    }
  },
  async ui_refresh_devices({ homey }: ApiContext) {
    return refreshSettingsUiDevices({ homey });
  },
  async ui_refresh_prices({ homey }: ApiContext) {
    return refreshSettingsUiPrices({ homey });
  },
  async ui_refresh_grid_tariff({ homey }: ApiContext) {
    return refreshSettingsUiGridTariff({ homey });
  },
  async settings_ui_log({ homey, body }: ApiContext & { body?: unknown }) {
    return logSettingsUiMessage({ homey, body });
  },
  async ui_reset_power_stats({ homey }: ApiContext) {
    return resetSettingsUiPowerStats({ homey });
  },
  async log_homey_device(
    { homey, body }: ApiContext & { body?: { id?: string } },
  ): Promise<{ ok: boolean; error?: string }> {
    const app = getApp(homey);
    if (!app) {
      return { ok: false, error: 'LOGGING_NOT_AVAILABLE' };
    }
    try {
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
    } catch (error) {
      app?.error?.('Homey device log API failed', error as Error);
      return { ok: false, error: 'INTERNAL_ERROR' };
    }
  },
};
