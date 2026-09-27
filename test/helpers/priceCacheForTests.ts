import { createPriceCacheStore, type PriceCacheStore } from '../../lib/price/priceCacheStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

/**
 * An empty price cache on its own in-memory database, for a spec that builds a
 * price service by hand. The grid tariff lives here, not in settings, so a
 * spec seeds it with `write('grid_tariff', …)`.
 */
export const createInMemoryPriceCache = (): PriceCacheStore => (
  createPriceCacheStore(openUserdataDatabase(IN_MEMORY_DATABASE))
);
