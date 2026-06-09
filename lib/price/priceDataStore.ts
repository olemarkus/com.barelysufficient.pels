import type { SpotPriceEntry } from './spotPriceFetch';
import type { FlowPricePayload } from './flowPriceUtils';
import type { CombinedPricesV2 } from './priceTypes';

/**
 * Producer-side typed boundary for PriceService's cached price-data settings
 * (spot prices, grid tariff, and the flow/homey flow-price slot payloads). Writes
 * are typed so a wrong shape can't be persisted; reads return the raw persisted
 * value (callers validate/cast as before). The flow methods are keyed because the
 * same purge path serves both the FLOW_PRICES_* and HOMEY_PRICES_* slot pairs.
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
  readCombinedRaw(): unknown;
  writeCombined(payload: CombinedPricesV2): void;
};
