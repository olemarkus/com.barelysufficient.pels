// Starts the hidden background collectors that ride on the transport/REST client
// (initialized during initDeviceManager), kept out of app.ts to ease its size: the
// weather-history collector (consumption energy signature) and the learned PV-
// generation forecast. Both are pure data — neither touches shed/capacity decisions.

import { createWeatherCollector } from './createWeatherCollector';
import { createPvForecastController, type PvForecastController } from './createPvForecastService';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import type { AppContext } from '../../lib/app/appContext';

export type BackgroundCollectors = {
  weatherCollector: WeatherCollector;
  pvForecast: PvForecastController;
};

export function startBackgroundCollectors(
  ctx: AppContext,
  startWeatherCollector: (collector: WeatherCollector) => void,
): BackgroundCollectors {
  const weatherCollector = createWeatherCollector(ctx);
  startWeatherCollector(weatherCollector);
  const pvForecast = createPvForecastController(ctx);
  return { weatherCollector, pvForecast };
}
