import type { SettingsPort } from '../ports/homeyRuntime';
import {
  COMBINED_PRICES,
  ELECTRICITY_PRICES,
  ELECTRICITY_PRICES_AREA,
  HOMEY_PRICES_CURRENCY,
  NETTLEIE_DATA,
} from '../utils/settingsKeys';
import type { SpotPriceEntry } from './spotPriceFetch';
import type { FlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';
import type { CombinedPricesV2 } from './priceTypes';

/**
 * Producer-side typed boundary for PriceService's cached price-data settings
 * (spot prices, grid tariff, the flow/homey flow-price slot payloads, and the
 * homey-prices currency). Writes are typed so a wrong shape can't be persisted;
 * reads return the raw persisted value (callers validate/cast as before). The
 * flow methods are keyed because the same purge path serves both the
 * FLOW_PRICES_* and HOMEY_PRICES_* slot pairs.
 *
 * It also owns the COMBINED_PRICES producer read-back/write that PriceService
 * uses when rebuilding the cache. `readCombinedRaw` returns the persisted
 * COMBINED_PRICES value verbatim — un-migrated and un-pruned — because
 * PriceService fingerprints it and runs the transient-read data-safety guard
 * against the raw bytes (migration/pruning is the separate combined-prices
 * reader's job for consumers). `writeCombined` persists the freshly-built V2
 * payload.
 */
export type PriceDataStore = {
  readSpotPrices(): unknown;
  writeSpotPrices(prices: SpotPriceEntry[]): void;
  readSpotPriceArea(): unknown;
  writeSpotPriceArea(area: string): void;
  readNettleie(): unknown;
  writeNettleie(data: Array<Record<string, unknown>>): void;
  readFlowPayload(key: string): unknown;
  writeFlowPayload(key: string, payload: FlowPricePayload | null): void;
  writeHomeyPricesCurrency(unit: string): void;
  readCombinedRaw(): unknown;
  writeCombined(payload: CombinedPricesV2): void;
};

/**
 * The settings-backed {@link PriceDataStore}. It lives beside the port it
 * implements because the reads and the keys they use are the price module's
 * own: `setup/` hands over a {@link SettingsPort} and knows nothing about which
 * keys back which field.
 */
export const createPriceDataStore = (settings: SettingsPort): PriceDataStore => ({
  readSpotPrices: () => settings.get(ELECTRICITY_PRICES),
  writeSpotPrices: (prices) => settings.set(ELECTRICITY_PRICES, prices),
  readSpotPriceArea: () => settings.get(ELECTRICITY_PRICES_AREA),
  writeSpotPriceArea: (area) => settings.set(ELECTRICITY_PRICES_AREA, area),
  readNettleie: () => settings.get(NETTLEIE_DATA),
  writeNettleie: (data) => settings.set(NETTLEIE_DATA, data),
  readFlowPayload: (key) => settings.get(key),
  writeFlowPayload: (key, payload) => settings.set(key, payload),
  writeHomeyPricesCurrency: (unit) => settings.set(HOMEY_PRICES_CURRENCY, unit),
  readCombinedRaw: () => settings.get(COMBINED_PRICES),
  writeCombined: (payload) => settings.set(COMBINED_PRICES, payload),
});
