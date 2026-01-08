import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import type { SettingsUiLogEntry } from './types';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from './settingsKeys';
export type PriceServiceLike = {
  refreshGridTariffData: (forceRefresh?: boolean) => Promise<void>;
  refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
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
  const handlers: Record<string, () => Promise<void>> = {
    mode_device_targets: async () => handleModeTargetsChange(deps),
    [OPERATING_MODE_SETTING]: async () => handleModeTargetsChange(deps),
    mode_aliases: async () => deps.loadCapacitySettings(),
    capacity_priorities: async () => {
      deps.loadCapacitySettings();
      await deps.rebuildPlanFromCache();
    },
    controllable_devices: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after controllable change');
      await deps.rebuildPlanFromCache();
    },
    [MANAGED_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after managed change');
      await deps.rebuildPlanFromCache();
    },
    power_tracker_state: async () => deps.loadPowerTracker(),
    [CAPACITY_LIMIT_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_MARGIN_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_DRY_RUN]: async () => {
      deps.loadCapacitySettings();
      await deps.rebuildPlanFromCache();
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
    price_optimization_settings: async () => {
      deps.loadPriceOptimizationSettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh plan after price optimization settings change');
    },
    [DAILY_BUDGET_ENABLED]: async () => handleDailyBudgetChange(deps),
    [DAILY_BUDGET_KWH]: async () => handleDailyBudgetChange(deps),
    [DAILY_BUDGET_PRICE_SHAPING_ENABLED]: async () => handleDailyBudgetChange(deps),
    combined_prices: async () => handleDailyBudgetPriceChange(deps),
    overshoot_behaviors: async () => {
      deps.loadCapacitySettings();
      await deps.rebuildPlanFromCache();
    },
    price_optimization_enabled: async () => {
      deps.updatePriceOptimizationEnabled(true);
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      await deps.rebuildPlanFromCache();
    },
    [DAILY_BUDGET_RESET]: async () => {
      deps.resetDailyBudgetLearning();
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      deps.homey.settings.set(DAILY_BUDGET_RESET, null);
      await deps.rebuildPlanFromCache();
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
    await deps.rebuildPlanFromCache();
  } catch (error) {
    deps.errorLog('Failed to refresh devices after mode target change', error);
    await deps.rebuildPlanFromCache();
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
  await deps.rebuildPlanFromCache();
}

async function handleDailyBudgetChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadDailyBudgetSettings();
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await deps.rebuildPlanFromCache();
}

async function handleDailyBudgetPriceChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await deps.rebuildPlanFromCache();
}

async function refreshSnapshotWithLog(deps: SettingsHandlerDeps, message: string): Promise<void> {
  try {
    await deps.refreshTargetDevicesSnapshot();
  } catch (error) {
    deps.errorLog(message, error);
  }
}
