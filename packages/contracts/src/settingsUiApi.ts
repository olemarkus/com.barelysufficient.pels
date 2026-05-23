import type { DailyBudgetUiPayload } from './dailyBudgetTypes.js';
import type { DeferredObjectiveActivePlansV1 } from './deferredObjectiveActivePlans.js';
import type { DeferredObjectivePlanHistoryEntry } from './deferredObjectivePlanHistory.js';
import type { SettingsUiDeviceDiagnosticsPayload } from './deviceDiagnosticsTypes.js';
import type { PowerTrackerState } from './powerTrackerTypes.js';
import type { SettingsUiLogEntry, SteppedLoadProfile, TargetDeviceSnapshot } from './types.js';
import type { DeviceOverviewSnapshot } from '../../shared-domain/src/deviceOverview.js';

export const SETTINGS_UI_BOOTSTRAP_PATH = '/ui_bootstrap';
export const SETTINGS_UI_DEVICES_PATH = '/ui_devices';
export const SETTINGS_UI_PLAN_PATH = '/ui_plan';
export const SETTINGS_UI_POWER_PATH = '/ui_power';
export const SETTINGS_UI_PRICES_PATH = '/ui_prices';
export const SETTINGS_UI_REFRESH_DEVICES_PATH = '/ui_refresh_devices';
export const SETTINGS_UI_REFRESH_PRICES_PATH = '/ui_refresh_prices';
export const SETTINGS_UI_REFRESH_GRID_TARIFF_PATH = '/ui_refresh_grid_tariff';
export const SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH = '/ui_device_diagnostics';
export const SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH = '/ui_deferred_objective_history';
export const SETTINGS_UI_LOG_PATH = '/settings_ui_log';
export const SETTINGS_UI_RESET_POWER_STATS_PATH = '/ui_reset_power_stats';
export const SETTINGS_UI_RECOMPUTE_DAILY_BUDGET_PATH = '/ui_recompute_daily_budget';
export const SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH = '/ui_preview_daily_budget_model';
export const SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH = '/ui_apply_daily_budget_model';

// Sentinel prefix the runtime API layer uses when the Homey app shell exists
// but the PELS runtime services have not finished initializing yet (e.g.
// during the boot window after `homey app run` or an app restart). The
// settings UI client matches this prefix to keep callers in a bounded
// loading/retry state instead of surfacing a hard error.
export const SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX = 'PELS_APP_NOT_READY:';

export const SETTINGS_UI_BOOTSTRAP_KEYS = [
  'capacity_limit_kw',
  'capacity_margin_kw',
  'capacity_dry_run',
  'capacity_priorities',
  'mode_device_targets',
  'operating_mode',
  'controllable_devices',
  'managed_devices',
  'device_control_profiles',
  'device_target_power_configs',
  'budget_exempt_devices',
  'temperature_boost_settings',
  'native_ev_wiring_devices',
  'device_driver_overrides',
  'mode_aliases',
  'overshoot_behaviors',
  'price_optimization_settings',
  'price_optimization_enabled',
  'price_scheme',
  'norway_price_model',
  'price_area',
  'provider_surcharge',
  'price_threshold_percent',
  'price_min_diff_ore',
  'nettleie_fylke',
  'nettleie_orgnr',
  'nettleie_tariffgruppe',
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
  'daily_budget_controlled_weight',
  'daily_budget_price_flex_share',
  'daily_budget_breakdown_enabled',
  'debug_logging_topics',
  'debug_logging_enabled',
  'deferred_objectives',
] as const;

export type SettingsUiBootstrapKey = (typeof SETTINGS_UI_BOOTSTRAP_KEYS)[number];

export type SettingsUiSettingsPatch = {
  settings: Partial<Record<SettingsUiBootstrapKey, unknown>>;
};

export type SettingsUiBootstrap = SettingsUiSettingsPatch & {
  dailyBudget: DailyBudgetUiPayload | null;
  deferredObjectiveActivePlans: DeferredObjectiveActivePlansV1 | null;
  plan: SettingsUiPlanSnapshot | null;
  power: SettingsUiPowerPayload;
  prices: SettingsUiPricesPayload;
};

export type SettingsUiLogRequest = SettingsUiLogEntry;

export type SettingsUiPlanPendingTargetCommand = {
  desired: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: 'waiting_confirmation' | 'temporary_unavailable';
  lastObservedValue?: unknown;
  lastObservedSource?: string;
};

export type SettingsUiPlanStarvationCause = 'capacity' | 'budget' | 'manual' | 'external';

export type SettingsUiPlanDeviceStarvation = {
  isStarved: boolean;
  accumulatedMs: number;
  cause: SettingsUiPlanStarvationCause;
  startedAtMs: number | null;
};

export type SettingsUiPlanSteppedLoadState = {
  profile: SteppedLoadProfile;
  reportedStepId: string | null;
  targetStepId: string | null;
  commandPending: boolean;
};

export type SettingsUiPlanMetaSnapshot = {
  [key: string]: unknown;
  totalKw?: number | null;
  softLimitKw?: number;
  capacitySoftLimitKw?: number;
  dailySoftLimitKw?: number | null;
  softLimitSource?: 'capacity' | 'daily' | 'both';
  headroomKw?: number;
  powerKnown?: boolean;
  hasLivePowerSample?: boolean;
  powerSampleAgeMs?: number | null;
  powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapLimitKw?: number | null;
  hardCapHeadroomKw?: number | null;
  hourlyBudgetExhausted?: boolean;
  usedKWh?: number;
  budgetKWh?: number;
  capacityHourBudgetKWh?: number;
  hourBudgetKWh?: number;
  capacityLimitKw?: number;
  minutesRemaining?: number;
  controlledKw?: number;
  uncontrolledKw?: number;
  hourControlledKWh?: number;
  hourUncontrolledKWh?: number;
  dailyBudgetRemainingKWh?: number;
  dailyBudgetExceeded?: boolean;
  dailyBudgetHourKWh?: number;
  lastPowerUpdateMs?: number;
};

export type SettingsUiPlanDeviceSnapshot = DeviceOverviewSnapshot & {
  [key: string]: unknown;
  id: string;
  name: string;
  deviceClass?: string;
  plannedTarget?: number;
  priority?: number;
  zone?: string;
  budgetExempt?: boolean;
  temperatureBoost?: TargetDeviceSnapshot['temperatureBoost'];
  temperatureBoostActive?: boolean;
  evBoost?: TargetDeviceSnapshot['evBoost'];
  evBoostActive?: boolean;
  currentTemperature?: number;
  stateKind?: string;
  stateTone?: string;
  starvation?: SettingsUiPlanDeviceStarvation;
  pendingTargetCommand?: SettingsUiPlanPendingTargetCommand;
  steppedLoad?: SettingsUiPlanSteppedLoadState;
  idleClassification?: 'near_target_idle' | 'unresponsive' | 'capped_idle';
};

export type SettingsUiPlanDevice = SettingsUiPlanDeviceSnapshot;

export type SettingsUiPlanSnapshot = {
  generatedAtMs?: number;
  meta?: SettingsUiPlanMetaSnapshot;
  devices?: SettingsUiPlanDeviceSnapshot[];
};

export type SettingsUiPlanPayload = {
  plan: SettingsUiPlanSnapshot | null;
};

export type SettingsUiDevicesPayload = {
  devices: TargetDeviceSnapshot[];
};

export type SettingsUiDeferredObjectivePlanHistoryPayload = {
  version: 1;
  entriesByDeviceId: Record<string, DeferredObjectivePlanHistoryEntry[]>;
};

export type SettingsUiPowerStatus = {
  headroomKw?: number;
  lastPowerUpdate?: number | null;
  priceLevel?: string | null;
  powerKnown?: boolean;
  hasLivePowerSample?: boolean;
  powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapHeadroomKw?: number | null;
};

export type SettingsUiPowerPayload = {
  tracker: PowerTrackerState | null;
  status: SettingsUiPowerStatus | null;
  heartbeat: number | null;
};

export type SettingsUiPricesPayload = {
  combinedPrices: unknown | null;
  electricityPrices: unknown | null;
  priceArea: string | null;
  gridTariffData: unknown | null;
  flowToday: unknown | null;
  flowTomorrow: unknown | null;
  homeyCurrency: string | null;
  homeyToday: unknown | null;
  homeyTomorrow: unknown | null;
};

export type SettingsUiDeviceDiagnosticsResponse = SettingsUiDeviceDiagnosticsPayload;

export type SettingsUiResetPowerStatsResponse = {
  power: SettingsUiPowerPayload;
  dailyBudget: DailyBudgetUiPayload | null;
};
