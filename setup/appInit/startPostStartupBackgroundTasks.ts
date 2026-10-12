import type { InitializedAppContext } from '../../lib/app/appContext';
import type { ModePriorityOrder } from '../../packages/shared-domain/src/settings/modePriorities';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { BackgroundTasksController } from '../backgroundTasksController';
import type { AppNativeWiring } from '../appNativeWiring';
import type { AppRuntimeHandles } from '../appRuntimeHandles';
import { createPvForecastSourceSelector } from './createPvForecastSourceSelector';
import { getLogger } from '../../lib/logging/logger';
import { createDeferredObjectiveLifecycleEmitter } from './deferredObjectiveLifecycle';
import { startBackgroundCollectors } from './startBackgroundCollectors';
import { wireBudgetPrice } from './wireBudgetPrice';
import { wireCurtailmentSurplus } from './wireCurtailmentSurplus';
import { startSoleMeterAdoption } from '../soleMeterAdoption';

const NATIVE_WIRING_REQUERY_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The background work that starts once ordered startup has finished. The
 * collectors it starts are handed to the app's runtime handles, which stop
 * them at uninit.
 */
export const startPostStartupBackgroundTasks = (
  ctx: InitializedAppContext,
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder,
  backgroundTasks: BackgroundTasksController,
  timers: TimerRegistry,
  handles: AppRuntimeHandles,
  nativeWiring: AppNativeWiring,
  subscribeDeviceSnapshotCommitted: (listener: () => void) => void,
): void => {
  // Name the whole-home meter for an install that has none chosen, when Homey
  // Energy lists exactly one. Self-delaying, so it runs after the settings
  // handlers are wired and reacts like an owner's pick would.
  startSoleMeterAdoption(ctx.homey, timers, ctx.getTrackerStore(), () => ctx.powerTracker.lastTimestamp);
  const collectors = startBackgroundCollectors(
    ctx,
    (collectorCtx) => backgroundTasks.startWeatherCollector(collectorCtx),
  );
  // eslint-disable-next-line functional/immutable-data, no-param-reassign -- the composition root's handles
  handles.backgroundCollectors = collectors;
  // A committed snapshot can make Homey's solar forecast applicable or
  // inapplicable. The controller owns the transition latch, so routine device
  // polls do not fetch forecasts; wiring only connects the snapshot fact.
  subscribeDeviceSnapshotCommitted(
    () => { void collectors.homeySolarForecast.refreshEligibility(); },
  );
  // ONE selector closure feeds both forecast consumers, so the budget price and
  // the curtailment potential always read the same selected source.
  // Both controllers are in hand HERE, so the selector takes them by value and
  // answers a selected source on every call — no "not wired yet" state travels
  // to the consumers below.
  const getSelectedPvForecast = createPvForecastSourceSelector({
    learned: collectors.pvForecast,
    homey: collectors.homeySolarForecast,
    getNowMs: () => Date.now(),
    logger: getLogger('solar'),
  });
  wireBudgetPrice(ctx, (ms) => getSelectedPvForecast().forecast([ms])[0]?.generationKwh);
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
      ctx.getStructuredLogger('solar')?.warn({
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
    createDeferredObjectiveLifecycleEmitter(ctx, getPrioritiesForDevices),
  );
  nativeWiring.runNativeWiringDetectionBestEffort();
  timers.registerInterval('nativeWiringRequery', setInterval(
    () => nativeWiring.runNativeWiringDetectionBestEffort(),
    NATIVE_WIRING_REQUERY_INTERVAL_MS,
  ));
};
