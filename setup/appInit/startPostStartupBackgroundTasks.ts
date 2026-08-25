import type { InitializedAppContext } from '../../lib/app/appContext';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import type { BackgroundTasksController } from '../backgroundTasksController';
import type { PvForecastController } from './createPvForecastService';
import type { HomeySolarForecastController } from '../../lib/solar/homeySolarForecastController';
import { createPvForecastSourceSelector } from './createPvForecastSourceSelector';
import { getLogger } from '../../lib/logging/logger';
import { createDeferredObjectiveLifecycleEmitter } from './deferredObjectiveLifecycle';
import { startBackgroundCollectors } from './startBackgroundCollectors';
import { wireBudgetPrice } from './wireBudgetPrice';
import { wireCurtailmentSurplus } from './wireCurtailmentSurplus';

const NATIVE_WIRING_REQUERY_INTERVAL_MS = 30 * 60 * 1000;

export type PostStartupBackgroundDeps = {
  ctx: InitializedAppContext;
  backgroundTasks: BackgroundTasksController;
  timers: TimerRegistry;
  startPowerTrackerPruning: () => void;
  setWeatherCollector: (collector: WeatherCollector | undefined) => void;
  getPvForecast: () => PvForecastController | undefined;
  setPvForecast: (pvForecast: PvForecastController | undefined) => void;
  setHomeySolarForecast: (controller: HomeySolarForecastController | undefined) => void;
  getHomeySolarForecast: () => HomeySolarForecastController | undefined;
  runNativeWiringDetectionBestEffort: () => void;
};

export const startPostStartupBackgroundTasks = (
  deps: PostStartupBackgroundDeps,
): void => {
  const { ctx } = deps;
  deps.startPowerTrackerPruning();
  const collectors = startBackgroundCollectors(
    ctx,
    (collectorCtx) => deps.backgroundTasks.startWeatherCollector(collectorCtx),
  );
  deps.setWeatherCollector(collectors.weatherCollector);
  deps.setPvForecast(collectors.pvForecast);
  deps.setHomeySolarForecast(collectors.homeySolarForecast);
  // ONE selector closure feeds both forecast consumers, so the budget price and
  // the curtailment potential always read the same selected source.
  const getSelectedPvForecast = createPvForecastSourceSelector({
    getLearned: deps.getPvForecast,
    getHomey: deps.getHomeySolarForecast,
    getNowMs: () => Date.now(),
    logger: getLogger('solar'),
  });
  wireBudgetPrice(ctx, (ms) => getSelectedPvForecast()?.forecast([ms])[0]?.generationKwh);
  // Provenance for the settings UI's Solar forecast section — read from the
  // live selector so the UI can never disagree with what planning consumes.
  // Both availability flags ask the producer whether it can answer for the
  // hours AHEAD, never whether it merely holds a model: a fit restored from
  // persistence with no forward irradiance forecasts nothing, and the section
  // would have claimed planning was using it.
  // eslint-disable-next-line functional/immutable-data
  ctx.getPvForecastSourceUiStatus = () => ({
    activeSource: getSelectedPvForecast()?.sourceId ?? null,
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
  deps.getPvForecast()?.setOnRefreshed(recomputeCombinedPrices);
  // Registered AFTER wireBudgetPrice for the same reason as the learned hook:
  // a completion must never trigger a combined-prices recompute before the
  // planning-price inputs exist. Fresh (or vanished) Homey points can change
  // the forecast the planning price reads, so the hook keeps the persisted
  // planning price current.
  collectors.homeySolarForecast.setOnRefreshed(recomputeCombinedPrices);
  const curtailment = wireCurtailmentSurplus(ctx, getSelectedPvForecast);
  // AppContext exposes these optional late-bound runtime seams by mutation.
  // eslint-disable-next-line functional/immutable-data
  ctx.recordCurtailmentSample = (netW, generationW, nowMs) => (
    curtailment.recordSample(netW, generationW, nowMs)
  );
  // eslint-disable-next-line functional/immutable-data
  ctx.getCurtailedSurplusKw = () => curtailment.getCurtailedSurplusKw(Date.now());
  // eslint-disable-next-line functional/immutable-data
  ctx.canContributeCurtailmentSurplus = () => curtailment.canContributeSurplus();
  deps.backgroundTasks.startDeferredObjectiveLifecycleClock(
    createDeferredObjectiveLifecycleEmitter(ctx),
  );
  deps.runNativeWiringDetectionBestEffort();
  deps.timers.registerInterval('nativeWiringRequery', setInterval(
    deps.runNativeWiringDetectionBestEffort,
    NATIVE_WIRING_REQUERY_INTERVAL_MS,
  ));
};
