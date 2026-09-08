import type { AppContext } from '../../lib/app/appContext';
import {
  createWeatherHistoryStore,
  importLegacyWeatherHistory,
  type WeatherHistoryStore,
} from '../../lib/weather/weatherHistoryStore';

/**
 * The weather insight's history repository on the app's userdata database,
 * with the one-shot import of the legacy settings blob run before anything
 * reads it. Built where the collector is wired, not in a file that opens the
 * database and lists every domain's repository: a domain's wiring owns its
 * repository (`setup/appInit/planHistoryStore.ts` is the pattern), and a
 * wiring file naming two peers is the cross-peer composition this layer's
 * rules forbid.
 *
 * The collector is the store's only reader, so it is also its only holder —
 * the database it is built on is the one the app opens at its first boot step
 * and closes last at teardown.
 */
export const createWeatherHistoryStoreForApp = (
  ctx: Pick<AppContext, 'homey' | 'getUserdataDatabase'>,
): WeatherHistoryStore => {
  const store = createWeatherHistoryStore(ctx.getUserdataDatabase());
  importLegacyWeatherHistory(ctx.homey.settings, store);
  return store;
};
