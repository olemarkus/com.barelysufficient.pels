import type { InitializedAppContext } from '../../lib/app/appContext';
import type { TaskEvaluationSource } from '../../lib/objectives/deferredObjectives';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { BackgroundTasksController } from '../backgroundTasksController';
import type { AppRuntimeHandles } from '../appRuntimeHandles';
import { createDeferredObjectiveLifecycleEmitter } from './deferredObjectiveLifecycle';
import { startBackgroundCollectors } from './startBackgroundCollectors';
import { wireBudgetPrice } from './wireBudgetPrice';
import { wireContinuousBatteryPlan } from './wireContinuousBatteryPlan';
import { createTaskReservationSource } from './createTaskReservationSource';
import { wireCurtailmentSurplus } from './wireCurtailmentSurplus';
import { startSoleMeterAdoption } from '../soleMeterAdoption';
export { startCapacityMarketDefault } from '../capacityMarketDefault';

const NATIVE_WIRING_REQUERY_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The background work that starts once ordered startup has finished. The
 * collectors it starts are handed to the app's runtime handles, which stop
 * them at uninit.
 */
export const startPostStartupBackgroundTasks = (
  ctx: InitializedAppContext,
  taskEvaluationSource: TaskEvaluationSource,
  backgroundTasks: BackgroundTasksController,
  timers: TimerRegistry,
  handles: AppRuntimeHandles,
  subscribeDeviceSnapshotCommitted: (listener: () => void) => void,
  getDailyKwh: Parameters<typeof startBackgroundCollectors>[2],
): void => {
  // Name the whole-home meter for an install that has none chosen, when Homey
  // Energy lists exactly one. Self-delaying, so it runs after the settings
  // handlers are wired and reacts like an owner's pick would.
  startSoleMeterAdoption(ctx.homey, timers, ctx.getTrackerStore(), () => ctx.powerTracker.lastTimestamp);
  const collectors = startBackgroundCollectors(
    ctx,
    (collectorCtx) => backgroundTasks.startWeatherCollector(collectorCtx),
    getDailyKwh,
  );
  // eslint-disable-next-line functional/immutable-data, no-param-reassign -- the composition root's handles
  handles.backgroundCollectors = collectors;
  // A committed snapshot can make Homey's solar forecast applicable or
  // inapplicable. The controller owns the transition latch, so routine device
  // polls do not fetch forecasts; wiring only connects the snapshot fact.
  subscribeDeviceSnapshotCommitted(
    () => { void collectors.homeySolarForecast.refreshEligibility(); },
  );
  // The collector factory constructs one live selector for all forecast consumers.
  const { getSelectedPvForecast } = collectors;
  wireBudgetPrice(ctx, (ms) => getSelectedPvForecast().forecast([ms])[0]?.generationKwh);
  wireContinuousBatteryPlan(
    ctx,
    createTaskReservationSource(ctx, taskEvaluationSource),
    getSelectedPvForecast,
    taskEvaluationSource.getPrioritiesForDevices,
  );
  // Provenance for the settings UI's Solar forecast section — read from the
  // live selector so the UI can never disagree with what planning consumes.
  // Both availability flags ask the producer whether it can answer for the
  // hours AHEAD, never whether it merely holds a model: a fit restored from
  // persistence with no forward irradiance forecasts nothing, and the section
  // would have claimed planning was using it.
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.getPvForecastSourceUiStatus = () => ({
    kind: 'selected',
    activeSource: getSelectedPvForecast().sourceId,
    homeyForecastAvailable: collectors.homeySolarForecast.source.hasUsefulForecast(Date.now()),
    learnedForecastAvailable: collectors.pvForecast.service.hasForwardForecast(Date.now()),
  });
  const recomputeCombinedPrices = (): void => {
    try {
      ctx.priceCoordinator.updateCombinedPrices();
    } catch (error) {
      ctx.getStructuredLogger('solar').warn({
        event: 'pv_forecast_price_recompute_failed',
        err: normalizeError(error),
      });
    }
  };
  collectors.pvForecast.setOnRefreshed(recomputeCombinedPrices);
  // Registered AFTER wireBudgetPrice for the same reason as the learned hook:
  // a completion must never trigger a combined-prices recompute before the
  // planning-price inputs exist. Fresh (or vanished) Homey points can change
  // the forecast the planning price reads, so the hook keeps the persisted
  // planning price current.
  collectors.homeySolarForecast.setOnRefreshed(recomputeCombinedPrices);
  const curtailment = wireCurtailmentSurplus(ctx, getSelectedPvForecast);
  // AppContext exposes these optional late-bound runtime seams by mutation.
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.recordCurtailmentSample = (netW, generationW, nowMs) => (
    curtailment.recordSample(netW, generationW, nowMs)
  );
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.getCurtailedSurplusKw = () => curtailment.getCurtailedSurplusKw(Date.now());
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.canContributeCurtailmentSurplus = () => curtailment.canContributeSurplus();
  backgroundTasks.startDeferredObjectiveLifecycleClock(
    createDeferredObjectiveLifecycleEmitter(ctx, taskEvaluationSource),
  );
  ctx.builtInControlFlowConflicts.runBackgroundScan();
  timers.registerInterval('nativeWiringRequery', setInterval(
    () => ctx.builtInControlFlowConflicts.runBackgroundScan(),
    NATIVE_WIRING_REQUERY_INTERVAL_MS,
  ));
};
