import {
  SETTINGS_UI_HUB_MARKET_PATH,
  type SettingsUiHubMarketRead,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { publishSetupMarket } from './setupPathFacts.ts';

/**
 * Asks the runtime where the hub is. The answer crosses the Homey API bridge
 * into the WebView, so it is validated once here and trusted inward.
 *
 * Advisory, like the rest of the recommendation data: it is read after first
 * paint, and every failure leaves the market `unavailable`, which is the
 * market-neutral copy every surface already draws.
 */
const COUNTRY_CODE = /^[A-Z]{2}$/;

export const parseHubMarketRead = (value: unknown): SettingsUiHubMarketRead => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { state: 'unavailable' };
  const read = value as { state?: unknown; country?: unknown };
  return read.state === 'resolved' && typeof read.country === 'string' && COUNTRY_CODE.test(read.country)
    ? { state: 'resolved', country: read.country }
    : { state: 'unavailable' };
};

export const loadHubMarket = async (): Promise<void> => {
  try {
    publishSetupMarket(parseHubMarketRead(await callApi<unknown>('GET', SETTINGS_UI_HUB_MARKET_PATH)));
  } catch (error) {
    await logSettingsError('Failed to read the hub market', error, 'setup recommendations');
  }
};
