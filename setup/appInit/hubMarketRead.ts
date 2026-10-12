import { readHubMarket } from '../../lib/home/hubMarket';
import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUiApi';
import { createHomeyWebApiGet } from '../homeyWebApi';

/**
 * Where the hub is: the home-owned read of Homey's location-derived country,
 * bound to Homey's Web API. The price coordinator takes it as a port, so the
 * price module learns the country without depending on the home module.
 */
export const createHubMarketRead = (): (() => Promise<SettingsUiHubMarketRead>) => (
  () => readHubMarket(createHomeyWebApiGet())
);
