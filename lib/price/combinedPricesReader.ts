import type { SettingsPort } from '../ports/homeyRuntime';
import { COMBINED_PRICES } from '../utils/settingsKeys';
import {
  type CombinedPricesV2,
  isCombinedPricesV1,
  isCombinedPricesV2,
} from './priceTypes';
import { migrateLegacyCombinedPrices, pruneCombinedPricesV2 } from './priceServiceCombined';

/**
 * Domain-owned read boundary for the persisted combined-prices store.
 *
 * Consumers (daily budget, flow tags, plan service, deferred recorders) depend
 * on this type, never on `homey.settings` — the interface deliberately does not
 * expose the Homey SDK, so a consumer cannot read or migrate the persisted
 * payload directly. {@link createCombinedPricesReader} below owns the settings
 * read, the V1→V2 migration, and the malformed-payload recovery.
 *
 * `readStore` returns the migrated V2 store (or `null` before the first refresh
 * / for an unrecoverable payload). The pure derivations of that store live in
 * `priceStore.ts` and take a `CombinedPricesReader`, so no consumer needs the
 * SDK to obtain the flattened-hour or legacy `CombinedPriceData` views.
 */
export type CombinedPricesReader = {
  readStore(now: Date, timeZone: string): CombinedPricesV2 | null;
};

/**
 * The settings-backed {@link CombinedPricesReader}.
 *
 * `requestRefetch` is triggered when COMBINED_PRICES is missing or has an
 * unrecognised shape, so the coordinator can rebuild from raw scheme data (see
 * `PriceCoordinator.updateCombinedPrices`). It is NOT invoked for the V1 → V2
 * migration path: V1 already carries every entry, so we migrate in place
 * synchronously. Re-entrant calls within the same read are guarded by the
 * per-instance `refetchInFlight` flag; this relies on a single shared reader
 * (constructed once as the app's `combinedPricesReader` field), so the guard
 * covers all reads.
 */
export const createCombinedPricesReader = (
  settings: SettingsPort,
  requestRefetch: () => void,
): CombinedPricesReader => {
  // Re-entrancy guard so a recovery `requestRefetch` call cannot recurse if the
  // refetcher itself synchronously triggers another read.
  let refetchInFlight = false;
  const guardedRequestRefetch = (): void => {
    if (refetchInFlight) return;
    refetchInFlight = true;
    try { requestRefetch(); } finally { refetchInFlight = false; }
  };

  const readStore = (now: Date, timeZone: string): CombinedPricesV2 | null => {
    const raw = settings.get(COMBINED_PRICES);
    if (isCombinedPricesV2(raw)) return pruneCombinedPricesV2(raw, now, timeZone);
    // Legacy V1 payload: migrate synchronously so callers see prices immediately
    // instead of a UNKNOWN-price-level gap until the next refetch lands. Persist
    // the V2 form so direct consumers also see V2 from now on, and so we don't
    // run the migration on every read.
    if (isCombinedPricesV1(raw)) {
      const migrated = migrateLegacyCombinedPrices(raw, now, timeZone);
      settings.set(COMBINED_PRICES, migrated);
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
      settings.set(COMBINED_PRICES, null);
      guardedRequestRefetch();
    }
    return null;
  };

  return { readStore };
};
