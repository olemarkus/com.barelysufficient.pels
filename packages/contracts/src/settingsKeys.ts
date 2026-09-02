export const CAPACITY_LIMIT_KW = 'capacity_limit_kw';
export const CAPACITY_MARGIN_KW = 'capacity_margin_kw';
export const CAPACITY_DRY_RUN = 'capacity_dry_run';
export const POWER_SOURCE = 'power_source';
// Explicit whole-home meter for the homey_energy power source. Device id
// string; any non-string (never written, a legacy stored-null Automatic,
// junk) reads as `unavailable`. The boot-time sole-meter adoption names the
// meter when Homey Energy lists exactly one; otherwise the owner picks it
// under Limits & safety. Nothing falls back at read time. Mirror of
// HOMEY_ENERGY_METER_DEVICE_ID in lib/utils/settingsKeys.ts — keep both in
// sync (the settings UI can't import lib).
export const HOMEY_ENERGY_METER_DEVICE_ID = 'homey_energy_meter_device_id';
// Home-scopable at runtime: a meter area may pin its own active mode under
// `operating_mode:<homeId>` (absent = the area follows this global key). Mirror
// of OPERATING_MODE_SETTING in lib/utils/settingsKeys.ts — keep both in sync
// (the settings UI can't import lib); the runtime's HOME_SCOPABLE_BASE_KEYS is
// the scoping source of truth.
export const OPERATING_MODE_SETTING = 'operating_mode';
export const MODE_ALIASES = 'mode_aliases';
export const CAPACITY_PRIORITIES = 'capacity_priorities';
export const MODE_DEVICE_TARGETS = 'mode_device_targets';
export const MODE_CATALOG_INITIALIZED = 'mode_catalog_initialized';
export const MANAGED_DEVICES = 'managed_devices';
export const CONTROLLABLE_DEVICES = 'controllable_devices';
export const BUDGET_EXEMPT_DEVICES = 'budget_exempt_devices';
// Opt-in for "Leave off until turned on again": `Record<deviceId, true>` (absent
// = off). Mirror of RESPECT_EXTERNAL_OFF_DEVICES in lib/utils/settingsKeys.ts —
// keep both in sync (the settings UI can't import lib).
export const RESPECT_EXTERNAL_OFF_DEVICES = 'respect_external_off_devices';
// Per-device "Disable temperature control" opt-out. Mirror of
// TEMPERATURE_CONTROL_DISABLED_DEVICES in lib/utils/settingsKeys.ts.
export const TEMPERATURE_CONTROL_DISABLED_DEVICES = 'temperature_control_disabled_devices';
export const TEMPERATURE_BOOST_SETTINGS = 'temperature_boost_settings';
export const EV_BOOST_SETTINGS = 'ev_boost_settings';
// The cars each charger MAY associate: `Record<chargerId, { carIds }>` (absent or
// empty = off for that charger). Mirror of EV_CAR_ASSOCIATIONS in
// lib/utils/settingsKeys.ts — keep both in sync (the settings UI can't import lib).
export const EV_CAR_ASSOCIATIONS = 'ev_car_associations';
export const NATIVE_EV_WIRING_DEVICES = 'native_ev_wiring_devices';
export const DEVICE_DRIVER_OVERRIDES = 'device_driver_overrides';
export const DEVICE_CONTROL_PROFILES = 'device_control_profiles';
export const DEVICE_TARGET_POWER_CONFIGS = 'device_target_power_configs';
// The owner's manual "Power when running" figures: `Record<deviceId, { kw, ts }>`
// (absent entry = PELS resolves the figure itself). Mirror of
// DEVICE_EXPECTED_POWER_OVERRIDES in lib/utils/settingsKeys.ts — keep both in
// sync (the settings UI can't import lib).
export const DEVICE_EXPECTED_POWER_OVERRIDES = 'device_expected_power_overrides';
export const DEFERRED_OBJECTIVES_SETTINGS = 'deferred_objectives';
// Per-device objective key prefix (`deferred_objective.<deviceId>`). Mirror of
// `PER_DEVICE_OBJECTIVE_KEY_PREFIX` in lib/objectives/deferredObjectives/objectiveStore.ts —
// keep both in sync. The settings UI can't import lib, so it detects per-device
// objective changes via this shared constant.
export const PER_DEVICE_OBJECTIVE_KEY_PREFIX = 'deferred_objective.';
export const DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING = 'deferred_objective_plan_history';
export const DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING = 'deferred_objective_active_plans';
export const OVERSHOOT_BEHAVIORS = 'overshoot_behaviors';
export const PRICE_OPTIMIZATION_SETTINGS = 'price_optimization_settings';
export const PRICE_OPTIMIZATION_ENABLED = 'price_optimization_enabled';
export const DAILY_BUDGET_ENABLED = 'daily_budget_enabled';
export const DAILY_BUDGET_KWH = 'daily_budget_kwh';
export const DAILY_BUDGET_PRICE_SHAPING_ENABLED = 'daily_budget_price_shaping_enabled';
export const DAILY_BUDGET_CONTROLLED_WEIGHT = 'daily_budget_controlled_weight';
export const DAILY_BUDGET_PRICE_FLEX_SHARE = 'daily_budget_price_flex_share';
export const DAILY_BUDGET_STATE = 'daily_budget_state';
export const DAILY_BUDGET_RESET = 'daily_budget_reset';
export const COMBINED_PRICES = 'combined_prices';
export const DEBUG_LOGGING_TOPICS = 'debug_logging_topics';
export const PRICE_SCHEME = 'price_scheme';
// Mirror of lib/utils/settingsKeys.ts PV_FORECAST_SOURCE (the settings UI
// cannot import lib) — keep both in sync.
export const PV_FORECAST_SOURCE = 'pv_forecast_source';
export const NORWAY_PRICE_MODEL = 'norway_price_model';
export const FLOW_PRICES_TODAY = 'flow_prices_today';
export const FLOW_PRICES_TOMORROW = 'flow_prices_tomorrow';
export const HOMEY_PRICES_TODAY = 'homey_prices_today';
export const HOMEY_PRICES_TOMORROW = 'homey_prices_tomorrow';
export const HOMEY_PRICES_CURRENCY = 'homey_prices_currency';
// Export (feed-in) price settings — mirror of the EXPORT_* keys in
// lib/utils/settingsKeys.ts; keep both in sync (the settings UI can't import lib).
export const EXPORT_PRICE_ENABLED = 'export_price_enabled';
export const EXPORT_SPOT_FACTOR = 'export_spot_factor';
export const EXPORT_FIXED = 'export_fixed';
export const POWER_CALIBRATION = 'power_calibration';
// Mirror of WEATHER_ADVISOR_SETTINGS in lib/utils/settingsKeys.ts — keep both
// in sync (the settings UI can't import lib).
export const WEATHER_ADVISOR_SETTINGS = 'weather_advisor_settings';
// Per-home live status blob (`pels_status` for the main home, `pels_status:<id>`
// for a meter area). Mirror of PELS_STATUS in lib/utils/settingsKeys.ts — keep
// both in sync (the settings UI can't import lib).
export const PELS_STATUS = 'pels_status';
// Per-home recorded power history (`power_tracker_state` for the main home,
// `power_tracker_state:<id>` for a meter area). Mirror of POWER_TRACKER_STATE in
// lib/utils/settingsKeys.ts — keep both in sync (the settings UI can't import
// lib). Paired with PELS_STATUS above: together they are the suffixed
// `settings.set` stream that carries a sub-home's freshness, since the realtime
// `plan_updated` / `power_updated` pushes are the main home's alone.
export const POWER_TRACKER_STATE = 'power_tracker_state';

// Multi-home roster blob. Mirror of HOMES_CONFIG in lib/utils/settingsKeys.ts —
// keep both in sync (the settings UI can't import lib). The per-home Limits
// switcher watches this so an area added/removed elsewhere (the Multiple-meters
// panel, a second WebView) refreshes the roster instead of sitting on a stale
// list.
export const HOMES_CONFIG = 'homes_config';
// Device→home pin overrides. Mirror of DEVICE_HOME_ASSIGNMENTS in
// lib/utils/settingsKeys.ts — keep both in sync (the settings UI can't import
// lib). Membership changes don't alter the area ROSTER (the Limits switcher
// ignores this key), but they do change which devices a `?homeId=` read model
// serves, so the settings-change router sweeps the home-scoped cache entries
// on it.
export const DEVICE_HOME_ASSIGNMENTS = 'device_home_assignments';
// Written-before marker for HOMES_CONFIG. The UI reads it with the roster so a
// transient missing value after an established multi-meter config remains
// "unknown" instead of being mistaken for a fresh single-home install.
export const HOMES_CONFIG_INITIALIZED = 'homes_config_initialized';

// ── Multi-home settings-key scoping ─────────────────────────────────────────
// Mirror of MAIN_HOME_ID + homeScopedSettingsKey in lib/utils/settingsKeys.ts —
// keep both in sync (the settings UI can't import lib; the runtime owns the
// source of truth). The main home keeps the historical unsuffixed keys, so
// `homeScopedSettingsKey(key, MAIN_HOME_ID)` returns the bare key byte-for-byte;
// any other home reads/writes `<baseKey>:<homeId>`.

/** Identifier of a home: `'main'` or a generated meter-area id. */
export type HomeId = string;

/** Canonical id of the primary (implicit) home — the unsuffixed-key complement. */
export const MAIN_HOME_ID = 'main';

/**
 * Scope a base settings key to a home: the main home reads the historical
 * unsuffixed key unchanged; any other home reads `<baseKey>:<homeId>`.
 */
export const homeScopedSettingsKey = (baseKey: string, homeId: HomeId): string => (
  homeId === MAIN_HOME_ID ? baseKey : `${baseKey}:${homeId}`
);
