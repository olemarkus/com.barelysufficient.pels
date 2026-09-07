import { createTrackerStore, type TrackerStore } from '../lib/power/trackerStore';
import { openAppUserdataDatabase, type UserdataDatabase } from '../lib/store/userdataDatabase';
import { createWeatherHistoryStore, type WeatherHistoryStore } from '../lib/weather/weatherHistoryStore';

/**
 * The userdata database, opened at the app's first boot step and closed last
 * at teardown, with the two repositories that predate the rule that a domain's
 * wiring builds its own repository from `AppContext.getUserdataDatabase()`
 * (`setup/appInit/deferredRecorders.ts` is the pattern): a repository is a
 * `lib/` component that takes the open database, and listing every domain
 * here would make this file the cross-peer composition the wiring rules
 * forbid.
 */
export type AppUserdataStores = {
  database: UserdataDatabase;
  trackerStore: TrackerStore;
  weatherHistoryStore: WeatherHistoryStore;
};

/**
 * Open the app's userdata database — the production file unless a caller
 * hands in another (the test harness opens one per spec file) — and the
 * repositories on it.
 */
export const openUserdataStores = (database: UserdataDatabase = openAppUserdataDatabase()): AppUserdataStores => ({
  database,
  trackerStore: createTrackerStore(database),
  weatherHistoryStore: createWeatherHistoryStore(database),
});
