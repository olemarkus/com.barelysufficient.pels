import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import { getTargetDevices, renderDevices } from './devices.ts';
import { loadStaleDataStatus } from './capacity.ts';
import { refreshHomeBadges } from './homeBadges.ts';
import { invalidateApiCache, invalidateApiCacheForAllHomes } from './homey.ts';
import { loadModeAndPriorities, renderPriorities } from './modes.ts';
import { refreshPriceConfigView, updatePriceConfigDevices } from './priceConfig.ts';
import { refreshDailyBudgetPlan } from './dailyBudget.ts';
import { refreshPlan } from './plan.ts';
import { refreshAdvancedDeviceCleanup } from './advanced.ts';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power.ts';
import { state } from './state.ts';
import { logSettingsError } from './logging.ts';

/**
 * The refresh actions the settings-UI shell's three drivers — the realtime
 * event handlers, the tab-activation hooks, and the `settings.set` router —
 * all invoke. They live here rather than in `realtime.ts` so those three
 * modules can be separate without importing each other in a cycle.
 *
 * Panel-visibility gating stays with the action (not the caller): a refresh
 * that paints a hidden panel is pure cost, and the tab-activation path fetches
 * on open anyway.
 */

const POWER_USAGE_REALTIME_REFRESH_MIN_INTERVAL_MS = 30 * 1000;

let lastPowerUsageRefreshStartedAt = 0;

/** Run a fire-and-forget task, routing any rejection to the app log. */
export const runLoggedTask = (task: Promise<unknown>, message: string, context: string) => {
  task.catch((error) => {
    void logSettingsError(message, error, context);
  });
};

export const isPanelVisible = (selector: string): boolean => {
  const panel = document.querySelector(selector);
  return Boolean(panel && !panel.classList.contains('hidden'));
};

export const refreshPlanForUi = (context: string) => {
  invalidateApiCacheForAllHomes(SETTINGS_UI_PLAN_PATH);
  runLoggedTask(refreshPlan(), 'Failed to refresh plan', context);
};

export const refreshPricesIfVisible = (context: string) => {
  if (!isPanelVisible('#electricity-prices-panel') && !isPanelVisible('#price-aware-devices-panel')) return;
  runLoggedTask(refreshPriceConfigView(), 'Failed to refresh prices', context);
};

export const refreshDailyBudgetIfVisible = (context: string) => {
  if (!isPanelVisible('#budget-panel')) return;
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', context);
};

export const refreshStaleDataStatus = (context: string) => {
  runLoggedTask(loadStaleDataStatus(), 'Failed to refresh stale data status', context);
};

export const refreshPowerData = async () => {
  lastPowerUsageRefreshStartedAt = Date.now();
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
};

export const refreshPowerDataIfVisible = (
  context: string,
  options: { force?: boolean; invalidateBeforeRefresh?: boolean } = {},
) => {
  if (!isPanelVisible('#usage-panel')) return;
  const now = Date.now();
  if (!options.force && now - lastPowerUsageRefreshStartedAt < POWER_USAGE_REALTIME_REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  if (options.invalidateBeforeRefresh) {
    invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
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

export const loadDevicesOnce = () => {
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

export const refreshDevicesForUi = () => {
  invalidateApiCacheForAllHomes(SETTINGS_UI_DEVICES_PATH);
  invalidateApiCache(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
  if (!state.devicesLoaded || state.devicesLoading) return;
  getTargetDevices()
    .then((devices) => renderLatestDevices(devices))
    .catch((error) => {
      void logSettingsError('Failed to refresh devices', error, 'settings.set');
    });
};

/**
 * Meter areas changed (`homes_config`): refetch the home-badge membership and
 * repaint the two lists that carry badges. The device payload itself is
 * unaffected, so this deliberately does NOT refetch `/ui_devices` — without it
 * the badges would keep naming the pre-edit areas for the rest of the session
 * (`loadDevicesOnce` only ever runs once).
 */
export const refreshHomeBadgesForUi = (context: string) => {
  runLoggedTask(refreshHomeBadges().then(() => {
    if (!state.devicesLoaded) return;
    renderPriorities(state.latestDevices);
    renderDevices(state.latestDevices);
  }), 'Failed to refresh meter area badges', context);
};

export const refreshModeAndDeviceControls = () => {
  loadModeAndPriorities()
    .then(() => {
      if (!state.devicesLoaded) return;
      // The canonical "devices changed, refresh every surface" pass, rather than
      // the subset this used to hand-roll. It also emits `devices-updated`, which
      // is what refreshes an OPEN detail panel — re-rendering the list does not
      // touch it, so a change made in another WebView (or via the Homey API)
      // otherwise left the panel's switches asserting the old configuration for
      // the rest of the session.
      renderLatestDevices(state.latestDevices);
    })
    .catch((error) => {
      void logSettingsError('Failed to load device control settings', error, 'settings.set');
    });
};
