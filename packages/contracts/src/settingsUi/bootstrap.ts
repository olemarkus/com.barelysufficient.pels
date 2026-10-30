import type { DailyBudgetUiRead } from '../dailyBudgetTypes.js';
import type { ResolvedDeferredObjectiveActivePlansV2 } from '../deferredObjectiveActivePlans.js';
import type { DeferredObjectiveRoster } from '../deferredObjectiveSettings.js';
import type { SettingsUiLogEntry } from '../types.js';
import type { SettingsUiPlanSnapshot } from './plan.js';
import type { SettingsUiPowerPayload } from './power.js';
import type { SettingsUiPricesPayload } from './prices.js';

/**
 * The settings keys the `/ui_bootstrap` payload carries: every setting the
 * settings UI reads while it boots, so the boot does not wait on a read per key
 * (each costs a round trip, about 0.35 s through the cloud for the web app).
 * The runtime's list, `lib/utils/settingsUiBootstrapKeys.ts`, is keyed by this
 * union, so the two cannot drift.
 */
export type SettingsUiBootstrapKey =
  | 'capacity_enabled'
  | 'grid_import_enabled'
  | 'grid_import_limit_kw'
  | 'capacity_limit_kw'
  | 'capacity_margin_kw'
  | 'capacity_period_minutes'
  | 'capacity_dry_run'
  | 'homey_energy_meter_device_id'
  | 'capacity_priorities'
  | 'mode_device_targets'
  | 'operating_mode'
  | 'controllable_devices'
  | 'managed_devices'
  | 'device_control_profiles'
  | 'device_target_power_configs'
  | 'budget_exempt_devices'
  | 'respect_external_off_devices'
  | 'device_start_policies'
  | 'temperature_control_disabled_devices'
  | 'temperature_control_modes'
  | 'temperature_boost_settings'
  | 'native_ev_wiring_devices'
  | 'device_driver_overrides'
  | 'mode_aliases'
  | 'overshoot_behaviors'
  | 'price_optimization_settings'
  | 'price_optimization_enabled'
  | 'price_scheme'
  | 'powerhour_device_id'
  | 'norway_price_model'
  | 'price_area'
  | 'provider_surcharge'
  | 'price_threshold_percent'
  | 'price_min_diff_ore'
  | 'nettleie_fylke'
  | 'nettleie_orgnr'
  | 'nettleie_tariffgruppe'
  | 'export_price_enabled'
  | 'export_spot_factor'
  | 'export_fixed'
  | 'daily_budget_enabled'
  | 'daily_budget_kwh'
  | 'daily_budget_price_shaping_enabled'
  | 'daily_budget_controlled_weight'
  | 'daily_budget_price_flex_share'
  | 'debug_logging_topics'
  | 'debug_logging_enabled'
  | 'weather_advisor_settings'
  | 'web_app_cloud_host'
  | 'export_price_source'
  | 'pv_forecast_source'
  | 'power_source'
  | 'battery_control_devices'
  | 'inverter_curtailment_devices'
  | 'continuous_battery_plan'
  | 'mode_catalog_initialized'
  | 'homes_config'
  | 'homes_config_initialized'
  | 'ev_boost_settings'
  | 'ev_charge_target_settings'
  | 'device_expected_power_overrides'
  | 'ev_car_associations'
  | 'setup_recommendation_dismissals'
  | 'weather_advisor_first_estimate_seen';

export type SettingsUiSettingsPatch = {
  settings: Partial<Record<SettingsUiBootstrapKey, unknown>>;
};

export type SettingsUiBootstrap = SettingsUiSettingsPatch & {
  dailyBudget: DailyBudgetUiRead;
  // The smart tasks, assembled from the per-device keys; the same read model
  // as `SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH`.
  deferredObjectives: DeferredObjectiveRoster;
  deferredObjectiveActivePlans: ResolvedDeferredObjectiveActivePlansV2 | null;
  plan: SettingsUiPlanSnapshot | null;
  power: SettingsUiPowerPayload;
  prices: SettingsUiPricesPayload;
};

export type SettingsUiLogRequest = SettingsUiLogEntry;
