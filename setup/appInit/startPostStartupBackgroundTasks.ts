import type { AppContext } from '../../lib/app/appContext';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import type { BackgroundTasksController } from '../backgroundTasksController';
import type { PvForecastController } from './createPvForecastService';
import { createDeferredObjectiveLifecycleEmitter } from './deferredObjectiveLifecycle';
import { startBackgroundCollectors } from './startBackgroundCollectors';
import { wireBudgetPrice } from './wireBudgetPrice';
import { wireCurtailmentSurplus } from './wireCurtailmentSurplus';

const NATIVE_WIRING_REQUERY_INTERVAL_MS = 30 * 60 * 1000;

export type PostStartupBackgroundDeps = {
  ctx: AppContext;
  backgroundTasks: BackgroundTasksController;
  timers: TimerRegistry;
  startPowerTrackerPruning: () => void;
  setWeatherCollector: (collector: WeatherCollector | undefined) => void;
  getPvForecast: () => PvForecastController | undefined;
  setPvForecast: (pvForecast: PvForecastController | undefined) => void;
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
  wireBudgetPrice(ctx, (ms) => deps.getPvForecast()?.service.forecast([ms])?.[0]?.generationKwh);
  deps.getPvForecast()?.setOnRefreshed(() => {
    try {
      ctx.priceCoordinator?.updateCombinedPrices();
    } catch (error) {
      ctx.getStructuredLogger('solar')?.warn({
        event: 'pv_forecast_price_recompute_failed',
        err: normalizeError(error),
      });
    }
  });
  const curtailment = wireCurtailmentSurplus(ctx, deps.getPvForecast);
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
