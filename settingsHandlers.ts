import Homey from 'homey';
import CapacityGuard from './capacityGuard';
import PriceService from './priceService';

export interface SettingsHandlerDeps {
  homey: Homey.App['homey'];
  loadCapacitySettings: () => void;
  applyDeviceTargetsForMode: (mode: string) => Promise<void>;
  rebuildPlanFromCache: () => void;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  loadPowerTracker: () => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  loadPriceOptimizationSettings: () => void;
  priceService: PriceService;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  errorLog: (message: string, error: unknown) => void;
}

export function createSettingsHandler(deps: SettingsHandlerDeps): (key: string) => void {
  return (key: string) => {
    switch (key) {
      case 'mode_device_targets':
      case 'operating_mode': {
        deps.loadCapacitySettings();
        const mode = deps.homey.settings.get('operating_mode') || 'Home';
        deps.applyDeviceTargetsForMode(mode).catch((error: Error) => {
          deps.errorLog('Failed to apply per-mode device targets', error);
        });
        deps.rebuildPlanFromCache();
        break;
      }
      case 'mode_aliases':
        deps.loadCapacitySettings();
        break;
      case 'capacity_priorities':
        deps.loadCapacitySettings();
        deps.rebuildPlanFromCache();
        break;
      case 'controllable_devices':
        deps.loadCapacitySettings();
        deps.refreshTargetDevicesSnapshot().catch((error: Error) => {
          deps.errorLog('Failed to refresh devices after controllable change', error);
        });
        break;
      case 'power_tracker_state':
        deps.loadPowerTracker();
        break;
      case 'capacity_limit_kw':
      case 'capacity_margin_kw': {
        deps.loadCapacitySettings();
        const guard = deps.getCapacityGuard();
        const { limitKw, marginKw } = deps.getCapacitySettings();
        guard?.setLimit(limitKw);
        guard?.setSoftMargin(marginKw);
        deps.rebuildPlanFromCache();
        break;
      }
      case 'capacity_dry_run': {
        deps.loadCapacitySettings();
        // Guard no longer has dry run mode - Plan handles shedding decisions
        deps.rebuildPlanFromCache();
        break;
      }
      case 'refresh_target_devices_snapshot':
        deps.refreshTargetDevicesSnapshot().catch((error: Error) => {
          deps.errorLog('Failed to refresh target devices snapshot', error);
        });
        break;
      case 'refresh_nettleie':
        deps.priceService.refreshNettleieData(true).catch((error: Error) => {
          deps.errorLog('Failed to refresh nettleie data', error);
        });
        break;
      case 'refresh_spot_prices':
        deps.priceService.refreshSpotPrices(true).catch((error: Error) => {
          deps.errorLog('Failed to refresh spot prices', error);
        });
        break;
      case 'price_optimization_settings':
        deps.loadPriceOptimizationSettings();
        deps.refreshTargetDevicesSnapshot().catch((error: Error) => {
          deps.errorLog('Failed to refresh plan after price optimization settings change', error);
        });
        break;
      case 'price_optimization_enabled':
        deps.updatePriceOptimizationEnabled(true);
        break;
      default:
        break;
    }
  };
}
