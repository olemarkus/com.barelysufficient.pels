import type { DailyBudgetUiPayload } from './dailyBudgetTypes.js';
import type { SettingsUiDeviceDiagnosticsPayload } from './deviceDiagnosticsTypes.js';
import type { PowerTrackerState } from './powerTrackerTypes.js';
import type { SettingsUiLogEntry, TargetDeviceSnapshot } from './types.js';
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
export const SETTINGS_UI_LOG_PATH = '/settings_ui_log';
export const SETTINGS_UI_RESET_POWER_STATS_PATH = '/ui_reset_power_stats';
export const SETTINGS_UI_RECOMPUTE_DAILY_BUDGET_PATH = '/ui_recompute_daily_budget';
export const SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH = '/ui_preview_daily_budget_model';
export const SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH = '/ui_apply_daily_budget_model';

export type SettingsUiSettingsPatch = {
  settings: Record<string, unknown>;
};

export type SettingsUiBootstrap = SettingsUiSettingsPatch & {
  dailyBudget: DailyBudgetUiPayload | null;
  featureAccess: SettingsUiFeatureAccess;
  plan: SettingsUiPlanSnapshot | null;
  power: SettingsUiPowerPayload;
  prices: SettingsUiPricesPayload;
};

export type SettingsUiFeatureAccess = {
  canToggleOverviewRedesign: boolean;
};

export type SettingsUiLogRequest = SettingsUiLogEntry;

export type SettingsUiPlanPendingTargetCommand = {
  desired: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: 'waiting_confirmation' | 'temporary_unavailable';
};

export type SettingsUiPlanDevice = DeviceOverviewSnapshot & {
  id: string;
  name: string;
  plannedTarget?: number | null;
  priority?: number;
  zone?: string;
  budgetExempt?: boolean;
  currentTemperature?: number;
  pendingTargetCommand?: SettingsUiPlanPendingTargetCommand;
};

export type SettingsUiPlanSnapshot = {
  generatedAtMs?: number;
  meta?: Record<string, unknown>;
  devices?: SettingsUiPlanDevice[];
};

export type SettingsUiPlanPayload = {
  plan: SettingsUiPlanSnapshot | null;
};

export type SettingsUiDevicesPayload = {
  devices: TargetDeviceSnapshot[];
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
