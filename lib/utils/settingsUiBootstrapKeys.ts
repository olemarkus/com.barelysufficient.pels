import type { SettingsUiBootstrapKey } from '../../packages/contracts/src/settingsUiApi';

// The settings keys the settings UI bootstrap (`/ui_bootstrap`) carries, in the
// order the payload lists them. The contract owns the key union
// (`SettingsUiBootstrapKey`); keyed by it, this record fails to COMPILE when a
// key is missing or extra, so the runtime list cannot drift from the contract.
// The list has to live on this side: `packages/contracts` is types-only at
// runtime, so it cannot export a value for the bootstrap handler to read.
// `scripts/lib/settingsUiBootstrapKeys.cjs` keeps a JS copy for Node scripts,
// pinned to this list by `test/unit/settingsUiScripts.test.ts`.
const BOOTSTRAP_KEYS: Record<SettingsUiBootstrapKey, true> = {
  capacity_enabled: true,
  grid_import_enabled: true,
  grid_import_limit_kw: true,
  capacity_limit_kw: true,
  capacity_margin_kw: true,
  capacity_period_minutes: true,
  capacity_dry_run: true,
  homey_energy_meter_device_id: true,
  capacity_priorities: true,
  mode_device_targets: true,
  operating_mode: true,
  controllable_devices: true,
  managed_devices: true,
  device_control_profiles: true,
  device_target_power_configs: true,
  budget_exempt_devices: true,
  respect_external_off_devices: true,
  device_start_policies: true,
  temperature_control_disabled_devices: true,
  temperature_control_modes: true,
  temperature_boost_settings: true,
  native_ev_wiring_devices: true,
  device_driver_overrides: true,
  mode_aliases: true,
  overshoot_behaviors: true,
  price_optimization_settings: true,
  price_optimization_enabled: true,
  price_scheme: true,
  powerhour_device_id: true,
  norway_price_model: true,
  price_area: true,
  provider_surcharge: true,
  price_threshold_percent: true,
  price_min_diff_ore: true,
  nettleie_fylke: true,
  nettleie_orgnr: true,
  nettleie_tariffgruppe: true,
  export_price_enabled: true,
  export_spot_factor: true,
  export_fixed: true,
  daily_budget_enabled: true,
  daily_budget_kwh: true,
  daily_budget_price_shaping_enabled: true,
  daily_budget_controlled_weight: true,
  daily_budget_price_flex_share: true,
  debug_logging_topics: true,
  debug_logging_enabled: true,
  deferred_objectives: true,
  weather_advisor_settings: true,
};

export const SETTINGS_UI_BOOTSTRAP_KEYS = Object.keys(BOOTSTRAP_KEYS) as SettingsUiBootstrapKey[];
