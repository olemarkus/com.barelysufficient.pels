import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

/**
 * Port over the persisted weather-history blob. The setup-layer adapter
 * (`setup/weatherHistoryStateAdapter.ts`) is the sole owner of the
 * `homey.settings` read/write; the collector receives this typed store and
 * never touches `homey.settings` itself.
 */
export type WeatherHistoryStore = {
  read(): unknown;
  write(state: WeatherHistoryState): void;
};
