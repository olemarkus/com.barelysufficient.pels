import { panels, tabListEntries, tabs, type MdTabElement } from './dom.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  BUDGET_EXEMPT_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_DRIVER_OVERRIDES,
  EV_BOOST_SETTINGS,
  NATIVE_EV_WIRING_DEVICES,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DEBUG_LOGGING_TOPICS,
  NORWAY_PRICE_MODEL,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_SCHEME,
} from '../../../contracts/src/settingsKeys.ts';
import { getTargetDevices, renderDevices } from './devices.ts';
import {
  loadAdvancedSettings,
  loadCapacitySettings,
  loadStaleDataStatus,
  updateStaleDataStatusFromPowerPayload,
} from './capacity.ts';
import {
  getHomeyClient,
  invalidateApiCache,
  invalidateSettingCache,
  primeApiCache,
  updateApiCache,
} from './homey.ts';
import {
  loadModeAndPriorities,
  refreshActiveMode,
  renderPriorities,
} from './modes.ts';
import { refreshPriceConfigView, reloadPriceConfigSettings, updatePriceConfigDevices } from './priceConfig.ts';
import { refreshDailyBudgetPlan, updateBudgetPower } from './dailyBudget.ts';
import { discardBudgetAdjust, refreshBudgetAdjust } from './budgetAdjustController.ts';
import { loadDailyBudgetTuningSettings } from './dailyBudgetTuning.ts';
import {
  parsePlanSnapshot,
  refreshPlan,
  renderPlan,
  updatePlanPower,
  updatePlanPrices,
  type PlanSnapshot,
} from './plan.ts';
import { refreshAdvancedDeviceCleanup } from './advanced.ts';
import { loadEvBoostSettings, loadShedBehaviors, loadTemperatureBoostSettings } from './deviceDetail/index.ts';
import { loadDeviceControlProfiles } from './deviceControlProfiles.ts';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power.ts';
import { state } from './state.ts';
import { logSettingsError, logSettingsWarn } from './logging.ts';
import { refreshDeadlinesList } from './deadlinesList.ts';

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

const POWER_USAGE_REALTIME_REFRESH_MIN_INTERVAL_MS = 30 * 1000;

const REDESIGN_SETTINGS_SECTIONS = new Set([
  'limits',
  'devices',
  'modes',
  'electricity-prices',
  'price-aware-devices',
  'simulation',
  'advanced',
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
const ADVANCED_SETTINGS_KEYS = new Set([
  DEBUG_LOGGING_TOPICS,
  'debug_logging_enabled',
]);

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

const DEVICE_CONTROL_KEYS = new Set([
  'managed_devices',
  'controllable_devices',
  BUDGET_EXEMPT_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  TEMPERATURE_BOOST_SETTINGS,
]);
const PLAN_REFRESH_KEYS = new Set([
  'capacity_priorities',
  'mode_device_targets',
  BUDGET_EXEMPT_DEVICES,
  OPERATING_MODE_SETTING,
]);

const runLoggedTask = (task: Promise<unknown>, message: string, context: string) => {
  task.catch((error) => {
    void logSettingsError(message, error, context);
  });
};

let lastPowerUsageRefreshStartedAt = 0;

const isPanelVisible = (selector: string): boolean => {
  const panel = document.querySelector(selector);
  return Boolean(panel && !panel.classList.contains('hidden'));
};

export const refreshPlanForUi = (context: string) => {
  invalidateApiCache(SETTINGS_UI_PLAN_PATH);
  runLoggedTask(refreshPlan(), 'Failed to refresh plan', context);
};

const refreshPricesIfVisible = (context: string) => {
  if (!isPanelVisible('#electricity-prices-panel') && !isPanelVisible('#price-aware-devices-panel')) return;
  runLoggedTask(refreshPriceConfigView(), 'Failed to refresh prices', context);
};

const refreshDailyBudgetIfVisible = (context: string) => {
  if (!isPanelVisible('#budget-panel')) return;
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', context);
};

const refreshStaleDataStatus = (context: string) => {
  runLoggedTask(loadStaleDataStatus(), 'Failed to refresh stale data status', context);
};

export const refreshPowerData = async () => {
  lastPowerUsageRefreshStartedAt = Date.now();
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
};

const refreshPowerDataIfVisible = (
  context: string,
  options: { force?: boolean; invalidateBeforeRefresh?: boolean } = {},
) => {
  if (!isPanelVisible('#usage-panel')) return;
  const now = Date.now();
  if (!options.force && now - lastPowerUsageRefreshStartedAt < POWER_USAGE_REALTIME_REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  if (options.invalidateBeforeRefresh) {
    invalidateApiCache(SETTINGS_UI_POWER_PATH);
  }
  runLoggedTask(refreshPowerData(), 'Failed to refresh power data', context);
};

const renderLatestDevices = (devices: Awaited<ReturnType<typeof getTargetDevices>>) => {
  state.latestDevices = devices;
  renderPriorities(devices);
  renderDevices(devices);
  updatePriceConfigDevices(devices);
  refreshAdvancedDeviceCleanup();
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices } }));
};

const loadDevicesOnce = () => {
  state.devicesLoading = true;
  getTargetDevices()
    .then((devices) => {
      state.devicesLoaded = true;
      renderLatestDevices(devices);
    })
    .catch((error) => {
      void logSettingsError('Failed to load devices', error, 'loadDevicesOnce');
    })
    .finally(() => {
      state.devicesLoading = false;
    });
};

const refreshDevicesForUi = () => {
  invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
  invalidateApiCache(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
  if (!state.devicesLoaded || state.devicesLoading) return;
  getTargetDevices()
    .then((devices) => renderLatestDevices(devices))
    .catch((error) => {
      void logSettingsError('Failed to refresh devices', error, 'settings.set');
    });
};

const refreshModeAndDeviceControls = () => {
  loadModeAndPriorities()
    .then(() => {
      if (!state.devicesLoaded) return;
      renderPriorities(state.latestDevices);
      renderDevices(state.latestDevices);
      updatePriceConfigDevices(state.latestDevices);
    })
    .catch((error) => {
      void logSettingsError('Failed to load device control settings', error, 'settings.set');
    });
};

const refreshDailyBudgetSettings = (key: string) => {
  if (!DAILY_BUDGET_REFRESH_KEYS.has(key)) return;
  if (DAILY_BUDGET_SETTINGS_KEYS.has(key)) {
    runLoggedTask(refreshBudgetAdjust(), 'Failed to refresh adjust draft', 'settings.set');
  }
  if (DAILY_BUDGET_TUNING_KEYS.has(key)) {
    runLoggedTask(loadDailyBudgetTuningSettings(), 'Failed to load daily budget tuning', 'settings.set');
    runLoggedTask(refreshBudgetAdjust(), 'Failed to refresh adjust draft', 'settings.set');
  }
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'settings.set');
};

const refreshPriceSettings = (key: string) => {
  if (PRICE_REFRESH_KEYS.has(key)) {
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    refreshPricesIfVisible('settings.set');
  }
  if (key !== PRICE_SCHEME && key !== NORWAY_PRICE_MODEL) return;
  runLoggedTask(reloadPriceConfigSettings(), 'Failed to reload price settings', 'settings.set');
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
  if (key !== 'pels_status') return;
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
  if (key === OPERATING_MODE_SETTING) {
    runLoggedTask(refreshActiveMode(), 'Failed to refresh active mode', 'settings.set');
  }
  if (PLAN_REFRESH_KEYS.has(key) || DEVICE_CONTROL_KEYS.has(key)) {
    refreshPlanForUi('settings.set');
  }
  if (key === OVERSHOOT_BEHAVIORS) {
    runLoggedTask(loadShedBehaviors(), 'Failed to load shed behaviors', 'settings.set');
  }
  if (key === TEMPERATURE_BOOST_SETTINGS) {
    runLoggedTask(loadTemperatureBoostSettings(), 'Failed to load temperature boost settings', 'settings.set');
  }
  if (key === EV_BOOST_SETTINGS) {
    runLoggedTask(loadEvBoostSettings(), 'Failed to load EV boost settings', 'settings.set');
  }
  if (key === DEVICE_CONTROL_PROFILES || key === DEVICE_TARGET_POWER_CONFIGS) {
    runLoggedTask(loadDeviceControlProfiles(), 'Failed to load device control profiles', 'settings.set');
  }
  if (DEVICE_CONTROL_KEYS.has(key)) {
    refreshModeAndDeviceControls();
  }

  refreshPriceSettings(key);
  refreshPowerSettings(key);
  refreshDailyBudgetSettings(key);
};

const handlePlanUpdated = (plan: unknown) => {
  const parsedPlan = parsePlanSnapshot(plan);
  if (parsedPlan === null && plan !== null && plan !== undefined) {
    void logSettingsWarn(
      'Ignoring malformed realtime plan update',
      undefined,
      'plan_updated',
    );
    return;
  }
  primeApiCache(SETTINGS_UI_PLAN_PATH, { plan: parsedPlan });
  invalidateApiCache(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
  document.dispatchEvent(new CustomEvent('plan-updated', { detail: { plan: parsedPlan } }));
  if (!isPanelVisible('#overview-panel')) return;
  renderPlan(parsedPlan as PlanSnapshot | null);
};

const handlePricesUpdated = () => {
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  refreshPricesIfVisible('realtime prices_updated');
  // The overview hero anticipation subline ("Cheapest hour ahead …") depends on
  // cached prices. Keep it in sync with realtime price updates without forcing a
  // plan re-fetch — the cached plan snapshot is still current. Skip the fetch
  // when the overview is hidden; switching to it triggers refreshPlanForUi and
  // pulls fresh prices alongside the plan.
  if (!isPanelVisible('#overview-panel')) return;
  runLoggedTask(
    updatePlanPrices(),
    'Failed to refresh overview prices',
    'realtime prices_updated',
  );
};

const handleDevicesUpdated = () => {
  refreshDevicesForUi();
};

const handlePowerUpdated = (power: unknown) => {
  const payload = power as SettingsUiPowerPayload;
  const hasFullTracker = Boolean(payload?.tracker && typeof payload.tracker === 'object');
  if (hasFullTracker) {
    primeApiCache(SETTINGS_UI_POWER_PATH, payload);
  } else {
    updateApiCache(SETTINGS_UI_POWER_PATH, {
      tracker: null,
      status: payload?.status ?? null,
      heartbeat: payload?.heartbeat ?? null,
    });
  }
  updatePlanPower(payload?.status ?? null);
  updateBudgetPower(payload?.status ?? null);
  updateStaleDataStatusFromPowerPayload(payload ?? null);
  refreshPowerDataIfVisible('realtime power_updated', {
    force: hasFullTracker,
    invalidateBeforeRefresh: !hasFullTracker,
  });
};

const DEVICE_DEPENDENT_TABS = new Set([
  'devices',
  'modes',
  'electricity-prices',
  'price-aware-devices',
  'advanced',
]);

const runTabActivationSideEffects = (tabId: string) => {
  if (tabId === 'overview') {
    document.dispatchEvent(new Event('overview-tab-activated'));
    refreshPlanForUi('showTab');
    return;
  }
  if (tabId === 'electricity-prices' || tabId === 'price-aware-devices') {
    runLoggedTask(refreshPriceConfigView(), 'Failed to refresh prices', 'showTab');
    return;
  }
  if (tabId === 'usage') {
    invalidateApiCache(SETTINGS_UI_POWER_PATH);
    runLoggedTask(refreshPowerData(), 'Failed to refresh power data', 'showTab');
    return;
  }
  if (tabId === 'budget') {
    runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'showTab');
    return;
  }
  if (tabId === 'deadlines') {
    runLoggedTask(refreshDeadlinesList(), 'Failed to load deadlines list', 'showTab');
    return;
  }
  if (tabId === 'limits' || tabId === 'simulation') {
    runLoggedTask(loadCapacitySettings(), 'Failed to load limits and simulation settings', 'showTab');
  }
};

const discardBudgetAdjustOnLeave = (nextTabId: string) => {
  if (nextTabId === 'budget') return;
  const onBudget = panels.some(
    (panel) => panel.dataset.panel === 'budget' && !panel.classList.contains('hidden'),
  );
  if (onBudget) discardBudgetAdjust();
};

export const showTab = (tabId: string) => {
  const activeTopLevelTab = REDESIGN_SETTINGS_SECTIONS.has(tabId) ? 'settings' : tabId;
  discardBudgetAdjustOnLeave(tabId);
  for (const tab of tabs) {
    const isActive = tab.dataset.tab === activeTopLevelTab;
    tab.classList.toggle('active', isActive);
    tab.toggleAttribute('active', isActive);
    (tab as MdTabElement).active = isActive;
    (tab as MdTabElement).selected = isActive;
    tab.setAttribute('aria-selected', String(isActive));
  }
  for (const { tabList, tabs: tabListTabs } of tabListEntries) {
    const tabIndex = tabListTabs
      .findIndex((tab) => tab.dataset.tab === activeTopLevelTab);
    if (tabIndex >= 0) tabList.activeTabIndex = tabIndex;
  }
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
  });
  // Notify charts so they can resize against the now-visible panel width.
  // ResizeObserver alone does not reliably fire when a parent flips from
  // `display:none` → visible, leaving SVG widths stuck at the 480 px fallback.
  document.dispatchEvent(new CustomEvent('pels:tab-shown', { detail: { tabId } }));
  runTabActivationSideEffects(tabId);
  if (DEVICE_DEPENDENT_TABS.has(tabId) && !state.devicesLoaded && !state.devicesLoading) {
    loadDevicesOnce();
  }
};

export const initRealtimeListeners = () => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;

  homey.on('plan_updated', handlePlanUpdated);
  homey.on('prices_updated', handlePricesUpdated);
  homey.on('devices_updated', handleDevicesUpdated);
  homey.on('power_updated', handlePowerUpdated);
  homey.on('settings.set', createSettingsSetHandler());

  document.addEventListener('request-load-devices', () => {
    if (!state.devicesLoaded && !state.devicesLoading) {
      loadDevicesOnce();
    }
  });
};

export const startStaleDataRefreshInterval = () => {
  setInterval(() => {
    invalidateApiCache(SETTINGS_UI_POWER_PATH);
    refreshStaleDataStatus('staleDataInterval');
    if (isPanelVisible('#overview-panel')) {
      refreshPlanForUi('periodicRefresh');
    }
  }, 30 * 1000);
};
