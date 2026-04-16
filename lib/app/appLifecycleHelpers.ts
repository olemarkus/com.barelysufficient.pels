import { incPerfCounters } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { normalizeError } from '../utils/errorUtils';
import type { AppContext } from './appContext';

function requirePriceCoordinator(ctx: AppContext) {
  if (!ctx.priceCoordinator) {
    throw new Error('PriceCoordinator must be initialized before app services start.');
  }
  return ctx.priceCoordinator;
}

function requirePlanService(ctx: AppContext) {
  if (!ctx.planService) {
    throw new Error('PlanService must be initialized before app services start.');
  }
  return ctx.planService;
}

function requireDailyBudgetService(ctx: AppContext) {
  if (!ctx.dailyBudgetService) {
    throw new Error('DailyBudgetService must be initialized before app services start.');
  }
  return ctx.dailyBudgetService;
}

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
  options?: {
    delayMs?: number;
    timerName?: string;
    ctx?: Pick<AppContext, 'timers'>;
  },
): void => {
  const { delayMs = 0, timerName = label, ctx } = options ?? {};
  if (delayMs <= 0) {
    runBackgroundTask(label, work, logError);
    return;
  }
  const timeout = setTimeout(() => {
    ctx?.timers.clear(timerName);
    runBackgroundTask(label, work, logError);
  }, delayMs);
  ctx?.timers.registerTimeout(timerName, timeout);
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
  const priceCoordinator = requirePriceCoordinator(appContext);
  const planService = requirePlanService(appContext);
  const dailyBudgetService = requireDailyBudgetService(appContext);
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
  await runStep('initOptimizer', async () => priceCoordinator.initOptimizer());
  await runStep('startHeartbeat', async () => appContext.startHeartbeat());
  scheduleBackgroundTask(
    'startup_update_overhead_token',
    () => appContext.updateOverheadToken(),
    logError,
    { delayMs: overheadTokenDelayMs, timerName: 'startupUpdateOverheadToken', ctx: appContext },
  );
  appContext.registerFlowCards();
  appContext.snapshotHelpers.startPeriodicSnapshotRefresh();
  appContext.homeyEnergyHelpers.start();
  priceCoordinator.startPriceRefresh();
  const bootstrapSnapshotAndPlan = async (): Promise<void> => {
    dailyBudgetService.updateState({ refreshObservedStats: false });
    await appContext.refreshTargetDevicesSnapshot({ fast: true, recordHomeyEnergySample: false });
    incPerfCounters([
      'plan_rebuild_requested_total',
      'plan_rebuild_requested.startup_total',
    ]);
    await planService.rebuildPlanFromCache('startup_snapshot_bootstrap');
  };
  const bootstrapPricePipeline = async (): Promise<void> => {
    await priceCoordinator.refreshSpotPrices();
    await priceCoordinator.refreshGridTariffData();
    await priceCoordinator.startPriceOptimization(applyPriceOptimizationImmediatelyOnStart);
  };

  if (runSnapshotPlanBootstrapInBackground) {
    scheduleBackgroundTask(
      'startup_snapshot_and_plan_bootstrap',
      bootstrapSnapshotAndPlan,
      logError,
      {
        delayMs: snapshotPlanBootstrapDelayMs,
        timerName: 'startupSnapshotAndPlanBootstrap',
        ctx: appContext,
      },
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
