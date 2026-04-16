import { incPerfCounters } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { normalizeError } from '../utils/errorUtils';
import type { AppContext } from './appContext';

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
        logError(label, normalizeError(error));
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
  onError?: (label: string, error: Error) => void,
): Promise<T> => {
  const stopSpan = startRuntimeSpan(`startup_step(${label})`);
  try {
    return await work();
  } catch (error) {
    const normalizedError = normalizeError(error);
    if (typeof onError === 'function') {
      onError(label, normalizedError);
    }
    throw normalizedError;
  } finally {
    stopSpan();
  }
};

export async function startAppServices(ctx: AppContext): Promise<void> {
  const appContext = ctx;
  const {
    logStartupStepFailure: logError,
    snapshotPlanBootstrapDelayMs = 0,
    overheadTokenDelayMs = 0,
    runSnapshotPlanBootstrapInBackground = true,
    runPriceBootstrapInBackground = true,
    applyPriceOptimizationImmediatelyOnStart = false,
  } = {
    logStartupStepFailure: ctx.getStructuredLogger('startup')
      ? (label: string, error: Error) => {
        ctx.getStructuredLogger('startup')?.error({
          event: 'startup_background_task_failed',
          reasonCode: 'startup_background_task_failed',
          taskLabel: label,
          err: normalizeError(error),
        });
      }
      : undefined,
    ...appContext.startupBootstrap,
  };
  await runStep('loadPowerTracker', async () => appContext.loadPowerTracker({ skipDailyBudgetUpdate: true }));
  await runStep('loadPriceOptimizationSettings', async () => appContext.loadPriceOptimizationSettings());
  await runStep('initOptimizer', async () => appContext.priceCoordinator?.initOptimizer());
  await runStep('startHeartbeat', async () => appContext.startHeartbeat());
  scheduleBackgroundTask(
    'startup_update_overhead_token',
    () => appContext.updateOverheadToken(),
    logError,
    overheadTokenDelayMs,
  );
  appContext.registerFlowCards();
  appContext.snapshotHelpers.startPeriodicSnapshotRefresh();
  appContext.homeyEnergyHelpers.start();
  appContext.priceCoordinator?.startPriceRefresh();
  const bootstrapSnapshotAndPlan = async (): Promise<void> => {
    appContext.dailyBudgetService?.updateState({ refreshObservedStats: false });
    await appContext.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });
    incPerfCounters([
      'plan_rebuild_requested_total',
      'plan_rebuild_requested.startup_total',
    ]);
    await appContext.planService?.rebuildPlanFromCache('startup_snapshot_bootstrap');
  };
  const bootstrapPricePipeline = async (): Promise<void> => {
    await appContext.priceCoordinator?.refreshSpotPrices();
    await appContext.priceCoordinator?.refreshGridTariffData();
    await appContext.priceCoordinator?.startPriceOptimization(applyPriceOptimizationImmediatelyOnStart);
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
