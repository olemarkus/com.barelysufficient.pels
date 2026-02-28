import { incPerfCounters } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';

const toError = (value: unknown): Error => (
  value instanceof Error ? value : new Error(String(value))
);

const runBackgroundTask = (
  label: string,
  work: () => void | Promise<void>,
  logError?: (label: string, error: Error) => void,
): void => {
  const stopSpan = startRuntimeSpan(label);
  void Promise.resolve()
    .then(work)
    .catch((error) => {
      if (typeof logError === 'function') {
        logError(label, toError(error));
      }
    })
    .finally(() => {
      stopSpan();
    });
};

const scheduleBackgroundTask = (
  label: string,
  work: () => void | Promise<void>,
  logError?: (label: string, error: Error) => void,
  delayMs = 0,
): void => {
  if (delayMs <= 0) {
    runBackgroundTask(label, work, logError);
    return;
  }
  const timeout = setTimeout(() => {
    runBackgroundTask(label, work, logError);
  }, delayMs);
  (timeout as { unref?: () => void }).unref?.();
};

const runStep = async (
  label: string,
  work: () => void | Promise<void>,
): Promise<void> => {
  const stopSpan = startRuntimeSpan(`startup_service(${label})`);
  try {
    await work();
  } finally {
    stopSpan();
  }
};

export const runStartupStep = async <T>(
  label: string,
  work: () => T | Promise<T>,
): Promise<T> => {
  const stopSpan = startRuntimeSpan(`startup_step(${label})`);
  try {
    return await work();
  } finally {
    stopSpan();
  }
};

export async function startAppServices(params: {
  loadPowerTracker: (options?: { skipDailyBudgetUpdate?: boolean }) => void;
  loadPriceOptimizationSettings: () => void;
  initOptimizer: () => void;
  startHeartbeat: () => void;
  updateOverheadToken: () => Promise<void>;
  refreshDailyBudgetState?: () => void;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  rebuildPlanFromCache: () => Promise<void>;
  setLastNotifiedOperatingMode: (mode: string) => void;
  getOperatingMode: () => string;
  registerFlowCards: () => void;
  startPeriodicSnapshotRefresh: () => void;
  refreshSpotPrices: () => Promise<void>;
  refreshGridTariffData: () => Promise<void>;
  startPriceRefresh: () => void;
  startPriceOptimization: (applyImmediately?: boolean) => Promise<void>;
  logError?: (label: string, error: Error) => void;
  snapshotPlanBootstrapDelayMs?: number;
  overheadTokenDelayMs?: number;
  runSnapshotPlanBootstrapInBackground?: boolean;
  runPriceBootstrapInBackground?: boolean;
  applyPriceOptimizationImmediatelyOnStart?: boolean;
}): Promise<void> {
  const {
    loadPowerTracker,
    loadPriceOptimizationSettings,
    initOptimizer,
    startHeartbeat,
    updateOverheadToken,
    refreshDailyBudgetState,
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
    logError,
    snapshotPlanBootstrapDelayMs = 0,
    overheadTokenDelayMs = 0,
    runSnapshotPlanBootstrapInBackground = true,
    runPriceBootstrapInBackground = true,
    applyPriceOptimizationImmediatelyOnStart = false,
  } = params;
  await runStep('loadPowerTracker', async () => loadPowerTracker({ skipDailyBudgetUpdate: true }));
  await runStep('loadPriceOptimizationSettings', async () => loadPriceOptimizationSettings());
  await runStep('initOptimizer', async () => initOptimizer());
  await runStep('startHeartbeat', async () => startHeartbeat());
  scheduleBackgroundTask('startup_update_overhead_token', updateOverheadToken, logError, overheadTokenDelayMs);
  setLastNotifiedOperatingMode(getOperatingMode());
  registerFlowCards();
  startPeriodicSnapshotRefresh();
  startPriceRefresh();
  const bootstrapSnapshotAndPlan = async (): Promise<void> => {
    if (typeof refreshDailyBudgetState === 'function') {
      refreshDailyBudgetState();
    }
    await refreshTargetDevicesSnapshot();
    incPerfCounters([
      'plan_rebuild_requested_total',
      'plan_rebuild_requested.startup_total',
    ]);
    await rebuildPlanFromCache();
  };
  const bootstrapPricePipeline = async (): Promise<void> => {
    await refreshSpotPrices();
    await refreshGridTariffData();
    await startPriceOptimization(applyPriceOptimizationImmediatelyOnStart);
  };

  if (runSnapshotPlanBootstrapInBackground) {
    scheduleBackgroundTask(
      'startup_snapshot_and_plan_bootstrap',
      bootstrapSnapshotAndPlan,
      logError,
      snapshotPlanBootstrapDelayMs,
    );
  } else {
    await runStep('startupSnapshotPlanBootstrap', bootstrapSnapshotAndPlan);
  }

  if (runPriceBootstrapInBackground) {
    runBackgroundTask('startup_price_bootstrap', bootstrapPricePipeline, logError);
    return;
  }

  await runStep('startupPriceBootstrap', bootstrapPricePipeline);
}
