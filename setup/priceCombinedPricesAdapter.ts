import type Homey from 'homey';
import type { CombinedPricesReader } from '../lib/price/combinedPricesReader';
import type { PriceCoordinator } from '../lib/price/priceCoordinator';
import { COMBINED_PRICES } from '../lib/utils/settingsKeys';
import {
  type CombinedPricesV2,
  isCombinedPricesV1,
  isCombinedPricesV2,
} from '../lib/price/priceTypes';
import { migrateLegacyCombinedPrices, pruneCombinedPricesV2 } from '../lib/price/priceServiceCombined';

type CombinedPricesReaderDeps = {
  homey: Homey.App['homey'];
  /**
   * Triggered when COMBINED_PRICES is missing or has an unrecognised shape so
   * the coordinator can rebuild from raw scheme data (see
   * PriceCoordinator.updateCombinedPrices). Not invoked for the V1 → V2
   * migration path: V1 already carries every entry, so we migrate in place
   * synchronously. Re-entrant calls within the same read are guarded by the
   * per-instance `refetchInFlight` flag; this relies on a single shared reader
   * (constructed once in `createAppContext`), so the guard covers all reads.
   */
  requestRefetch: () => void;
};

/**
 * Builds the {@link CombinedPricesReader} that backs every combined-prices
 * consumer. This adapter is the sole owner of the `homey.settings` read for
 * COMBINED_PRICES plus the V1→V2 migration and malformed-payload recovery —
 * domain consumers receive only the typed `CombinedPricesV2 | null` result and
 * cannot reach the SDK or the raw payload themselves.
 */
export const createCombinedPricesReader = (deps: CombinedPricesReaderDeps): CombinedPricesReader => {
  // Re-entrancy guard so a recovery `requestRefetch` call cannot recurse if the
  // refetcher itself synchronously triggers another read.
  let refetchInFlight = false;
  const guardedRequestRefetch = (): void => {
    if (refetchInFlight) return;
    refetchInFlight = true;
    try { deps.requestRefetch(); } finally { refetchInFlight = false; }
  };

  const readStore = (now: Date, timeZone: string): CombinedPricesV2 | null => {
    const raw = deps.homey.settings.get(COMBINED_PRICES) as unknown;
    if (isCombinedPricesV2(raw)) return pruneCombinedPricesV2(raw, now, timeZone);
    // Legacy V1 payload: migrate synchronously so callers see prices immediately
    // instead of a UNKNOWN-price-level gap until the next refetch lands. Persist
    // the V2 form so direct consumers also see V2 from now on, and so we don't
    // run the migration on every read.
    if (isCombinedPricesV1(raw)) {
      const migrated = migrateLegacyCombinedPrices(raw, now, timeZone);
      deps.homey.settings.set(COMBINED_PRICES, migrated);
      // If the V1 payload had no entries inside the 3-day window (empty
      // legacy.prices, or all entries outside the window), the migrated store is
      // empty and price_level would otherwise stay UNKNOWN until an external
      // refresh arrives. Trigger a refetch so the coordinator rebuilds.
      if (Object.keys(migrated.days).length === 0) {
        guardedRequestRefetch();
      }
      return migrated;
    }
    // Anything else (truly malformed, foreign shape): drop and ask the
    // coordinator to rebuild. Plain null/undefined is the normal pre-refresh
    // state and not actionable here — the periodic refresher will populate
    // combined_prices on its own.
    if (raw !== null && raw !== undefined) {
      deps.homey.settings.set(COMBINED_PRICES, null);
      guardedRequestRefetch();
    }
    return null;
  };

  return { readStore };
};

/**
 * App-wiring convenience: builds the shared reader with the standard
 * coordinator-driven refetch. Kept here (rather than inline in `createAppContext`)
 * so the wiring — and the lazy coordinator lookup — live with the adapter.
 */
export const createCombinedPricesReaderForApp = (
  homey: Homey.App['homey'],
  getPriceCoordinator: () => Pick<PriceCoordinator, 'updateCombinedPrices'> | undefined,
): CombinedPricesReader => createCombinedPricesReader({
  homey,
  requestRefetch: () => getPriceCoordinator()?.updateCombinedPrices(),
});
