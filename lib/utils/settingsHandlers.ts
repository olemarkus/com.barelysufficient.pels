import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import type { SettingsUiLogEntry } from './types';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_SCHEME,
} from './settingsKeys';
import { incPerfCounters } from './perfCounters';
export type PriceServiceLike = {
  refreshGridTariffData: (forceRefresh?: boolean) => Promise<void>;
  refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
  updateCombinedPrices: () => void;
};

export type SettingsHandlerDeps = {
  homey: Homey.App['homey'];
  loadCapacitySettings: () => void;
  rebuildPlanFromCache: () => Promise<void>;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  loadPowerTracker: () => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  loadPriceOptimizationSettings: () => void;
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: { forcePlanRebuild?: boolean }) => void;
  resetDailyBudgetLearning: () => void;
  priceService: PriceServiceLike;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  log: (message: string) => void;
  errorLog: (message: string, error: unknown) => void;
};

export function createSettingsHandler(deps: SettingsHandlerDeps): (key: string) => Promise<void> {
  const refreshPriceDerivedState = async () => {
    deps.priceService.updateCombinedPrices();
    await handleDailyBudgetPriceChange(deps);
  };
  const handlers: Record<string, () => Promise<void>> = {
    mode_device_targets: async () => handleModeTargetsChange(deps),
    [OPERATING_MODE_SETTING]: async () => handleModeTargetsChange(deps),
    mode_aliases: async () => deps.loadCapacitySettings(),
    capacity_priorities: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_priorities');
    },
    controllable_devices: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after controllable change');
      await rebuildPlanFromSettings(deps, 'controllable_devices');
    },
    [MANAGED_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after managed change');
      await rebuildPlanFromSettings(deps, 'managed_devices');
    },
    power_tracker_state: async () => deps.loadPowerTracker(),
    [CAPACITY_LIMIT_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_MARGIN_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_DRY_RUN]: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_dry_run');
    },
    refresh_target_devices_snapshot: async () => {
      await refreshSnapshotWithLog(deps, 'Failed to refresh target devices snapshot');
    },
    refresh_nettleie: async () => {
      try {
        await deps.priceService.refreshGridTariffData(true);
      } catch (error) {
        deps.errorLog('Failed to refresh grid tariff data', error);
      }
    },
    refresh_spot_prices: async () => {
      try {
        await deps.priceService.refreshSpotPrices(true);
      } catch (error) {
        deps.errorLog('Failed to refresh spot prices', error);
      }
    },
    [PRICE_SCHEME]: async () => {
      await refreshPriceDerivedState();
    },
    [FLOW_PRICES_TODAY]: async () => {
      await refreshPriceDerivedState();
    },
    [FLOW_PRICES_TOMORROW]: async () => {
      await refreshPriceDerivedState();
    },
    [HOMEY_PRICES_TODAY]: async () => {
      await refreshPriceDerivedState();
    },
    [HOMEY_PRICES_TOMORROW]: async () => {
      await refreshPriceDerivedState();
    },
    [HOMEY_PRICES_CURRENCY]: async () => {
      await refreshPriceDerivedState();
    },
    price_threshold_percent: async () => {
      await refreshPriceDerivedState();
    },
    price_min_diff_ore: async () => {
      await refreshPriceDerivedState();
    },
    [PRICE_OPTIMIZATION_SETTINGS]: async () => {
      deps.loadPriceOptimizationSettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh plan after price optimization settings change');
    },
    [DAILY_BUDGET_ENABLED]: async () => handleDailyBudgetChange(deps),
    [DAILY_BUDGET_KWH]: async () => handleDailyBudgetChange(deps),
    [DAILY_BUDGET_PRICE_SHAPING_ENABLED]: async () => handleDailyBudgetChange(deps),
    [COMBINED_PRICES]: async () => handleDailyBudgetPriceChange(deps),
    [DAILY_BUDGET_CONTROLLED_WEIGHT]: async () => handleDailyBudgetChange(deps),
    [DAILY_BUDGET_PRICE_FLEX_SHARE]: async () => handleDailyBudgetChange(deps),
    overshoot_behaviors: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'overshoot_behaviors');
    },
    [PRICE_OPTIMIZATION_ENABLED]: async () => {
      deps.updatePriceOptimizationEnabled(true);
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      await rebuildPlanFromSettings(deps, 'price_optimization_enabled');
    },
    [DAILY_BUDGET_RESET]: async () => {
      deps.resetDailyBudgetLearning();
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      deps.homey.settings.set(DAILY_BUDGET_RESET, null);
      await rebuildPlanFromSettings(deps, 'daily_budget_reset');
    },
    debug_logging_enabled: async () => deps.updateDebugLoggingEnabled(true),
    [DEBUG_LOGGING_TOPICS]: async () => deps.updateDebugLoggingEnabled(true),
    settings_ui_log: async () => handleSettingsUiLog(deps),
  };

  let queue = Promise.resolve();
  return async (key: string) => {
    const handler = handlers[key];
    if (!handler) return;
    queue = queue.then(() => handler()).catch((error) => {
      deps.errorLog('Settings handler failed', error);
    });
    await queue;
  };
}

const formatSettingsUiMessage = (entry: SettingsUiLogEntry) => {
  const context = entry.context ? ` (${entry.context})` : '';
  const detail = entry.detail ? ` - ${entry.detail}` : '';
  return `Settings UI${context}: ${entry.message}${detail}`;
};

const handleSettingsUiLog = async (deps: SettingsHandlerDeps): Promise<void> => {
  const raw = deps.homey.settings.get('settings_ui_log') as unknown;
  if (!raw || typeof raw !== 'object') return;
  const entry = raw as SettingsUiLogEntry;
  if (!entry.level || !entry.message) return;

  const message = formatSettingsUiMessage(entry);
  if (entry.level === 'error') {
    deps.errorLog(message, new Error(entry.detail || entry.message));
  } else if (entry.level === 'warn') {
    deps.log(`Warning: ${message}`);
  } else {
    deps.log(message);
  }

  deps.homey.settings.set('settings_ui_log', null);
};

async function handleModeTargetsChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadCapacitySettings();
  try {
    await deps.refreshTargetDevicesSnapshot();
    await rebuildPlanFromSettings(deps, 'mode_targets');
  } catch (error) {
    deps.errorLog('Failed to refresh devices after mode target change', error);
    await rebuildPlanFromSettings(deps, 'mode_targets_fallback');
  }
}

async function handleCapacityLimitChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadCapacitySettings();
  const guard = deps.getCapacityGuard();
  const { limitKw, marginKw } = deps.getCapacitySettings();
  guard?.setLimit(limitKw);
  guard?.setSoftMargin(marginKw);
  await deps.updateOverheadToken(marginKw);
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await rebuildPlanFromSettings(deps, 'capacity_limit_or_margin');
}

async function handleDailyBudgetChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadDailyBudgetSettings();
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await rebuildPlanFromSettings(deps, 'daily_budget_settings');
}

async function handleDailyBudgetPriceChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await rebuildPlanFromSettings(deps, 'daily_budget_price');
}

function recordSettingsRebuildRequest(source: string): void {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.settings_total',
    `plan_rebuild_requested.settings.${source}_total`,
  ]);
}

async function rebuildPlanFromSettings(deps: SettingsHandlerDeps, source: string): Promise<void> {
  recordSettingsRebuildRequest(source);
  await deps.rebuildPlanFromCache();
}

async function refreshSnapshotWithLog(deps: SettingsHandlerDeps, message: string): Promise<void> {
  try {
    await deps.refreshTargetDevicesSnapshot();
  } catch (error) {
    deps.errorLog(message, error);
  }
}
