import { incPerfCounters } from '../utils/perfCounters';

export async function startAppServices(params: {
  loadPowerTracker: () => void;
  loadPriceOptimizationSettings: () => void;
  initOptimizer: () => void;
  startHeartbeat: () => void;
  updateOverheadToken: () => Promise<void>;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  rebuildPlanFromCache: () => Promise<void>;
  setLastNotifiedOperatingMode: (mode: string) => void;
  getOperatingMode: () => string;
  registerFlowCards: () => void;
  startPeriodicSnapshotRefresh: () => void;
  refreshSpotPrices: () => Promise<void>;
  refreshGridTariffData: () => Promise<void>;
  startPriceRefresh: () => void;
  startPriceOptimization: () => Promise<void>;
}): Promise<void> {
  const {
    loadPowerTracker,
    loadPriceOptimizationSettings,
    initOptimizer,
    startHeartbeat,
    updateOverheadToken,
    refreshTargetDevicesSnapshot,
    rebuildPlanFromCache,
    setLastNotifiedOperatingMode,
    getOperatingMode,
    registerFlowCards,
    startPeriodicSnapshotRefresh,
    refreshSpotPrices,
    refreshGridTariffData,
    startPriceRefresh,
    startPriceOptimization,
  } = params;
  loadPowerTracker();
  loadPriceOptimizationSettings();
  initOptimizer();
  startHeartbeat();
  void updateOverheadToken();
  await refreshTargetDevicesSnapshot();
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.startup_total',
  ]);
  await rebuildPlanFromCache();
  setLastNotifiedOperatingMode(getOperatingMode());
  registerFlowCards();
  startPeriodicSnapshotRefresh();
  await refreshSpotPrices();
  await refreshGridTariffData();
  startPriceRefresh();
  await startPriceOptimization();
}
