/**
 * Settings keys and realtime event names that BOTH the runtime and the settings
 * UI use. This is their one copy: `lib/utils/settingsKeys.ts` re-exports them
 * beside the runtime-only keys, and the settings UI imports them from here.
 * They cannot live in `packages/contracts`, which the packaged app does not
 * ship (a runtime value import from it crashes boot). A key only the runtime
 * reads stays in `lib/utils/settingsKeys.ts`; see
 * `notes/settings-key-ownership.md`.
 */
export const CAPACITY_ENABLED = 'capacity_enabled';
export const GRID_IMPORT_ENABLED = 'grid_import_enabled';
export const GRID_IMPORT_LIMIT_KW = 'grid_import_limit_kw';
export const CAPACITY_LIMIT_KW = 'capacity_limit_kw';
export const CAPACITY_MARGIN_KW = 'capacity_margin_kw';
export const CAPACITY_DRY_RUN = 'capacity_dry_run';
export const CAPACITY_PERIOD_MINUTES = 'capacity_period_minutes';
export const POWER_SOURCE = 'power_source';
// Explicit whole-home meter for the homey_energy power source. Device id
// string; any non-string (never written, a legacy stored-null Automatic,
// junk) reads as `unavailable`. The boot-time sole-meter adoption names the
// meter when Homey Energy lists exactly one; otherwise the owner picks it
// under Limits & safety. Nothing falls back at read time.
export const HOMEY_ENERGY_METER_DEVICE_ID = 'homey_energy_meter_device_id';
// Home-scopable at runtime: a meter area may pin its own active mode under
// `operating_mode:<homeId>` (absent = the area follows this global key). The
// runtime's HOME_SCOPABLE_BASE_KEYS (`lib/utils/settingsKeys.ts`) is the
// scoping source of truth.
export const OPERATING_MODE_SETTING = 'operating_mode';
export const MODE_ALIASES = 'mode_aliases';
export const CAPACITY_PRIORITIES = 'capacity_priorities';
export const MODE_DEVICE_TARGETS = 'mode_device_targets';
export const MODE_CATALOG_INITIALIZED = 'mode_catalog_initialized';
export const MANAGED_DEVICES = 'managed_devices';
export const CONTROLLABLE_DEVICES = 'controllable_devices';
export const BUDGET_EXEMPT_DEVICES = 'budget_exempt_devices';
// A home battery's Managed toggle: `Record<deviceId, boolean>` (absent entry or
// key = on; `false` = off). Parse lives in
// `packages/shared-domain/src/settings/batteryControlDevices.ts`; the runtime
// reads it through `lib/battery/batteryControlSettings.ts`, and the settings UI
// writes it.
export const BATTERY_CONTROL_DEVICES = 'battery_control_devices';
// Opt-in for "Leave off until turned on again": `Record<deviceId, true>` (absent
// = off).
export const RESPECT_EXTERNAL_OFF_DEVICES = 'respect_external_off_devices';
// Per-device start authority: `Record<deviceId, 'unrestricted' | 'pels_only'>`
// (absent entry = 'unrestricted'). Read and write policy live with the key's
// owner, `packages/shared-domain/src/settings/deviceStartPolicy.ts`.
export const DEVICE_START_POLICIES = 'device_start_policies';
// Per-device "Disable temperature control" opt-out from every non-binary PELS
// command. The raw device snapshot remains temperature-capable for
// observation/UI; setup projects an enabled entry as binary-only for planning
// and actuation.
export const TEMPERATURE_CONTROL_DISABLED_DEVICES = 'temperature_control_disabled_devices';
export const TEMPERATURE_BOOST_SETTINGS = 'temperature_boost_settings';
export const EV_BOOST_SETTINGS = 'ev_boost_settings';
// The cars each charger MAY associate: `Record<chargerId, { carIds }>` (absent or
// empty = off for that charger). An eligibility set, never an association — the
// association is session-scoped and in-memory.
export const EV_CAR_ASSOCIATIONS = 'ev_car_associations';
export const NATIVE_EV_WIRING_DEVICES = 'native_ev_wiring_devices';
export const DEVICE_DRIVER_OVERRIDES = 'device_driver_overrides';
export const DEVICE_CONTROL_PROFILES = 'device_control_profiles';
export const DEVICE_TARGET_POWER_CONFIGS = 'device_target_power_configs';
// The owner's manual "Power when running" figures: `Record<deviceId, { kw, ts }>`
// (absent entry = PELS resolves the figure itself).
export const DEVICE_EXPECTED_POWER_OVERRIDES = 'device_expected_power_overrides';
export const DEFERRED_OBJECTIVES_SETTINGS = 'deferred_objectives';
// Per-device objective key prefix (`deferred_objective.<deviceId>`), owned by
// `lib/objectives/deferredObjectives/objectiveStore.ts`. Singular + dot,
// deliberately DISTINCT from the plural blob key `deferred_objectives` so a
// prefix scan never collides with the frozen blob (the blob key has no trailing
// dot, so it is not matched by the prefix). The settings UI detects per-device
// objective changes through it.
export const PER_DEVICE_OBJECTIVE_KEY_PREFIX = 'deferred_objective.';
export const DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING = 'deferred_objective_active_plans';
export const OVERSHOOT_BEHAVIORS = 'overshoot_behaviors';
export const PRICE_OPTIMIZATION_SETTINGS = 'price_optimization_settings';
export const PRICE_OPTIMIZATION_ENABLED = 'price_optimization_enabled';
export const DAILY_BUDGET_ENABLED = 'daily_budget_enabled';
export const DAILY_BUDGET_KWH = 'daily_budget_kwh';
export const DAILY_BUDGET_PRICE_SHAPING_ENABLED = 'daily_budget_price_shaping_enabled';
export const DAILY_BUDGET_CONTROLLED_WEIGHT = 'daily_budget_controlled_weight';
export const DAILY_BUDGET_PRICE_FLEX_SHARE = 'daily_budget_price_flex_share';
export const DAILY_BUDGET_RESET = 'daily_budget_reset';
export const DEBUG_LOGGING_TOPICS = 'debug_logging_topics';
export const PRICE_SCHEME = 'price_scheme';
// Which PV-generation forecast feeds planning: 'auto' (prefer Homey Energy's
// solar forecast when it has useful data, else the learned model) |
// 'homey_energy' | 'learned'. Absence/junk reads as 'auto'
// (setup/pvForecastSourceSetting.ts).
export const PV_FORECAST_SOURCE = 'pv_forecast_source';
export const NORWAY_PRICE_MODEL = 'norway_price_model';
// Which of the app's price devices this home is priced from. The owner picks
// it in the settings UI, so both sides read it — the shared read policy lives
// in packages/shared-domain/src/settings/priceScheme.ts.
export const POWERHOUR_DEVICE_ID = 'powerhour_device_id';
// Which source the feed-in price comes from: the owner's own amounts, or
// Homey's export pricing. Owned by
// packages/shared-domain/src/settings/exportPriceSource.ts.
export const EXPORT_PRICE_SOURCE = 'export_price_source';
// Export (feed-in) price model — pure-math markups on the same wholesale spot the
// import price uses. Off by default; written by the settings UI's "Export price"
// section.
export const EXPORT_PRICE_ENABLED = 'export_price_enabled';
export const EXPORT_SPOT_FACTOR = 'export_spot_factor';
export const EXPORT_FIXED = 'export_fixed';
// Weather-insight feature: config blob (enable flag + device ids, written by the
// Settings UI master switch/pickers or via `homey api`).
export const WEATHER_ADVISOR_SETTINGS = 'weather_advisor_settings';
// Realtime push the runtime emits after every tracker persist, for every home
// (`{ homeId }`; `MAIN_HOME_ID` for the whole home). The tracker lives in the
// userdata store, under no settings key, so this push is the UI's freshness
// signal for it: paired with the status push below it is what carries a
// sub-home's freshness, since `plan_updated` / `power_updated` are the main
// home's alone. Payload: `PowerTrackerPersistedPayload` in
// `packages/contracts/src/realtimeEventPayloads.ts`.
export const POWER_TRACKER_PERSISTED_EVENT = 'power_tracker_persisted';
// Realtime invalidation after a status publish or device presentation refresh, for every home
// (`{ homeId }`; `MAIN_HOME_ID` for the whole home). The status lives in the
// app's memory (`lib/plan/planStatusRegistry.ts`), under no settings key; the UI
// reads it through `ui_power` (`?homeId=` for a meter area). Areas also refetch
// `ui_plan` on this signal; refreshing device presentation does not write or
// change capacity status. Payload: `PlanStatusPublishedPayload` in
// `packages/contracts/src/realtimeEventPayloads.ts`.
export const PLAN_STATUS_PUBLISHED_EVENT = 'plan_status_published';

// Multi-home roster blob. Read/written by the runtime only through
// lib/home/homeRegistryStore.ts (ports in lib/home/homeConfig.ts). The per-home
// Limits switcher watches this so an area added/removed elsewhere (the
// Multiple-meters panel, a second WebView) refreshes the roster instead of
// sitting on a stale list.
export const HOMES_CONFIG = 'homes_config';
// Device→home pin overrides. Membership changes don't alter the area ROSTER (the
// Limits switcher ignores this key), but they do change which devices a
// `?homeId=` read model serves, so the settings-change router sweeps the
// home-scoped cache entries on it.
export const DEVICE_HOME_ASSIGNMENTS = 'device_home_assignments';
// Written-before marker for HOMES_CONFIG. The UI reads it with the roster so a
// transient missing value after an established multi-meter config remains
// "unknown" instead of being mistaken for a fresh single-home install.
export const HOMES_CONFIG_INITIALIZED = 'homes_config_initialized';

// ── Multi-home settings-key scoping ─────────────────────────────────────────
// The main home keeps the historical unsuffixed keys, so
// `homeScopedSettingsKey(key, MAIN_HOME_ID)` returns the bare key byte-for-byte;
// any other home reads/writes `<baseKey>:<homeId>`. Which base keys may be
// scoped, and the inverse parse, belong to the runtime
// (`lib/utils/settingsKeys.ts`).

/** Canonical id of the primary (implicit) home — the unsuffixed-key complement. */
export const MAIN_HOME_ID = 'main';

/**
 * Scope a base settings key to a home: the main home reads the historical
 * unsuffixed key unchanged; any other home reads `<baseKey>:<homeId>`.
 */
export const homeScopedSettingsKey = (baseKey: string, homeId: string): string => (
  homeId === MAIN_HOME_ID ? baseKey : `${baseKey}:${homeId}`
);

export const TEMPERATURE_CONTROL_MODES = 'temperature_control_modes';
