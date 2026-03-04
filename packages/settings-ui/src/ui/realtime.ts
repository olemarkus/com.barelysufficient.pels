import { panels, tabs } from './dom';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DEBUG_LOGGING_TOPICS,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  NORWAY_PRICE_MODEL,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_SCHEME,
} from '../../../contracts/src/settingsKeys';
import { getTargetDevices, renderDevices } from './devices';
import { loadAdvancedSettings, loadCapacitySettings, loadStaleDataStatus } from './capacity';
import {
  getHomeyClient,
  invalidateApiCache,
  invalidateSettingCache,
  primeApiCache,
} from './homey';
import {
  loadModeAndPriorities,
  refreshActiveMode,
  renderPriorities,
} from './modes';
import { refreshPrices, loadPriceSettings } from './prices';
import { renderPriceOptimization } from './priceOptimization';
import {
  loadDailyBudgetSettings,
  refreshDailyBudgetPlan,
} from './dailyBudget';
import { loadDailyBudgetTuningSettings } from './dailyBudgetTuning';
import { refreshPlan, renderPlan, type PlanSnapshot } from './plan';
import { loadShedBehaviors } from './deviceDetail';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power';
import { state } from './state';
import { logSettingsError } from './logging';

const DAILY_BUDGET_REFRESH_KEYS = new Set([
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
  'daily_budget_reset',
  COMBINED_PRICES,
  PRICE_OPTIMIZATION_ENABLED,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
]);

const DAILY_BUDGET_SETTINGS_KEYS = new Set([
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
]);

const DAILY_BUDGET_TUNING_KEYS = new Set([
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
]);

const CAPACITY_SETTINGS_KEYS = new Set([CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_DRY_RUN]);
const ADVANCED_SETTINGS_KEYS = new Set([DEBUG_LOGGING_TOPICS, 'debug_logging_enabled', EXPERIMENTAL_EV_SUPPORT_ENABLED]);

const PRICE_REFRESH_KEYS = new Set([
  COMBINED_PRICES,
  'electricity_prices',
  'flow_prices_today',
  'flow_prices_tomorrow',
  'homey_prices_today',
  'homey_prices_tomorrow',
  'homey_prices_currency',
  'nettleie_data',
]);

const DEVICE_CONTROL_KEYS = new Set(['managed_devices', 'controllable_devices']);
const PLAN_REFRESH_KEYS = new Set(['capacity_priorities', 'mode_device_targets', OPERATING_MODE_SETTING]);

const runLoggedTask = (task: Promise<unknown>, message: string, context: string) => {
  task.catch((error) => {
    void logSettingsError(message, error, context);
  });
};

const isPanelVisible = (selector: string): boolean => {
  const panel = document.querySelector(selector);
  return Boolean(panel && !panel.classList.contains('hidden'));
};

export const refreshPlanForUi = (context: string) => {
  invalidateApiCache(SETTINGS_UI_PLAN_PATH);
  runLoggedTask(refreshPlan(), 'Failed to refresh plan', context);
};

const refreshPricesIfVisible = (context: string) => {
  if (!isPanelVisible('#price-panel')) return;
  runLoggedTask(refreshPrices(), 'Failed to refresh prices', context);
};

const refreshDailyBudgetIfVisible = (context: string) => {
  if (!isPanelVisible('#budget-panel')) return;
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', context);
};

const refreshStaleDataStatus = (context: string) => {
  runLoggedTask(loadStaleDataStatus(), 'Failed to refresh stale data status', context);
};

export const refreshPowerData = async () => {
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
};

const refreshPowerDataIfVisible = (context: string) => {
  if (!isPanelVisible('#usage-panel')) return;
  runLoggedTask(refreshPowerData(), 'Failed to refresh power data', context);
};

const renderLatestDevices = (devices: Awaited<ReturnType<typeof getTargetDevices>>) => {
  state.latestDevices = devices;
  renderPriorities(devices);
  renderDevices(devices);
  renderPriceOptimization(devices);
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices } }));
};

const refreshDevicesForUi = () => {
  invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
  getTargetDevices()
    .then((devices) => renderLatestDevices(devices))
    .catch((error) => {
      void logSettingsError('Failed to refresh devices', error, 'settings.set');
    });
};

const refreshModeAndDeviceControls = () => {
  loadModeAndPriorities()
    .then(() => {
      renderPriorities(state.latestDevices);
      renderDevices(state.latestDevices);
      renderPriceOptimization(state.latestDevices);
    })
    .catch((error) => {
      void logSettingsError('Failed to load device control settings', error, 'settings.set');
    });
};

const refreshDailyBudgetSettings = (key: string) => {
  if (!DAILY_BUDGET_REFRESH_KEYS.has(key)) return;
  if (DAILY_BUDGET_SETTINGS_KEYS.has(key)) {
    runLoggedTask(loadDailyBudgetSettings(), 'Failed to load daily budget settings', 'settings.set');
  }
  if (DAILY_BUDGET_TUNING_KEYS.has(key)) {
    runLoggedTask(loadDailyBudgetTuningSettings(), 'Failed to load daily budget tuning', 'settings.set');
  }
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'settings.set');
};

const refreshPriceSettings = (key: string) => {
  if (PRICE_REFRESH_KEYS.has(key)) {
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    refreshPricesIfVisible('settings.set');
  }
  if (key !== PRICE_SCHEME && key !== NORWAY_PRICE_MODEL) return;
  runLoggedTask(loadPriceSettings(), 'Failed to load price settings', 'settings.set');
  refreshPricesIfVisible('settings.set');
};

const refreshPowerSettings = (key: string) => {
  if (key === 'power_tracker_state') {
    invalidateApiCache(SETTINGS_UI_POWER_PATH);
    runLoggedTask(refreshPowerData(), 'Failed to refresh power data', 'settings.set');
    refreshStaleDataStatus('settings.set');
    refreshDailyBudgetIfVisible('settings.set');
    return;
  }
  if (key !== 'pels_status' && key !== 'app_heartbeat') return;
  invalidateApiCache(SETTINGS_UI_POWER_PATH);
  refreshStaleDataStatus('settings.set');
};

const createSettingsSetHandler = () => (key: string) => {
  invalidateSettingCache(key);

  if (CAPACITY_SETTINGS_KEYS.has(key)) {
    runLoggedTask(loadCapacitySettings(), 'Failed to load capacity settings', 'settings.set');
  }
  if (ADVANCED_SETTINGS_KEYS.has(key)) {
    runLoggedTask(loadAdvancedSettings(), 'Failed to load advanced settings', 'settings.set');
  }
  if (key === 'device_plan_snapshot') {
    refreshPlanForUi('settings.set');
  }
  if (key === 'target_devices_snapshot') {
    refreshDevicesForUi();
  }
  if (key === OPERATING_MODE_SETTING) {
    runLoggedTask(refreshActiveMode(), 'Failed to refresh active mode', 'settings.set');
  }
  if (PLAN_REFRESH_KEYS.has(key) || DEVICE_CONTROL_KEYS.has(key)) {
    refreshPlanForUi('settings.set');
  }
  if (key === OVERSHOOT_BEHAVIORS) {
    runLoggedTask(loadShedBehaviors(), 'Failed to load shed behaviors', 'settings.set');
  }
  if (DEVICE_CONTROL_KEYS.has(key)) {
    refreshModeAndDeviceControls();
  }

  refreshPriceSettings(key);
  refreshPowerSettings(key);
  refreshDailyBudgetSettings(key);
};

const handlePlanUpdated = (plan: unknown) => {
  primeApiCache(SETTINGS_UI_PLAN_PATH, { plan });
  if (!isPanelVisible('#overview-panel')) return;
  renderPlan(plan as PlanSnapshot | null);
};

const handlePricesUpdated = () => {
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  refreshPricesIfVisible('realtime prices_updated');
};

const handlePowerUpdated = (power: unknown) => {
  primeApiCache(SETTINGS_UI_POWER_PATH, power as SettingsUiPowerPayload);
  refreshStaleDataStatus('realtime power_updated');
  refreshPowerDataIfVisible('realtime power_updated');
};

export const showTab = (tabId: string) => {
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
  });
  if (tabId === 'overview') {
    refreshPlanForUi('showTab');
  }
  if (tabId === 'price') {
    runLoggedTask(refreshPrices(), 'Failed to refresh prices', 'showTab');
  }
  if (tabId === 'usage') {
    runLoggedTask(refreshPowerData(), 'Failed to refresh power data', 'showTab');
  }
  if (tabId === 'budget') {
    runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'showTab');
  }
};

export const initRealtimeListeners = () => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;

  homey.on('plan_updated', handlePlanUpdated);
  homey.on('prices_updated', handlePricesUpdated);
  homey.on('power_updated', handlePowerUpdated);
  homey.on('settings.set', createSettingsSetHandler());
};

export const startStaleDataRefreshInterval = () => {
  setInterval(() => {
    invalidateApiCache(SETTINGS_UI_POWER_PATH);
    refreshStaleDataStatus('staleDataInterval');
  }, 30 * 1000);
};
