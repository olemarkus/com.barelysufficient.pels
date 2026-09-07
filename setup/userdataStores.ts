import { createTrackerStore, type TrackerStore } from '../lib/power/trackerStore';
import { openAppUserdataDatabase, type UserdataDatabase } from '../lib/store/userdataDatabase';
import { createWeatherHistoryStore, type WeatherHistoryStore } from '../lib/weather/weatherHistoryStore';

/**
 * The userdata database and every repository on it, opened together at the
 * app's first boot step and closed together last at teardown. A repository
 * is a `lib/` component that takes the open database; this is the one place
 * that lists them, so a new data family is wired by adding a line here.
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
