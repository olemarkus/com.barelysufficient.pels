import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_LOG_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_DEVICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  SETTINGS_UI_REFRESH_PRICES_PATH,
  SETTINGS_UI_RESET_POWER_STATS_PATH,
} from '../../../contracts/src/settingsUiApi';
import type { HomeySettingsClient } from '../../src/ui/homey';

const appManifest = require('../../../../app.json');

const HOMEY_DEVICES_PATH = '/homey_devices';
const DAILY_BUDGET_PATH = '/daily_budget';
const LOG_HOMEY_DEVICE_PATH = '/log_homey_device';

const DEFAULT_TIMEZONE = 'UTC';

const BOOTSTRAP_SETTING_KEYS = [
  'capacity_limit_kw',
  'capacity_margin_kw',
  'capacity_dry_run',
  'capacity_priorities',
  'mode_device_targets',
  'operating_mode',
  'controllable_devices',
  'managed_devices',
  'budget_exempt_devices',
  'mode_aliases',
  'overshoot_behaviors',
  'price_optimization_settings',
  'price_optimization_enabled',
  'price_scheme',
  'norway_price_model',
  'price_area',
  'provider_surcharge',
  'price_threshold_percent',
  'price_min_diff_ore',
  'nettleie_fylke',
  'nettleie_orgnr',
  'nettleie_tariffgruppe',
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
  'daily_budget_controlled_weight',
  'daily_budget_price_flex_share',
  'daily_budget_breakdown_enabled',
  'debug_logging_topics',
  'debug_logging_enabled',
];

const ALLOWED_HOMEY_API_ROUTES = new Set(
  Object.values(appManifest.api as Record<string, { method?: string; path?: string }>)
    .map((entry) => `${entry.method} ${entry.path}`),
);

export type HomeyApiMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

export type MockHomeyUiState = {
  dailyBudget?: unknown;
  deviceDiagnostics?: unknown;
  homeyDevices?: unknown;
  plan?: unknown;
  power?: unknown;
};

export type MockHomeyApiContext = {
  body: unknown;
  homey: MockHomeyClient;
  method: HomeyApiMethod;
  uri: string;
};

export type MockHomeyApiHandler = (context: MockHomeyApiContext) => Promise<unknown> | unknown;
type MockHomeyApiHandlerFactory = (homey: MockHomeyClient) => MockHomeyApiHandler;

export type CreateHomeyMockOptions = {
  apiHandlers?: Partial<Record<string, MockHomeyApiHandler>>;
  settings?: Record<string, unknown>;
  timeZone?: string;
  uiState?: MockHomeyUiState;
};

export type MockHomeyClient = HomeySettingsClient & {
  __listeners: Record<string, Array<(...args: unknown[]) => void>>;
  __settingsStore: Record<string, unknown>;
  __uiState: MockHomeyUiState;
  api: jest.Mock;
  get: jest.Mock;
  i18n: {
    getTimezone: () => string;
  };
  on: jest.Mock;
  ready: jest.Mock;
  set: jest.Mock;
};

const buildRouteKey = (method: string, uri: string) => `${method} ${uri}`;

const buildHomeyApi404 = (method: string, uri: string) => (
  new Error(`Cannot ${method} /api/app/com.barelysufficient.pels${uri}`)
);

const getHomeySetting = async (homey: MockHomeyClient, key: string): Promise<unknown> => new Promise((resolve, reject) => {
  homey.get(key, (err: Error | null, value?: unknown) => {
    if (err) {
      reject(err);
      return;
    }
    resolve(value);
  });
});

const getUiOverride = (homey: MockHomeyClient, key: keyof MockHomeyUiState): unknown => {
  const uiState = homey.__uiState;
  if (!uiState || !Object.prototype.hasOwnProperty.call(uiState, key)) return undefined;
  return uiState[key];
};

const buildEmptyDiagnosticsPayload = () => ({
  generatedAt: Date.now(),
  windowDays: 21,
  diagnosticsByDeviceId: {},
});

const buildUiPlan = async (homey: MockHomeyClient) => {
  const override = getUiOverride(homey, 'plan');
  if (override !== undefined) return override;
  return await getHomeySetting(homey, 'device_plan_snapshot') || null;
};

const buildUiPower = async (homey: MockHomeyClient) => {
  const override = getUiOverride(homey, 'power');
  if (override !== undefined) return override;
  return {
    tracker: await getHomeySetting(homey, 'power_tracker_state') || null,
    status: await getHomeySetting(homey, 'pels_status') || null,
    heartbeat: await getHomeySetting(homey, 'app_heartbeat') || null,
  };
};

const buildUiPrices = async (homey: MockHomeyClient) => ({
  combinedPrices: await getHomeySetting(homey, 'combined_prices') || null,
  electricityPrices: await getHomeySetting(homey, 'electricity_prices') || null,
  priceArea: await getHomeySetting(homey, 'price_area') || null,
  gridTariffData: await getHomeySetting(homey, 'nettleie_data') || null,
  flowToday: await getHomeySetting(homey, 'flow_prices_today') || null,
  flowTomorrow: await getHomeySetting(homey, 'flow_prices_tomorrow') || null,
  homeyCurrency: await getHomeySetting(homey, 'homey_prices_currency') || null,
  homeyToday: await getHomeySetting(homey, 'homey_prices_today') || null,
  homeyTomorrow: await getHomeySetting(homey, 'homey_prices_tomorrow') || null,
});

const buildUiDiagnostics = async (homey: MockHomeyClient) => {
  const override = getUiOverride(homey, 'deviceDiagnostics');
  if (override !== undefined) return override;
  return buildEmptyDiagnosticsPayload();
};

const buildUiBootstrap = async (homey: MockHomeyClient) => ({
  settings: Object.fromEntries(await Promise.all(
    BOOTSTRAP_SETTING_KEYS.map(async (key) => [key, await getHomeySetting(homey, key)]),
  )),
  dailyBudget: getUiOverride(homey, 'dailyBudget') ?? null,
  devices: await getHomeySetting(homey, 'target_devices_snapshot') || [],
  plan: await buildUiPlan(homey),
  power: await buildUiPower(homey),
  prices: await buildUiPrices(homey),
});

const DEFAULT_HOMEY_API_HANDLER_FACTORIES: Record<string, MockHomeyApiHandlerFactory> = {
  [buildRouteKey('GET', SETTINGS_UI_BOOTSTRAP_PATH)]: (homey) => async () => buildUiBootstrap(homey),
  [buildRouteKey('GET', SETTINGS_UI_DEVICES_PATH)]: (homey) => async () => ({
    devices: await getHomeySetting(homey, 'target_devices_snapshot') || [],
  }),
  [buildRouteKey('GET', SETTINGS_UI_PLAN_PATH)]: (homey) => async () => ({
    plan: await buildUiPlan(homey),
  }),
  [buildRouteKey('GET', SETTINGS_UI_POWER_PATH)]: (homey) => async () => buildUiPower(homey),
  [buildRouteKey('GET', SETTINGS_UI_PRICES_PATH)]: (homey) => async () => buildUiPrices(homey),
  [buildRouteKey('GET', SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH)]: (homey) => async () => buildUiDiagnostics(homey),
  [buildRouteKey('GET', DAILY_BUDGET_PATH)]: (homey) => async () => getUiOverride(homey, 'dailyBudget') ?? null,
  [buildRouteKey('GET', HOMEY_DEVICES_PATH)]: (homey) => async () => getUiOverride(homey, 'homeyDevices') ?? [],
  [buildRouteKey('POST', SETTINGS_UI_REFRESH_DEVICES_PATH)]: (homey) => async () => ({
    devices: await getHomeySetting(homey, 'target_devices_snapshot') || [],
  }),
  [buildRouteKey('POST', SETTINGS_UI_REFRESH_PRICES_PATH)]: (homey) => async () => buildUiPrices(homey),
  [buildRouteKey('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH)]: (homey) => async () => buildUiPrices(homey),
  [buildRouteKey('POST', SETTINGS_UI_LOG_PATH)]: () => async () => ({ ok: true }),
  [buildRouteKey('POST', SETTINGS_UI_RESET_POWER_STATS_PATH)]: (homey) => async () => ({
    power: await buildUiPower(homey),
    dailyBudget: getUiOverride(homey, 'dailyBudget') ?? null,
  }),
  [buildRouteKey('POST', LOG_HOMEY_DEVICE_PATH)]: () => async () => ({ ok: true }),
};

const buildDefaultApiHandlers = (homey: MockHomeyClient): Record<string, MockHomeyApiHandler> => (
  Object.fromEntries(
    Object.entries(DEFAULT_HOMEY_API_HANDLER_FACTORIES).map(([routeKey, buildHandler]) => [routeKey, buildHandler(homey)]),
  )
);

export const isDeclaredHomeyApiRoute = (method: string, uri: string): boolean => (
  ALLOWED_HOMEY_API_ROUTES.has(buildRouteKey(method, uri))
);

export const getUnhandledDeclaredHomeyApiRoutes = (): string[] => (
  [...ALLOWED_HOMEY_API_ROUTES].filter((routeKey) => !Object.prototype.hasOwnProperty.call(DEFAULT_HOMEY_API_HANDLER_FACTORIES, routeKey))
);

export const buildHomeyApiMock = (
  homey: MockHomeyClient,
  apiHandlers: Partial<Record<string, MockHomeyApiHandler>> = {},
): jest.Mock => {
  const handlers = {
    ...buildDefaultApiHandlers(homey),
    ...apiHandlers,
  };

  return jest.fn((method, uri, bodyOrCallback, cb) => {
  const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
  const body = typeof bodyOrCallback === 'function' ? undefined : bodyOrCallback;
  if (!callback) return;

  void (async () => {
    if (!isDeclaredHomeyApiRoute(method, uri)) {
      callback(buildHomeyApi404(method, uri));
      return;
    }

    const handler = handlers[buildRouteKey(method, uri)];

    if (!handler) {
      callback(new Error(`No Homey API mock configured for ${method} ${uri}`));
      return;
    }

    callback(null, await handler({
      body,
      homey,
      method,
      uri,
    }));
  })().catch((error) => {
    callback(error instanceof Error ? error : new Error(String(error)));
  });
  });
};

export const createHomeyMock = (options: CreateHomeyMockOptions = {}): MockHomeyClient => {
  const settingsStore = { ...(options.settings ?? {}) };
  const uiState = { ...(options.uiState ?? {}) };
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const timeZone = options.timeZone ?? DEFAULT_TIMEZONE;

  const homey = {
    __listeners: listeners,
    __settingsStore: settingsStore,
    __uiState: uiState,
    ready: jest.fn().mockResolvedValue(undefined),
    get: jest.fn((key: string, cb: (err: Error | null, value?: unknown) => void) => {
      if (Object.prototype.hasOwnProperty.call(settingsStore, key)) {
        cb(null, settingsStore[key]);
        return;
      }
      cb(null, null);
    }),
    set: jest.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      settingsStore[key] = value;
      cb?.(null);
    }),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    clock: {
      getTimezone: () => timeZone,
    },
    i18n: {
      getTimezone: () => timeZone,
    },
  } as MockHomeyClient;

  homey.api = buildHomeyApiMock(homey, options.apiHandlers);
  return homey;
};

export const installHomeyMock = (options: CreateHomeyMockOptions = {}): MockHomeyClient => {
  const homey = createHomeyMock(options);
  (globalThis as { Homey?: MockHomeyClient }).Homey = homey;
  if (typeof window !== 'undefined') {
    (window as Window & { Homey?: MockHomeyClient }).Homey = homey;
  }
  return homey;
};

export const emitHomeyEvent = (homey: MockHomeyClient, event: string, ...args: unknown[]) => {
  const listeners = homey.__listeners[event] || [];
  listeners.forEach((listener) => {
    listener(...args);
  });
};
