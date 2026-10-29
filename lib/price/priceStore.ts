import {
  type CombinedPriceEntry,
  type CombinedPricesV2,
} from './priceTypes';
import type { CombinedPricesReader } from './combinedPricesReader';

export const flattenAllHours = (store: CombinedPricesV2 | null): CombinedPriceEntry[] => {
  if (!store) return [];
  const flat = Object.values(store.days).flatMap((day) => day.hours);
  return [...flat].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
};

export const combinedPriceDataFromStore = (
  store: CombinedPricesV2 | null,
): { prices?: CombinedPriceEntry[]; lastFetched?: string; priceUnit?: string } | null => {
  if (!store) return null;
  return {
    prices: flattenAllHours(store),
    lastFetched: store.lastFetched,
    priceUnit: store.priceUnit,
  };
};

/**
 * Convenience for callers that just want the legacy `CombinedPriceData` shape
 * (`{ prices, lastFetched, priceUnit }`) derived from the store — runs the
 * reader's migrating read, then the pure flatten, in one call. No SDK access
 * beyond the injected `reader`.
 */
export const readCombinedPriceData = (
  reader: CombinedPricesReader,
  now: Date,
  timeZone: string,
): { prices?: CombinedPriceEntry[]; lastFetched?: string; priceUnit?: string } | null => (
  combinedPriceDataFromStore(reader.readStore(now, timeZone))
);
