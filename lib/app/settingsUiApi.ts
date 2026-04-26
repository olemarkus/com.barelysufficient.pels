import { createHash } from 'node:crypto';
import type Homey from 'homey';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiPayload,
} from '../../packages/contracts/src/dailyBudgetTypes';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../utils/settingsUiBootstrapKeys';
import type {
  SettingsUiBootstrap,
  SettingsUiDeviceDiagnosticsResponse,
  SettingsUiDevicesPayload,
  SettingsUiFeatureAccess,
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
  recomputeDailyBudgetToday?: () => DailyBudgetUiPayload | null;
  previewDailyBudgetModel?: (settings: Partial<DailyBudgetModelSettings>) => DailyBudgetModelPreviewResponse;
  applyDailyBudgetModel?: (settings: Partial<DailyBudgetModelSettings>) => DailyBudgetUiPayload | null;
  getDeviceDiagnosticsUiPayload?: () => SettingsUiDeviceDiagnosticsResponse;
};

type ApiContext = {
  homey: Homey.App['homey'];
};

const getApp = (homey: Homey.App['homey']): SettingsUiApiApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SettingsUiApiApp;
};

const DEFAULT_OVERVIEW_REDESIGN_TOGGLE_HOMEY_ID_HASHES = new Set<string>([
  '3c9207efba429629030489371722f72f8e96bff1cf8c106c304bb1f055e22a8b',
  '4e57091f5b42550e7bf53b206cf5ffa4b548b40aad7d3a1999e4ebf7677abd4b',
]);
const HOMEY_ID_LOOKUP_TIMEOUT_MS = 500;

const ALLOWED_OVERVIEW_REDESIGN_HOMEY_ID_HASHES = (() => {
  const hashes = new Set(DEFAULT_OVERVIEW_REDESIGN_TOGGLE_HOMEY_ID_HASHES);
  const raw = String(process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES ?? '');
  if (!raw.trim()) return hashes;
  raw.split(',').forEach((value) => {
    const trimmed = value.trim();
    if (trimmed) {
      hashes.add(trimmed);
    }
  });
  return hashes;
})();

const hashHomeyId = (homeyId: string): string => (
  createHash('sha256').update(homeyId).digest('hex')
);

const getHomeyIdWithTimeout = async (
  cloud: { getHomeyId: () => Promise<unknown> },
): Promise<unknown> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      cloud.getHomeyId(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), HOMEY_ID_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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

const asDailyBudgetModelSettings = (value: unknown): Partial<DailyBudgetModelSettings> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const body = value as Partial<DailyBudgetModelSettings>;
  return {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    dailyBudgetKWh: typeof body.dailyBudgetKWh === 'number' && Number.isFinite(body.dailyBudgetKWh)
      ? body.dailyBudgetKWh
      : undefined,
    priceShapingEnabled: typeof body.priceShapingEnabled === 'boolean' ? body.priceShapingEnabled : undefined,
    controlledUsageWeight: typeof body.controlledUsageWeight === 'number' && Number.isFinite(body.controlledUsageWeight)
      ? body.controlledUsageWeight
      : undefined,
    priceShapingFlexShare: typeof body.priceShapingFlexShare === 'number' && Number.isFinite(body.priceShapingFlexShare)
      ? body.priceShapingFlexShare
      : undefined,
  };
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
  const tracker = getPowerTrackerForUiFromApp(homey)
    ?? (homey.settings.get('power_tracker_state') as PowerTrackerState | null);
  const status = homey.settings.get('pels_status') as {
    headroomKw?: number;
    lastPowerUpdate?: number | null;
    priceLevel?: string | null;
    powerKnown?: boolean;
    hasLivePowerSample?: boolean;
    powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  } | null;
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

const buildEmptyDeviceDiagnosticsPayload = (): SettingsUiDeviceDiagnosticsResponse => ({
  generatedAt: Date.now(),
  windowDays: 21,
  diagnosticsByDeviceId: {},
});

const getFeatureAccess = async ({ homey }: ApiContext): Promise<SettingsUiFeatureAccess> => {
  const cloud = (homey as Homey.App['homey'] & {
    cloud?: { getHomeyId?: () => Promise<unknown> };
  }).cloud;
  const getHomeyId = cloud?.getHomeyId;
  if (typeof getHomeyId !== 'function') {
    return { canToggleOverviewRedesign: false };
  }
  try {
    const homeyId = await getHomeyIdWithTimeout({ getHomeyId: getHomeyId.bind(cloud) });
    return {
      canToggleOverviewRedesign: typeof homeyId === 'string'
        && ALLOWED_OVERVIEW_REDESIGN_HOMEY_ID_HASHES.has(hashHomeyId(homeyId)),
    };
  } catch {
    return { canToggleOverviewRedesign: false };
  }
};

export const buildSettingsUiBootstrap = async ({ homey }: ApiContext): Promise<SettingsUiBootstrap> => {
  const app = getApp(homey);
  return {
    settings: pickSettings(homey, SETTINGS_UI_BOOTSTRAP_KEYS),
    dailyBudget: app?.getDailyBudgetUiPayload?.() ?? null,
    featureAccess: await getFeatureAccess({ homey }),
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

export const getSettingsUiDeviceDiagnosticsPayload = ({ homey }: ApiContext): SettingsUiDeviceDiagnosticsResponse => {
  const app = getApp(homey);
  if (!app?.getDeviceDiagnosticsUiPayload) {
    return buildEmptyDeviceDiagnosticsPayload();
  }
  try {
    return app.getDeviceDiagnosticsUiPayload();
  } catch (error) {
    app.error?.('Device diagnostics API failed', error as Error);
    return buildEmptyDeviceDiagnosticsPayload();
  }
};

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

export const recomputeSettingsUiDailyBudget = ({ homey }: ApiContext): DailyBudgetUiPayload | null => {
  const app = getApp(homey);
  if (!app?.recomputeDailyBudgetToday) return null;
  try {
    return app.recomputeDailyBudgetToday();
  } catch (error) {
    app?.error?.('Daily budget recompute API failed', error as Error);
    throw error;
  }
};

export const previewSettingsUiDailyBudgetModel = (
  { homey, body }: ApiContext & { body?: unknown },
): DailyBudgetModelPreviewResponse | null => {
  const app = getApp(homey);
  if (!app?.previewDailyBudgetModel) return null;
  return app.previewDailyBudgetModel(asDailyBudgetModelSettings(body));
};

export const applySettingsUiDailyBudgetModel = (
  { homey, body }: ApiContext & { body?: unknown },
): DailyBudgetUiPayload | null => {
  const app = getApp(homey);
  if (!app?.applyDailyBudgetModel) return null;
  return app.applyDailyBudgetModel(asDailyBudgetModelSettings(body));
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
