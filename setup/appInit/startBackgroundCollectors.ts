// Starts the hidden background collectors that ride on the transport/REST client
// (initialized during initDeviceManager), kept out of app.ts to ease its size: the
// weather-history collector (consumption energy signature), the learned PV-
// generation forecast, and Homey Energy's own solar forecast. All are pure
// data — none touches shed/capacity decisions.

import { createPvForecastSourceSelector } from '../../lib/solar/pvForecastSourceSelector';
import type { SelectedPvForecast } from '../../lib/solar/pvForecastSource';
import { getLogger } from '../../lib/logging/logger';
import { createWeatherCollector } from './createWeatherCollector';
import { createPvForecastController, type PvForecastController } from './createPvForecastService';
import { createHomeySolarForecastController } from './createHomeySolarForecastController';
import type { HomeySolarForecastController } from '../../lib/solar/homeySolarForecastController';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import type { AppContext } from '../../lib/app/appContext';

export type BackgroundCollectors = {
  weatherCollector: WeatherCollector;
  pvForecast: PvForecastController;
  homeySolarForecast: HomeySolarForecastController;
  getSelectedPvForecast: () => SelectedPvForecast;
};

export function startBackgroundCollectors(
  ctx: AppContext,
  startWeatherCollector: (collector: WeatherCollector) => void,
  getDailyKwh: Parameters<typeof createWeatherCollector>[1],
): BackgroundCollectors {
  const weatherCollector = createWeatherCollector(ctx, getDailyKwh);
  startWeatherCollector(weatherCollector);
  const pvForecast = createPvForecastController(ctx);
  const homeySolarForecast = createHomeySolarForecastController(ctx, () => pvForecast.isActive());
  // Both forecast consumers share this selector and its source-transition latch.
  // The controllers exist before construction, so the selector needs no startup fallback.
  const getSelectedPvForecast = createPvForecastSourceSelector({
    learned: pvForecast,
    homey: homeySolarForecast,
    getNowMs: () => Date.now(),
    logger: getLogger('solar'),
  });
  return { weatherCollector, pvForecast, homeySolarForecast, getSelectedPvForecast };
}
