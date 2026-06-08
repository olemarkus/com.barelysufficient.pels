import type { CombinedPricesV2 } from './priceTypes';

/**
 * Domain-owned read boundary for the persisted combined-prices store.
 *
 * Consumers (daily budget, flow tags, plan service, deferred recorders) depend
 * on this type, never on `homey.settings` — the interface deliberately does not
 * expose the Homey SDK, so a consumer cannot read or migrate the persisted
 * payload directly. The implementing adapter (`setup/priceCombinedPricesAdapter`)
 * owns the settings read, the V1→V2 migration, and the malformed-payload
 * recovery; this package only declares the typed shape callers receive.
 *
 * `readStore` returns the migrated V2 store (or `null` before the first refresh
 * / for an unrecoverable payload). The pure derivations of that store live in
 * `priceStore.ts` and take a `CombinedPricesReader`, so no consumer needs the
 * SDK to obtain the flattened-hour or legacy `CombinedPriceData` views.
 */
export type CombinedPricesReader = {
  readStore(now: Date, timeZone: string): CombinedPricesV2 | null;
};
