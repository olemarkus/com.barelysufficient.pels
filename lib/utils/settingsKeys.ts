// Runtime settings keys. Keys the settings UI also reads have their one copy in
// `packages/shared-domain/src/settings/settingsKeys.ts` and are re-exported here,
// so runtime code imports every key from this module.
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_ALIASES,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
} from '../../packages/shared-domain/src/settings/settingsKeys';

export {
  CAPACITY_ENABLED,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_DRY_RUN,
  CAPACITY_PERIOD_MINUTES,
  POWER_SOURCE,
  HOMEY_ENERGY_METER_DEVICE_ID,
  OPERATING_MODE_SETTING,
  MODE_ALIASES,
  CAPACITY_PRIORITIES,
  MODE_DEVICE_TARGETS,
  MODE_CATALOG_INITIALIZED,
  MANAGED_DEVICES,
  CONTROLLABLE_DEVICES,
  BUDGET_EXEMPT_DEVICES,
  BATTERY_CONTROL_DEVICES,
  RESPECT_EXTERNAL_OFF_DEVICES,
  DEVICE_START_POLICIES,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  TEMPERATURE_BOOST_SETTINGS,
  EV_BOOST_SETTINGS,
  EV_CAR_ASSOCIATIONS,
  NATIVE_EV_WIRING_DEVICES,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEFERRED_OBJECTIVES_SETTINGS,
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  OVERSHOOT_BEHAVIORS,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_OPTIMIZATION_ENABLED,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  PRICE_SCHEME,
  PV_FORECAST_SOURCE,
  NORWAY_PRICE_MODEL,
  POWERHOUR_DEVICE_ID,
  EXPORT_PRICE_SOURCE,
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  EXPORT_FIXED,
  WEATHER_ADVISOR_SETTINGS,
  POWER_TRACKER_PERSISTED_EVENT,
  PLAN_STATUS_PUBLISHED_EVENT,
  HOMES_CONFIG,
  DEVICE_HOME_ASSIGNMENTS,
  HOMES_CONFIG_INITIALIZED,
  MAIN_HOME_ID,
  homeScopedSettingsKey,
  TEMPERATURE_CONTROL_MODES,
} from '../../packages/shared-domain/src/settings/settingsKeys';

/**
 * The LEGACY tracker key: the settings blob the tracker persisted as before it
 * moved to the userdata store. Read once, at boot, by the import that carries
 * an upgraded install's history into the store and then unsets the key
 * (`lib/power/trackerLegacySettings.ts`); nothing writes it.
 */
export const POWER_TRACKER_STATE = 'power_tracker_state';
/**
 * Identifier of a home: `'main'` or a generated sub-home id (see `lib/home`).
 * Lives here — the shared-utils layer — so the capacity store (`lib/power`)
 * and the home domain (`lib/home`) share ONE identity type without a peer
 * import between them; both re-export it for their consumers.
 */
export type HomeId = string;
// Base keys whose values may be scoped per home via `homeScopedSettingsKey`
// (multi-home train). Kept private: the parse helper below is the boundary,
// and consumers route on its output (or the predicate) rather than probing
// this set directly.
const HOME_SCOPABLE_BASE_KEYS: ReadonlySet<string> = new Set([
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_DRY_RUN,
  CAPACITY_PERIOD_MINUTES,
  // Main keeps the historical unsuffixed mode catalog. Meter areas use these
  // suffixed keys and commit MODE_CATALOG_INITIALIZED last.
  OPERATING_MODE_SETTING,
  MODE_ALIASES,
  CAPACITY_PRIORITIES,
  MODE_DEVICE_TARGETS,
  MODE_CATALOG_INITIALIZED,
]);
/** Whether `baseKey` is one of the home-scopable base settings keys. */
export const isHomeScopableBaseKey = (baseKey: string): boolean => (
  HOME_SCOPABLE_BASE_KEYS.has(baseKey)
);
/**
 * Inverse of `homeScopedSettingsKey`, total and boundary-validated: a key of
 * the form `<scopableBase>:<homeId>` (non-empty home id, not the main id)
 * parses to that base + home. Every other string — unsuffixed keys, unknown
 * bases (a future `foo:bar` key), an empty suffix (`capacity_limit_kw:`), or
 * an explicit `:main` suffix the forward helper never produces — parses to
 * `{ baseKey: key, homeId: MAIN_HOME_ID }`, i.e. an ordinary exact settings
 * key. Never throws. Splits on the first `:` — base keys never contain a
 * colon, so home ids containing `:` still round-trip.
 */
export const parseHomeScopedSettingsKey = (key: string): { baseKey: string; homeId: string } => {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex !== -1) {
    const baseKey = key.slice(0, separatorIndex);
    const homeId = key.slice(separatorIndex + 1);
    if (homeId !== '' && homeId !== MAIN_HOME_ID && HOME_SCOPABLE_BASE_KEYS.has(baseKey)) {
      return { baseKey, homeId };
    }
  }
  return { baseKey: key, homeId: MAIN_HOME_ID };
};
// RETIRED, never read again: `main_meter_authority_migration_v1_done`, the
// marker of the deleted boot-time meter-authority migration. Installs that ran
// it still hold it as `true`; do not reuse the name for a new marker.
// Other retired names are listed, and unset at boot, in
// lib/store/retiredSettingsKeys.ts; do not reuse those either.
// Runtime state for the above — which devices PELS is currently leaving off
// because they were turned off outside PELS. Deliberately a separate key from
// the config: clearing the opt-in must not lose the config, and vice versa.
// Shape validated by `lib/observer/externalOffHold.ts`.
// LEGACY. Read only by `migrateExternalOffHoldsToPerKey`, which consumes it.
export const EXTERNAL_OFF_HOLDS = 'external_off_holds';
// LEGACY written-before marker for the blob above; unset by the same migration.
// It existed only to tell a fresh install from a transient miss of a blob that
// no longer exists.
export const EXTERNAL_OFF_HOLDS_INITIALIZED = 'external_off_holds_initialized';
// One key per held device, value an unread placeholder — the key's PRESENCE is
// the hold. Singular + dot, deliberately DISTINCT from the plural blob key
// above so a prefix scan never matches it (`external_off_holds` has no dot).
export const PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX = 'external_off_hold.';
// Set once the blob above has been copied into per-device keys and consumed.
export const EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED = 'external_off_holds_perkey_migrated';
// Runtime state PELS owes a battery: one key per battery PELS has claimed,
// `battery_control_claim.<deviceId>`, holding the claim value to hand it back
// to. Owned by `lib/battery/batteryClaimStore.ts`, which says why it is a
// settings key and not a `/userdata` row.
export const PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX = 'battery_control_claim.';
/** Learned measured peaks, `{ kw, observedAtMs }` per device (`lib/device/devicePowerPeak.ts`). */
export const DEVICE_POWER_PEAKS = 'device_power_peaks';
// Marker set once the blob → per-device-key migration has run. Per-device
// objectives live under `deferred_objective.<deviceId>` keys (see
// `lib/objectives/deferredObjectives/objectiveStore.ts`); the plural
// DEFERRED_OBJECTIVES_SETTINGS blob is a frozen fallback read only by that migration.
export const DEFERRED_OBJECTIVES_PERKEY_MIGRATED = 'deferred_objectives_perkey_migrated';
export const DEFERRED_OBJECTIVE_PLAN_HISTORY_V4_SETTING = 'deferred_objective_plan_history';
export const DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING = 'deferred_objective_plan_history_v5';
export const DEFERRED_OBJECTIVE_PLAN_HISTORY_INITIALIZED = 'deferred_objective_plan_history_v5_initialized';
export const DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK = 'deferred_objective_observation_watermark';
export const DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH = 'deferred_objective_hours_remaining_latch';
/** Runtime-owned per-device EV target-power reachability; never written by the settings UI. */
export const DEVICE_TARGET_POWER_REACHABILITY = 'device_target_power_reachability';
export const DEVICE_LAST_CONTROLLED_MS = 'device_last_controlled_ms';
export const CAPACITY_IN_SHORTFALL = 'capacity_in_shortfall';
export const PRICE_THRESHOLD_PERCENT = 'price_threshold_percent';
export const PRICE_MIN_DIFF_ORE = 'price_min_diff_ore';
// Legacy: the daily budget's plan and learned profiles live in the userdata
// store (lib/dailyBudget/dailyBudgetStateStore.ts). As a settings key it is only
// read by the legacy import.
export const DAILY_BUDGET_STATE = 'daily_budget_state';
// Legacy: the combined prices live in the userdata price cache
// (lib/price/priceCacheStore.ts), in a row of this name. As a settings key it is
// only read by the legacy import.
export const COMBINED_PRICES = 'combined_prices';
// Legacy: the spot prices and the area they are for live in the userdata store
// (lib/price/priceCacheStore.ts). The keys are only read by the one-shot boot import.
export const ELECTRICITY_PRICES = 'electricity_prices';
export const ELECTRICITY_PRICES_AREA = 'electricity_prices_area';
// Legacy: the grid tariff cache lives in the userdata store
// (lib/price/priceCacheStore.ts). The key is only read by the one-shot boot import.
export const NETTLEIE_DATA = 'nettleie_data';
// The payload-fed price sources' day payloads, currencies and device marker
// (Flow, Homey Energy, Power by the Hour) live in the userdata price cache
// (lib/price/priceCacheStore.ts), whose rows are named after these keys, so
// lib/price uses these constants as row keys too. As settings keys they are
// only read by the legacy import.
export const FLOW_PRICES_TODAY = 'flow_prices_today';
export const FLOW_PRICES_TOMORROW = 'flow_prices_tomorrow';
export const FLOW_REPORTED_DEVICE_CAPABILITIES = 'flow_reported_device_capabilities';
export const HOMEY_PRICES_TODAY = 'homey_prices_today';
export const HOMEY_PRICES_TOMORROW = 'homey_prices_tomorrow';
export const HOMEY_PRICES_CURRENCY = 'homey_prices_currency';
// Power by the Hour's prices, mirrored per local day from the app's
// `/dap-prices` app-to-app route. Same shape and same rotation as the flow and
// Homey slot pairs; owned by lib/price/powerhourScheme.ts.
export const POWERHOUR_PRICES_TODAY = 'powerhour_prices_today';
export const POWERHOUR_PRICES_TOMORROW = 'powerhour_prices_tomorrow';
export const POWERHOUR_PRICES_CURRENCY = 'powerhour_prices_currency';
// Which price device the stored powerhour payloads were built from. Runtime-only
// (the settings UI reads the owner's CHOICE, `POWERHOUR_DEVICE_ID`, not what the
// cache happens to hold). It exists because the app publishes only FUTURE slots,
// so today's payload is merged into rather than replaced — and a merge is only
// sound while both sides came from the same device.
export const POWERHOUR_PRICES_DEVICE = 'powerhour_prices_device';
// The owner's Homey Energy price formula, mirrored from
// `manager/energy/price/electricity/dynamic/user-costs` so the raw spot series
// Homey hands us can be resolved into the price they actually pay. Runtime-only
// (the settings UI never reads it); owned by lib/price/homeyPriceFormula.ts.
export const HOMEY_PRICE_FORMULA = 'homey_price_formula';
// Homey's own feed-in terms, mirrored from its export-pricing routes so a
// period can be priced without a live read. Runtime-only (the settings UI reads
// the resolved price, never the terms); owned by lib/price/homeyExportPrice.ts.
export const HOMEY_EXPORT_PRICE_TERMS = 'homey_export_price_terms';
// Written-before marker for DEVICE_HOME_ASSIGNMENTS, the explicit device→home
// pin overrides. Read/written only through lib/home/homeRegistryStore.ts (ports
// in lib/home/homeConfig.ts). Each multi-home blob has its own marker (the
// HOMES_CONFIG one is shared with the settings UI) so a transient SDK read miss
// is distinguishable from a fresh install; per-store because the two blobs have
// independent write lifecycles.
export const DEVICE_HOME_ASSIGNMENTS_INITIALIZED = 'device_home_assignments_initialized';
// Last owner whose persisted mode target was fully transferred for each
// thermostat, plus its marker-first staged copy. Internal runtime recovery
// state; the settings UI never reads either key.
export const MODE_TARGET_OWNERSHIP_STATE = 'mode_target_ownership_state';
export const MODE_TARGET_OWNERSHIP_STATE_INITIALIZED = 'mode_target_ownership_state_initialized';
export const POWER_CALIBRATION = 'power_calibration';
export const POWER_CALIBRATION_INITIALIZED = 'power_calibration_initialized';
/**
 * The LEGACY weather-history key: the usage/temperature history persisted as
 * one settings blob before it moved to the userdata store. Read once, at
 * boot, by the import that carries an upgraded install's history into the
 * store and then unsets the key (`lib/weather/weatherHistoryStore.ts`).
 */
export const WEATHER_HISTORY_STATE = 'weather_history_state';
// Learned PV-generation forecast: recorded generation history + concurrent irradiance.
export const PV_FORECAST_STATE = 'pv_forecast_state';
// Written-before marker for the above (the `power_calibration_initialized`
// precedent): lets the boot read tell a fresh install (no marker ⇒ nothing to
// protect, persist immediately) from a transient SDK miss (marker set ⇒ engage
// the abandon-grace window instead of overwriting up to 90 days of learned
// generation history). Read/written only by `setup/pvForecastStateAdapter.ts`.
export const PV_FORECAST_STATE_INITIALIZED = 'pv_forecast_state_initialized';
// Curtailment-surplus refute ladder: {holdLevel, holdUntilMs, importLatchUntilMs},
// written on verification transitions only (crash-loop resilience).
export const CURTAILMENT_HOLD_STATE = 'curtailment_hold_state';
// Monotone `true` once the whole-home feed has ever recorded grid export — the
// export half of solar-surplus reachability, kept apart from the resettable
// accounting history. Owned by `lib/power/signedExportLatch.ts`.
export const SIGNED_EXPORT_OBSERVED = 'signed_export_observed';
// EV car-to-charger link probe: coincidence-vote affinity map plus the
// per-car self-stop state-of-charge samples. Observation-only — no consumer
// reads it for planning. The `_INITIALIZED` companion distinguishes a fresh
// install from a transient settings-read miss (see `evCarLinkStore.ts`).
export const EV_CAR_LINK_STATE = 'ev_car_link_state';
export const EV_CAR_LINK_STATE_INITIALIZED = 'ev_car_link_state_initialized';
