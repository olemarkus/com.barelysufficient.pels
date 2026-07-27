import { syncSettingsHubChips } from './settingsHubChips.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
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
  DEVICE_HOME_ASSIGNMENTS,
  HOMES_CONFIG, HOMES_CONFIG_INITIALIZED,
  MAIN_HOME_ID,
  NORWAY_PRICE_MODEL,
  PELS_STATUS,
  POWER_TRACKER_STATE,
  homeScopedSettingsKey,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  PRICE_SCHEME,
  WEATHER_ADVISOR_SETTINGS,
} from '../../../contracts/src/settingsKeys.ts';
import { loadAdvancedSettings, loadCapacitySettings, notifyAreaSimulationSettingChanged } from './capacity.ts';
import { notifyHomeLimitsSettingChanged } from './homeLimits.ts';
import { getHomeScope, notifyHomeScopeSettingChanged } from './homeScope.ts';
import {
  invalidateApiCache,
  invalidateApiCacheForAllHomes,
  invalidateApiCacheForScopedHomes,
  invalidateSettingCache,
} from './homey.ts';
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
  refreshHomeBadgesForUi,
  refreshModeAndDeviceControls,
  refreshPlanForUi,
  refreshPowerData,
  refreshPowerDataIfVisible,
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

// An area added/removed elsewhere rewrites `homes_config`: refresh the shell's
// scope roster first (it owns the selection), then let the open meter-area
// Limits card react to external status/scalar changes on the suffixed keys the
// CAPACITY_SETTINGS_KEYS set intentionally excludes. The aggregate posture
// behind the global simulation banner and the hub chip re-resolves on BOTH a
// suffixed `capacity_dry_run:<homeId>` write (the Limits control toggle, a
// second WebView — the exact-key sets can never match it) AND the roster keys
// themselves, which decide which flags belong in the posture at all.
const notifyHomeScopedControllers = (key: string) => {
  notifyHomeScopeSettingChanged(key);
  notifyHomeLimitsSettingChanged(key);
  notifyAreaSimulationSettingChanged(key);
};

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
  if (key === POWER_TRACKER_STATE) {
    invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
    runLoggedTask(refreshPowerData(), 'Failed to refresh power data', 'settings.set');
    refreshStaleDataStatus('settings.set');
    refreshDailyBudgetIfVisible('settings.set');
    return;
  }
  if (key !== PELS_STATUS) return;
  invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
  refreshStaleDataStatus('settings.set');
};

// A sub-home commits a plan by persisting its own suffixed `pels_status:<id>`
// and `power_tracker_state:<id>` — the ONLY freshness signal a sub-home gets,
// because the realtime `plan_updated` / `power_updated` streams are the main
// home's and are deliberately never widened (widening them would repaint Main's
// Overview from a sub-home's device set in a Homey-cached stale WebView).
//
// Drop every home-scoped plan/power entry on any such write rather than parsing
// the id out of the key: resolving suffixed keys client-side is the precedent
// this train is correcting, and the over-broad sweep costs at most one refetch
// per area while being impossible to get wrong. The BARE entries are untouched —
// a sub-home write says nothing about the whole home.
const SUFFIXED_HOME_PLAN_KEY_PREFIXES = [`${PELS_STATUS}:`, `${POWER_TRACKER_STATE}:`];

const refreshHomeScopedReadModels = (key: string) => {
  // The roster (`homes_config`) and the device→home pins
  // (`device_home_assignments`) decide which home ids resolve at all and which
  // devices a scoped read serves — neither writes any suffixed status key, so
  // without this branch a deleted area's cached payload would keep rendering
  // `homeScope: resolved` for a home the runtime no longer has, and a re-pinned
  // device would stay in the wrong home's list for the session. The bare
  // entries are untouched: the whole-home read models don't depend on either.
  if (key === HOMES_CONFIG || key === DEVICE_HOME_ASSIGNMENTS) {
    invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH);
    invalidateApiCacheForScopedHomes(SETTINGS_UI_POWER_PATH);
    invalidateApiCacheForScopedHomes(SETTINGS_UI_DEVICES_PATH);
    return;
  }
  if (!SUFFIXED_HOME_PLAN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return;
  invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH);
  invalidateApiCacheForScopedHomes(SETTINGS_UI_POWER_PATH);
  // A scoped `ui_devices` payload derives `hasExhibitedExport` from that home's
  // power tracker, so a suffixed tracker write must sweep the scoped devices
  // entries too — otherwise a meter-only PV area cached before its first
  // export keeps the solar-surplus controls hidden until the WebView reloads.
  // The status blob feeds no devices field, so its writes leave devices alone.
  if (key.startsWith(`${POWER_TRACKER_STATE}:`)) {
    invalidateApiCacheForScopedHomes(SETTINGS_UI_DEVICES_PATH);
  }
  // The SELECTED area's own tracker write also repaints a visible Usage panel
  // — this suffixed stream is that home's only freshness signal (the realtime
  // `power_updated` push is Main's and is never widened). The key is REBUILT
  // from the selected scope and compared whole, never parsed (the
  // `notifyHomeLimitsSettingChanged` precedent); Main's mirror of this lives
  // in `refreshPowerSettings` on the bare key.
  const { selectedHomeId } = getHomeScope();
  if (selectedHomeId !== MAIN_HOME_ID
    && key === homeScopedSettingsKey(POWER_TRACKER_STATE, selectedHomeId)) {
    refreshPowerDataIfVisible('settings.set', { force: true });
  }
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
  // Main capacity settings retain the runtime's last-good values when absent.
  // Route the bare key through the full loader so it can preserve and repaint
  // that posture instead of fabricating a boot default.
  if (CAPACITY_SETTINGS_KEYS.has(key)) {
    runLoggedTask(loadCapacitySettings(), 'Failed to load capacity settings', 'settings.unset');
  }
  // An unset suffixed flag is a real posture change too: the runtime reads an
  // absent per-area flag as its simulating boot default. So is an unset
  // roster — the posture must narrow with it, and no other unset route
  // re-resolves it.
  notifyAreaSimulationSettingChanged(key);
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
  notifyHomeScopedControllers(key);
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
  // Both the roster (`homes_config`) and the device→home pins
  // (`device_home_assignments`) decide what a row's home badge says — an area
  // rename/delete changes the label, a re-pin moves a device — so either write
  // refetches membership and repaints the two badge-carrying lists.
  if (key === HOMES_CONFIG || key === DEVICE_HOME_ASSIGNMENTS) {
    refreshHomeBadgesForUi('settings.set');
  }

  refreshPriceSettings(key);
  refreshPowerSettings(key);
  refreshHomeScopedReadModels(key);
  refreshDailyBudgetSettings(key);
};
