import type { AppContext } from '../lib/app/appContext';
import { startPriceLowestTriggerChecker } from '../lib/price/priceLowestTrigger';
import { requirePriceCoordinator } from './appInit/contextGuards';

/** Connect the price trigger clock to the live coordinator and Homey Flow cards. */
export function wirePriceLowestTrigger(ctx: AppContext): () => void {
  return startPriceLowestTriggerChecker({
    getNow: () => ctx.getNow(),
    getTimeZone: () => ctx.getTimeZone(),
    getCombinedHourlyPrices: () => requirePriceCoordinator(ctx).getCombinedHourlyPrices(),
    getTriggerCard: (id) => ctx.homey.flow.getTriggerCard(id),
    error: (message, error) => ctx.error(message, error),
  });
}
