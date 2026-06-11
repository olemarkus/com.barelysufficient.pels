import type Homey from 'homey';
import type { WeatherHistoryStore } from '../lib/weather/weatherHistoryStore';
import type { WeatherHistoryState } from '../packages/contracts/src/weatherAdvisorTypes';
import { WEATHER_HISTORY_STATE } from '../lib/utils/settingsKeys';

/**
 * Builds the {@link WeatherHistoryStore}: the sole owner of the
 * `homey.settings` read/write for the persisted weather-history blob. The
 * collector receives this typed store and never touches `homey.settings`
 * itself.
 */
export const createWeatherHistoryStore = (
  homey: Homey.App['homey'],
): WeatherHistoryStore => ({
  read(): unknown {
    return homey.settings.get(WEATHER_HISTORY_STATE);
  },
  write(state: WeatherHistoryState): void {
    homey.settings.set(WEATHER_HISTORY_STATE, state);
  },
});
