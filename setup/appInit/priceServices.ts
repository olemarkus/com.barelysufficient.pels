import { PriceCoordinator } from '../../lib/price/priceCoordinator';
import { PriceFlowTagPublisher } from '../../lib/price/priceFlowTags';
import { createPriceOptimizationSettingsStore } from '../../lib/price/priceOptimizationSettingsStore';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { createHomeyWebApiGet } from '../homeyWebApi';
import type { AppContext } from '../../lib/app/appContext';

export function createPriceCoordinator(ctx: AppContext): PriceCoordinator {
  const coordinator = new PriceCoordinator({
    homey: ctx.homey,
    priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(ctx.homey.settings),
    priceDataStore: createPriceDataStore(ctx.homey.settings),
    getTimeZone: () => ctx.getTimeZone(),
    getPowerTracker: () => ctx.powerTracker,
    homeyWebApiGet: createHomeyWebApiGet(),
    getCurrentPriceLevel: () => ctx.getCurrentHourPriceLevel(),
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
  // The settings UI's account of why a Homey-priced home may show no prices,
  // answered by the component that builds those prices. Same seam shape as
  // `getPvForecastSourceUiStatus`: the context is how a wired component is
  // reached, and the assignment is the wiring.
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.getHomeyPriceFormulaUiStatus = () => coordinator.getHomeyPriceFormulaUiStatus();
  // Same seam, same reason: what the Power by the Hour app answered is known
  // only to the component that asked it.
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.getPowerhourSourceUiStatus = () => coordinator.getPowerhourSourceUiStatus();
  return coordinator;
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
