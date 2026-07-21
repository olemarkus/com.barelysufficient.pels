export const CAPACITY_LIMIT_KW = 'capacity_limit_kw';
export const CAPACITY_MARGIN_KW = 'capacity_margin_kw';
export const CAPACITY_DRY_RUN = 'capacity_dry_run';
export const POWER_SOURCE = 'power_source';
// Explicit whole-home meter for the homey_energy power source. Device id
// string; absent/empty = automatic (Homey's marked whole-home cumulative
// item). Mirror of HOMEY_ENERGY_METER_DEVICE_ID in lib/utils/settingsKeys.ts —
// keep both in sync (the settings UI can't import lib).
export const HOMEY_ENERGY_METER_DEVICE_ID = 'homey_energy_meter_device_id';
export const OPERATING_MODE_SETTING = 'operating_mode';
export const MANAGED_DEVICES = 'managed_devices';
export const CONTROLLABLE_DEVICES = 'controllable_devices';
export const BUDGET_EXEMPT_DEVICES = 'budget_exempt_devices';
export const TEMPERATURE_BOOST_SETTINGS = 'temperature_boost_settings';
export const EV_BOOST_SETTINGS = 'ev_boost_settings';
export const NATIVE_EV_WIRING_DEVICES = 'native_ev_wiring_devices';
export const DEVICE_DRIVER_OVERRIDES = 'device_driver_overrides';
export const DEVICE_CONTROL_PROFILES = 'device_control_profiles';
export const DEVICE_TARGET_POWER_CONFIGS = 'device_target_power_configs';
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

// Hidden multi-home feature flag. Mirror of MULTI_HOME_ENABLED in
// lib/utils/settingsKeys.ts — keep both in sync (the settings UI can't import
// lib). DEFAULT FALSE (absent = off): read as `=== true`. While off the
// "Multiple meters" section and the per-home Limits switcher are hidden.
export const MULTI_HOME_ENABLED = 'multi_home_enabled';

// Multi-home roster blob. Mirror of HOMES_CONFIG in lib/utils/settingsKeys.ts —
// keep both in sync (the settings UI can't import lib). The per-home Limits
// switcher watches this so an area added/removed elsewhere (the Multiple-meters
// panel, a second WebView) refreshes the roster instead of sitting on a stale
// list. (`device_home_assignments` is intentionally not mirrored — device→home
// membership changes don't alter the area roster.)
export const HOMES_CONFIG = 'homes_config';

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
