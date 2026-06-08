import { requirePlanService } from './contextGuards';
import { PriceCoordinator } from '../../lib/price/priceCoordinator';
import { PriceFlowTagPublisher } from '../../lib/price/priceFlowTags';
import { resolveHomeyEnergyApiFromSdk } from '../../lib/utils/homeyEnergy';
import type { AppContext } from '../../lib/app/appContext';

export function createPriceCoordinator(ctx: AppContext): PriceCoordinator {
  return new PriceCoordinator({
    homey: ctx.homey,
    getTimeZone: () => ctx.getTimeZone(),
    getHomeyEnergyApi: () => resolveHomeyEnergyApiFromSdk(ctx.homey),
    getCurrentPriceLevel: () => ctx.getCurrentPriceLevel(),
    rebuildPlanFromCache: (reason) => requirePlanService(ctx).rebuildPlanFromCache(reason).then(() => undefined),
    log: (...args: unknown[]) => ctx.log(...args),
    debugStructured: ctx.getStructuredDebugEmitter('price', 'price'),
    error: (...args: unknown[]) => ctx.error(...args),
    structuredLog: ctx.getStructuredLogger('price'),
    onCombinedPricesUpdated: (reason) => {
      const publisher = ctx.priceFlowTagPublisher;
      if (!publisher) return;
      publisher.publish(reason).catch((error) => ctx.error('PriceFlowTagPublisher.publish failed', error));
    },
  });
}

export function createPriceFlowTagPublisher(ctx: AppContext): PriceFlowTagPublisher {
  return new PriceFlowTagPublisher({
    homey: ctx.homey,
    getTimeZone: () => ctx.getTimeZone(),
    combinedPricesReader: ctx.combinedPricesReader,
    log: (...args: unknown[]) => ctx.log(...args),
    debugStructured: ctx.getStructuredDebugEmitter('price', 'price'),
  });
}
