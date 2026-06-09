import type Homey from 'homey';
import type { PriceDataStore } from '../lib/price/priceDataStore';
import {
  COMBINED_PRICES,
  ELECTRICITY_PRICES,
  ELECTRICITY_PRICES_AREA,
  NETTLEIE_DATA,
} from '../lib/utils/settingsKeys';

/**
 * Builds the {@link PriceDataStore}: the producer-side read/write boundary
 * PriceService uses for its cached price-data settings (spot prices, grid
 * tariff, and the flow/homey flow-price slot payloads). Writes are typed so a
 * wrong shape can't be persisted; reads return the raw persisted value so
 * callers keep their existing validation/casts.
 */
export const createPriceDataStore = (homey: Homey.App['homey']): PriceDataStore => ({
  readSpotPrices: () => homey.settings.get(ELECTRICITY_PRICES),
  writeSpotPrices: (prices) => homey.settings.set(ELECTRICITY_PRICES, prices),
  readSpotPriceArea: () => homey.settings.get(ELECTRICITY_PRICES_AREA),
  writeSpotPriceArea: (area) => homey.settings.set(ELECTRICITY_PRICES_AREA, area),
  readNettleie: () => homey.settings.get(NETTLEIE_DATA),
  writeNettleie: (data) => homey.settings.set(NETTLEIE_DATA, data),
  readFlowPayload: (key) => homey.settings.get(key),
  writeFlowPayload: (key, payload) => homey.settings.set(key, payload),
  readCombinedRaw: () => homey.settings.get(COMBINED_PRICES),
  writeCombined: (payload) => homey.settings.set(COMBINED_PRICES, payload),
});
