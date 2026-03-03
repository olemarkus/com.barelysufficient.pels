import type Homey from 'homey';
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../utils/settingsUiBootstrapKeys';
import type {
  SettingsUiBootstrap,
  SettingsUiDevicesPayload,
  SettingsUiLogRequest,
  SettingsUiPlanPayload,
  SettingsUiPlanSnapshot,
  SettingsUiPowerPayload,
  SettingsUiPricesPayload,
  SettingsUiResetPowerStatsResponse,
} from '../../packages/contracts/src/settingsUiApi';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  getLatestDevicesForUiFromApp,
  getPlanSnapshotForUiFromHomey,
  getPowerTrackerForUiFromApp,
  refreshSettingsUiDevicesForApp,
  refreshSettingsUiGridTariffForApp,
  refreshSettingsUiPricesForApp,
  resetSettingsUiPowerStatsForApp,
} from './settingsUiAppRuntime';

type SettingsUiApiApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
};

type ApiContext = {
  homey: Homey.App['homey'];
};

const getApp = (homey: Homey.App['homey']): SettingsUiApiApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SettingsUiApiApp;
};

const pickSettings = (
  homey: Homey.App['homey'],
  keys: readonly string[],
): Record<string, unknown> => Object.fromEntries(
  keys.map((key) => [key, homey.settings.get(key) as unknown]),
);

const formatSettingsUiMessage = (entry: SettingsUiLogRequest) => {
  const context = entry.context ? ` (${entry.context})` : '';
  const detail = entry.detail ? ` - ${entry.detail}` : '';
  return `Settings UI${context}: ${entry.message}${detail}`;
};

const isValidLogRequest = (value: unknown): value is SettingsUiLogRequest => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SettingsUiLogRequest>;
  return typeof entry.level === 'string' && typeof entry.message === 'string';
};

const getArraySetting = <T>(homey: Homey.App['homey'], key: string): T[] => {
  const value = homey.settings.get(key) as unknown;
  return Array.isArray(value) ? value as T[] : [];
};

const getSettingsUiDevices = ({ homey }: ApiContext): TargetDeviceSnapshot[] => {
  return getLatestDevicesForUiFromApp(homey) ?? getArraySetting<TargetDeviceSnapshot>(homey, 'target_devices_snapshot');
};

const getSettingsUiPlan = ({ homey }: ApiContext): SettingsUiPlanSnapshot | null => (
  getPlanSnapshotForUiFromHomey(homey)
);

const getSettingsUiPower = ({ homey }: ApiContext): SettingsUiPowerPayload => {
  const tracker = getPowerTrackerForUiFromApp(homey) ?? homey.settings.get('power_tracker_state') as PowerTrackerState | null;
  const status = homey.settings.get('pels_status') as { lastPowerUpdate?: number | null; priceLevel?: string | null } | null;
  const heartbeat = homey.settings.get('app_heartbeat') as unknown;
  return {
    tracker: tracker && typeof tracker === 'object' ? tracker : null,
    status: status && typeof status === 'object' ? status : null,
    heartbeat: typeof heartbeat === 'number' ? heartbeat : null,
  };
};

const getSettingsUiPrices = ({ homey }: ApiContext): SettingsUiPricesPayload => {
  const priceArea = homey.settings.get('price_area') as unknown;
  const homeyCurrency = homey.settings.get('homey_prices_currency') as unknown;
  return {
    combinedPrices: homey.settings.get('combined_prices') as unknown ?? null,
    electricityPrices: homey.settings.get('electricity_prices') as unknown ?? null,
    priceArea: typeof priceArea === 'string' ? priceArea : null,
    gridTariffData: homey.settings.get('nettleie_data') as unknown ?? null,
    flowToday: homey.settings.get('flow_prices_today') as unknown ?? null,
    flowTomorrow: homey.settings.get('flow_prices_tomorrow') as unknown ?? null,
    homeyCurrency: typeof homeyCurrency === 'string' ? homeyCurrency : null,
    homeyToday: homey.settings.get('homey_prices_today') as unknown ?? null,
    homeyTomorrow: homey.settings.get('homey_prices_tomorrow') as unknown ?? null,
  };
};

export const buildSettingsUiBootstrap = ({ homey }: ApiContext): SettingsUiBootstrap => {
  const app = getApp(homey);
  return {
    settings: pickSettings(homey, SETTINGS_UI_BOOTSTRAP_KEYS),
    dailyBudget: app?.getDailyBudgetUiPayload?.() ?? null,
    devices: getSettingsUiDevices({ homey }),
    plan: getSettingsUiPlan({ homey }),
    power: getSettingsUiPower({ homey }),
    prices: getSettingsUiPrices({ homey }),
  };
};

export const getSettingsUiDevicesPayload = ({ homey }: ApiContext): SettingsUiDevicesPayload => ({
  devices: getSettingsUiDevices({ homey }),
});

export const getSettingsUiPlanPayload = ({ homey }: ApiContext): SettingsUiPlanPayload => ({
  plan: getSettingsUiPlan({ homey }),
});

export const getSettingsUiPowerPayload = ({ homey }: ApiContext): SettingsUiPowerPayload => (
  getSettingsUiPower({ homey })
);

export const getSettingsUiPricesPayload = ({ homey }: ApiContext): SettingsUiPricesPayload => (
  getSettingsUiPrices({ homey })
);

export const refreshSettingsUiDevices = async ({ homey }: ApiContext): Promise<SettingsUiDevicesPayload> => {
  await refreshSettingsUiDevicesForApp(homey);
  return getSettingsUiDevicesPayload({ homey });
};

export const refreshSettingsUiPrices = async ({ homey }: ApiContext): Promise<SettingsUiPricesPayload> => {
  await refreshSettingsUiPricesForApp(homey);
  return getSettingsUiPricesPayload({ homey });
};

export const refreshSettingsUiGridTariff = async ({ homey }: ApiContext): Promise<SettingsUiPricesPayload> => {
  await refreshSettingsUiGridTariffForApp(homey);
  return getSettingsUiPricesPayload({ homey });
};

export const resetSettingsUiPowerStats = async ({ homey }: ApiContext): Promise<SettingsUiResetPowerStatsResponse> => {
  const app = getApp(homey);
  await resetSettingsUiPowerStatsForApp(homey);
  return {
    power: getSettingsUiPower({ homey }),
    dailyBudget: app?.getDailyBudgetUiPayload?.() ?? null,
  };
};

export const logSettingsUiMessage = ({ homey, body }: ApiContext & { body?: unknown }): { ok: boolean } => {
  const app = getApp(homey);
  if (!isValidLogRequest(body)) {
    app?.error?.('Settings UI log API called without a valid payload');
    return { ok: false };
  }

  const message = formatSettingsUiMessage(body);
  if (body.level === 'error') {
    app?.error?.(message, new Error(body.detail || body.message));
  } else if (body.level === 'warn') {
    app?.log?.(`Warning: ${message}`);
  } else {
    app?.log?.(message);
  }

  return { ok: true };
};
