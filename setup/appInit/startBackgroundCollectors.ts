// Starts the hidden background collectors that ride on the transport/REST client
// (initialized during initDeviceManager), kept out of app.ts to ease its size: the
// weather-history collector (consumption energy signature), the learned PV-
// generation forecast, and Homey Energy's own solar forecast. All are pure
// data — none touches shed/capacity decisions.

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
};

export function startBackgroundCollectors(
  ctx: AppContext,
  startWeatherCollector: (collector: WeatherCollector) => void,
): BackgroundCollectors {
  const weatherCollector = createWeatherCollector(ctx);
  startWeatherCollector(weatherCollector);
  const pvForecast = createPvForecastController(ctx);
  const homeySolarForecast = createHomeySolarForecastController(ctx, () => pvForecast.isActive());
  return { weatherCollector, pvForecast, homeySolarForecast };
}
