import Homey from 'homey';
import CapacityGuard from './capacityGuard';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
} from './settingsKeys';
export type PriceServiceLike = {
  refreshNettleieData: (forceRefresh?: boolean) => Promise<void>;
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
  priceService: PriceServiceLike;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
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
        await deps.priceService.refreshNettleieData(true);
      } catch (error) {
        deps.errorLog('Failed to refresh nettleie data', error);
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
    overshoot_behaviors: async () => {
      deps.loadCapacitySettings();
      await deps.rebuildPlanFromCache();
    },
    price_optimization_enabled: async () => {
      deps.updatePriceOptimizationEnabled(true);
      await deps.rebuildPlanFromCache();
    },
    debug_logging_enabled: async () => deps.updateDebugLoggingEnabled(true),
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
  await deps.rebuildPlanFromCache();
}

async function refreshSnapshotWithLog(deps: SettingsHandlerDeps, message: string): Promise<void> {
  try {
    await deps.refreshTargetDevicesSnapshot();
  } catch (error) {
    deps.errorLog(message, error);
  }
}
