import Homey from 'homey';
import CapacityGuard from './capacityGuard';
export type PriceServiceLike = {
  refreshNettleieData: (forceRefresh?: boolean) => Promise<void>;
  refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
};

export type SettingsHandlerDeps = {
  homey: Homey.App['homey'];
  loadCapacitySettings: () => void;
  rebuildPlanFromCache: () => void;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  loadPowerTracker: () => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  loadPriceOptimizationSettings: () => void;
  priceService: PriceServiceLike;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateOverheadToken: (value?: number) => void;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  errorLog: (message: string, error: unknown) => void;
};

export function createSettingsHandler(deps: SettingsHandlerDeps): (key: string) => void {
  const handlers: Record<string, () => void> = {
    mode_device_targets: () => handleModeTargetsChange(deps),
    operating_mode: () => handleModeTargetsChange(deps),
    mode_aliases: () => deps.loadCapacitySettings(),
    capacity_priorities: () => {
      deps.loadCapacitySettings();
      deps.rebuildPlanFromCache();
    },
    controllable_devices: () => {
      deps.loadCapacitySettings();
      refreshSnapshotWithLog(deps, 'Failed to refresh devices after controllable change');
    },
    power_tracker_state: () => deps.loadPowerTracker(),
    capacity_limit_kw: () => handleCapacityLimitChange(deps),
    capacity_margin_kw: () => handleCapacityLimitChange(deps),
    capacity_dry_run: () => {
      deps.loadCapacitySettings();
      deps.rebuildPlanFromCache();
    },
    refresh_target_devices_snapshot: () => {
      refreshSnapshotWithLog(deps, 'Failed to refresh target devices snapshot');
    },
    refresh_nettleie: () => {
      deps.priceService.refreshNettleieData(true).catch((error: Error) => {
        deps.errorLog('Failed to refresh nettleie data', error);
      });
    },
    refresh_spot_prices: () => {
      deps.priceService.refreshSpotPrices(true).catch((error: Error) => {
        deps.errorLog('Failed to refresh spot prices', error);
      });
    },
    price_optimization_settings: () => {
      deps.loadPriceOptimizationSettings();
      refreshSnapshotWithLog(deps, 'Failed to refresh plan after price optimization settings change');
    },
    overshoot_behaviors: () => {
      deps.loadCapacitySettings();
      deps.rebuildPlanFromCache();
    },
    price_optimization_enabled: () => {
      deps.updatePriceOptimizationEnabled(true);
      deps.rebuildPlanFromCache();
    },
    debug_logging_enabled: () => deps.updateDebugLoggingEnabled(true),
  };

  return (key: string) => {
    const handler = handlers[key];
    if (handler) {
      handler();
    }
  };
}

function handleModeTargetsChange(deps: SettingsHandlerDeps): void {
  deps.loadCapacitySettings();
  deps.refreshTargetDevicesSnapshot().then(() => {
    deps.rebuildPlanFromCache();
  }).catch((error: Error) => {
    deps.errorLog('Failed to refresh devices after mode target change', error);
    deps.rebuildPlanFromCache();
  });
}

function handleCapacityLimitChange(deps: SettingsHandlerDeps): void {
  deps.loadCapacitySettings();
  const guard = deps.getCapacityGuard();
  const { limitKw, marginKw } = deps.getCapacitySettings();
  guard?.setLimit(limitKw);
  guard?.setSoftMargin(marginKw);
  deps.updateOverheadToken(marginKw);
  deps.rebuildPlanFromCache();
}

function refreshSnapshotWithLog(deps: SettingsHandlerDeps, message: string): void {
  deps.refreshTargetDevicesSnapshot().catch((error: Error) => {
    deps.errorLog(message, error);
  });
}
