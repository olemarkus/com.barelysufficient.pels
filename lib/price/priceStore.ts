import type Homey from 'homey';
import { COMBINED_PRICES } from '../utils/settingsKeys';
import {
  type CombinedPriceEntry,
  type CombinedPricesV2,
  isCombinedPricesV2,
} from './priceTypes';
import { pruneCombinedPricesV2 } from './priceServiceCombined';

export type PriceStoreDeps = {
  homey: Homey.App['homey'];
  /**
   * Triggered when COMBINED_PRICES is missing or not in V2 form. Implementation
   * should rebuild combined_prices from raw scheme data (see
   * PriceCoordinator.updateCombinedPrices). Re-entrant calls within the same
   * read are guarded by `refetchInFlight`.
   */
  requestRefetch: () => void;
};

// Module-scoped re-entrancy guard so a recovery `requestRefetch` call cannot
// recurse if the refetcher itself synchronously triggers another read.
let refetchInFlight = false;

export const __resetRefetchGuardForTest = (): void => {
  refetchInFlight = false;
};

const guardedRequestRefetch = (deps: PriceStoreDeps): void => {
  if (refetchInFlight) return;
  refetchInFlight = true;
  try { deps.requestRefetch(); } finally { refetchInFlight = false; }
};

export const readPriceStore = (deps: PriceStoreDeps, now: Date, timeZone: string): CombinedPricesV2 | null => {
  const raw = deps.homey.settings.get(COMBINED_PRICES) as unknown;
  if (isCombinedPricesV2(raw)) return pruneCombinedPricesV2(raw, now, timeZone);
  // Legacy/malformed payload: drop it and ask the coordinator to rebuild.
  // Plain null/undefined is the normal pre-refresh state and not actionable
  // here — the periodic refresher will populate combined_prices on its own.
  if (raw !== null && raw !== undefined) {
    deps.homey.settings.set(COMBINED_PRICES, null);
    guardedRequestRefetch(deps);
  }
  return null;
};

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
 * (`{ prices, lastFetched, priceUnit }`) read out of Homey settings — handles
 * the settings read, the V2 guard, and the flatten in one call.
 */
export const readCombinedPriceData = (
  deps: PriceStoreDeps,
  now: Date,
  timeZone: string,
): { prices?: CombinedPriceEntry[]; lastFetched?: string; priceUnit?: string } | null => (
  combinedPriceDataFromStore(readPriceStore(deps, now, timeZone))
);
