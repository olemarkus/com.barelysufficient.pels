export const SETTINGS_UI_BOOTSTRAP_PATH = '/ui_bootstrap';
export const SETTINGS_UI_DEVICES_PATH = '/ui_devices';

/**
 * Endpoint backing both whole-home meter pickers. It returns the meters the
 * Homey Energy live report actually exposes (so every listed pick is a reading
 * a selection can resolve) narrowed to actual meters: the whole-home
 * `cumulative` item plus `sensor`-class devices, never appliances. Selecting an
 * appliance would make PELS read one device's draw as whole-home power, so the
 * class narrowing is a safety guard resolved in the producer.
 */
export const HOMEY_ENERGY_METERS_PATH = '/homey_energy_meters';
export const SETTINGS_UI_PLAN_PATH = '/ui_plan';
export const SETTINGS_UI_POWER_PATH = '/ui_power';
export const SETTINGS_UI_PRICES_PATH = '/ui_prices';
export const SETTINGS_UI_CAR_ASSOCIATION_CONFIRM_PATH = '/ui_car_association_confirm';
export const SETTINGS_UI_CAR_ASSOCIATION_CLEAR_PATH = '/ui_car_association_clear';
export const SETTINGS_UI_RECOMMENDATION_CARS_PATH = '/ui_recommendation_cars';

// The PELS version running on this Homey, the Homey's timezone and its id. The
// standalone web app reads it to load the settings UI build made for that
// version and to show times in the Homey's zone, which its API key cannot read
// from Homey itself; the settings page uses the id to link to the web app with
// this Homey already filled in. An installed PELS without this route (Express's 404
// "Cannot GET") predates the web app.
export const SETTINGS_UI_VERSION_PATH = '/ui_version';
export const SETTINGS_UI_HUB_MARKET_PATH = '/ui_hub_market';
export const SETTINGS_UI_PRICE_SETUP_SUGGESTION_PATH = '/ui_price_setup_suggestion';
export const SETTINGS_UI_REFRESH_DEVICES_PATH = '/ui_refresh_devices';
export const SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH = '/ui_refresh_flow_conflicts';
export const SETTINGS_UI_REFRESH_PRICES_PATH = '/ui_refresh_prices';
export const SETTINGS_UI_REFRESH_GRID_TARIFF_PATH = '/ui_refresh_grid_tariff';
export const SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH = '/ui_device_diagnostics';
export const SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH = '/ui_deferred_objective_history';
export const SETTINGS_UI_DEVICE_LOG_PATH = '/ui_device_log';
export const SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH = '/ui_deferred_objective_settings';
export const SETTINGS_UI_LOG_PATH = '/settings_ui_log';
export const SETTINGS_UI_RESET_POWER_STATS_PATH = '/ui_reset_power_stats';
export const SETTINGS_UI_WEATHER_ADVISOR_READOUT_PATH = '/ui_weather_advisor_readout';
export const SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH = '/ui_preview_daily_budget_model';
export const SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH = '/ui_apply_daily_budget_model';

// Budget-exempt rescue from the overview device card (the bounded "Let it run
// now" path, identical to the starvation_rescue widget's rescue). The plan
// carries the gate (which cards may offer the chip,
// `SettingsUiPlanSnapshot.rescuableDeviceIds`); preview = the optional
// bounded-window readout; create = the committed rescue.
export const SETTINGS_UI_STARVATION_RESCUE_PREVIEW_PATH = '/ui_starvation_rescue_preview';
export const SETTINGS_UI_STARVATION_RESCUE_CREATE_PATH = '/ui_starvation_rescue_create';

// Smart-task edit lane from the detail page (edit end time/target + clear).
// Preview = the optional feasibility/cost readout for the edited candidate;
// update = the committed edit (a validated re-create over the same device);
// cancel = clear the task. Shapes live in `smartTaskEdit.ts`.
export const SETTINGS_UI_SMART_TASK_PREVIEW_PATH = '/ui_smart_task_preview';
export const SETTINGS_UI_SMART_TASK_DEVICES_PATH = '/ui_smart_task_devices';
export const SETTINGS_UI_SMART_TASK_CREATE_PATH = '/ui_smart_task_create';
export const SETTINGS_UI_SMART_TASK_CREATE_PREVIEW_PATH = '/ui_smart_task_create_preview';
export const SETTINGS_UI_SMART_TASK_UPDATE_PATH = '/ui_smart_task_update';
export const SETTINGS_UI_SMART_TASK_CANCEL_PATH = '/ui_smart_task_cancel';

// Sentinel prefix the runtime API layer uses when the Homey app shell exists
// but the PELS runtime services have not finished initializing yet (e.g.
// during the boot window after `homey app run` or an app restart). The
// settings UI client matches this prefix to keep callers in a bounded
// loading/retry state instead of surfacing a hard error.
export const SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX = 'PELS_APP_NOT_READY:';
