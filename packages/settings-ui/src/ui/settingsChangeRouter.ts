import { syncSettingsHubChips } from './settingsHubChips.ts';
import { SETTINGS_UI_PRICES_PATH, SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUiApi.ts';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  HOMEY_ENERGY_METER_DEVICE_ID,
  POWER_SOURCE,
  BUDGET_EXEMPT_DEVICES,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  DEFERRED_OBJECTIVES_SETTINGS,
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_DRIVER_OVERRIDES,
  EV_BOOST_SETTINGS,
  NATIVE_EV_WIRING_DEVICES,
  RESPECT_EXTERNAL_OFF_DEVICES,
  DEBUG_LOGGING_TOPICS,
  HOMES_CONFIG, HOMES_CONFIG_INITIALIZED,
  NORWAY_PRICE_MODEL,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  PRICE_SCHEME,
  WEATHER_ADVISOR_SETTINGS,
} from '../../../contracts/src/settingsKeys.ts';
import { loadAdvancedSettings, loadCapacitySettings } from './capacity.ts';
import { notifyHomeLimitsSettingChanged } from './homeLimits.ts';
import { invalidateApiCache, invalidateSettingCache } from './homey.ts';
import { refreshActiveMode } from './modes.ts';
import { reloadPriceConfigSettings } from './priceConfig.ts';
import { refreshBudgetAdjust } from './budgetAdjustController.ts';
import { refreshDailyBudgetPlan } from './dailyBudget.ts';
import { loadEvBoostSettings, loadShedBehaviors, loadTemperatureBoostSettings } from './deviceDetail/index.ts';
import { loadDeviceControlProfiles } from './deviceControlProfiles.ts';
import { refreshDeadlinesList } from './deadlinesList.ts';
import { loadDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { reloadDeferredObjectiveActivePlans } from './deferredObjectiveActivePlans.ts';
import { handleWeatherAdvisorSettingsChanged } from './weatherInsight.ts';
import { DAILY_BUDGET_REFRESH_KEYS, DAILY_BUDGET_SETTINGS_KEYS } from './realtimeDailyBudgetKeys.ts';
import {
  refreshDailyBudgetIfVisible,
  refreshModeAndDeviceControls,
  refreshPlanForUi,
  refreshPowerData,
  refreshPricesIfVisible,
  refreshStaleDataStatus,
  runLoggedTask,
} from './uiRefreshTasks.ts';

/**
 * Routes a single changed settings key to the views that read it. Homey pushes
 * `settings.set` / `settings.unset` for every persisted write — including the
 * app's own — so this is the WebView's main freshness path: without a route
 * here the affected surface keeps showing its bootstrap value for the rest of
 * the session.
 *
 * Split out of `realtime.ts` (which keeps the `plan_updated` / `power_updated`
 * / `prices_updated` realtime handlers) so the key→view table can grow without
 * pushing that entry point over its line budget.
 */

const CAPACITY_SETTINGS_KEYS = new Set([
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_DRY_RUN,
  POWER_SOURCE,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG, HOMES_CONFIG_INITIALIZED,
]);
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
  RESPECT_EXTERNAL_OFF_DEVICES,
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

const refreshDailyBudgetSettings = (key: string) => {
  if (!DAILY_BUDGET_REFRESH_KEYS.has(key)) return;
  if (DAILY_BUDGET_SETTINGS_KEYS.has(key)) {
    runLoggedTask(refreshBudgetAdjust(), 'Failed to refresh adjust draft', 'settings.set');
  }
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'settings.set');
  // The hub's Daily-budget `Off` chip tracks `daily_budget_enabled` — cheap
  // cached reads, so syncing on every budget-key change is fine.
  syncSettingsHubChips();
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

// A per-device objective change (`deferred_objective.<id>`) — or a legacy-alias
// change — feeds the assembled `deferred_objectives` alias the UI reads (primed by
// the bootstrap). The exact changed key is invalidated by the caller, but the alias
// must be dropped + reloaded too, or the deadline list + PlanDeviceCards chips keep
// showing the pre-change state for the rest of the WebView session. Fires for BOTH
// `settings.set` (create/change) and `settings.unset` (clear).
const reloadObjectivesIfObjectiveKey = (key: string, context: string): void => {
  if (key !== DEFERRED_OBJECTIVES_SETTINGS && !key.startsWith(PER_DEVICE_OBJECTIVE_KEY_PREFIX)) return;
  invalidateSettingCache(DEFERRED_OBJECTIVES_SETTINGS);
  runLoggedTask(loadDeferredObjectiveSettings(), 'Failed to reload deferred objectives', context);
  runLoggedTask(refreshDeadlinesList(), 'Failed to refresh deadlines list', context);
};

// The active-plans recorder persists every replan / session change / updated
// start-finish hour via `settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)`.
// Without draining that key here, `state.deferredObjectiveActivePlans` stays
// frozen at its bootstrap value and the Overview device cards' EV state line
// (`EvDeadlineStateLine`) shows the pre-revision schedule until the user reloads
// the WebView. Re-read the fresh setting into state and repaint the overview.
// Fires for BOTH `settings.set` (revision) and `settings.unset` (task ended →
// recorder drops the plan).
const reloadActivePlansIfActivePlansKey = (key: string, context: string): void => {
  if (key !== DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING) return;
  runLoggedTask(
    reloadDeferredObjectiveActivePlans(),
    'Failed to reload deferred objective active plans',
    context,
  );
};

// A flag flip / device change must reach an already-open WebView: reload the
// weather settings snapshot and (when enabled) refetch the readout so the
// Budget card and Settings pickers track the new state without a reload.
// Fires for BOTH settings.set and settings.unset (clearing the blob disables).
// The sub-page stays open when the feature is toggled off — its master switch
// lives there, so the user must remain on the page to turn it back on.
const reloadWeatherInsightIfWeatherKey = (key: string, context: string): void => {
  if (key !== WEATHER_ADVISOR_SETTINGS) return;
  runLoggedTask(
    handleWeatherAdvisorSettingsChanged(),
    'Failed to reload weather insight',
    context,
  );
};

export const createSettingsUnsetHandler = () => (key: string) => {
  // Clears `unset` the per-device key; reload objectives so a cleared task drops out
  // of an already-open WebView (Homey may deliver clears as an unset event).
  invalidateSettingCache(key);
  reloadObjectivesIfObjectiveKey(key, 'settings.unset');
  reloadActivePlansIfActivePlansKey(key, 'settings.unset');
  reloadWeatherInsightIfWeatherKey(key, 'settings.unset');
  // An unset device-control map is a real configuration change — the runtime
  // reads an absent map as "nobody opted in" — so it has to reload here too.
  // Only `settings.set` consulted this set before, leaving switches asserting a
  // configuration the runtime had already dropped.
  if (DEVICE_CONTROL_KEYS.has(key)) refreshModeAndDeviceControls();
};

export const createSettingsSetHandler = () => (key: string) => {
  invalidateSettingCache(key);

  reloadObjectivesIfObjectiveKey(key, 'settings.set');
  reloadActivePlansIfActivePlansKey(key, 'settings.set');
  reloadWeatherInsightIfWeatherKey(key, 'settings.set');

  if (CAPACITY_SETTINGS_KEYS.has(key)) {
    runLoggedTask(loadCapacitySettings(), 'Failed to load capacity settings', 'settings.set');
  }
  // Keep an open meter-area Limits card live on external status/scalar changes
  // (suffixed keys the CAPACITY_SETTINGS_KEYS set intentionally excludes).
  notifyHomeLimitsSettingChanged(key);
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
