import type { CombinedPricesV2 } from './priceTypes';

/**
 * Producer-side typed boundary for the persisted COMBINED_PRICES blob, used by
 * PriceService when it rebuilds the cache. `readRaw` returns the un-migrated
 * persisted value verbatim — PriceService fingerprints it and runs a transient-
 * read data-safety guard against it, so it must NOT be migrated/pruned (that is
 * the separate `CombinedPricesReader`'s job for consumers). `write` persists the
 * freshly-built V2 payload.
 */
export type CombinedPricesStore = {
  readRaw(): unknown;
  write(payload: CombinedPricesV2): void;
};
