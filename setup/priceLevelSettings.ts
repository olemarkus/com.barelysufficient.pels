import type Homey from 'homey';
import { PriceLevel } from '../lib/price/priceLevels';

const isPriceLevel = (value: unknown): value is PriceLevel => (
  value === PriceLevel.CHEAP
  || value === PriceLevel.NORMAL
  || value === PriceLevel.EXPENSIVE
  || value === PriceLevel.UNKNOWN
);

/** Resolves the persisted Flow status boundary to a trusted price level. */
export const readCurrentPriceLevel = (
  settings: Homey.App['homey']['settings'],
  getLastGoodPriceLevel: () => PriceLevel | undefined,
): PriceLevel => {
  let storedStatus: unknown;
  try {
    storedStatus = settings.get('pels_status');
  } catch {
    return getLastGoodPriceLevel() ?? PriceLevel.UNKNOWN;
  }

  if (storedStatus && typeof storedStatus === 'object') {
    const { priceLevel } = storedStatus as { priceLevel?: unknown };
    if (isPriceLevel(priceLevel)) return priceLevel;
  }
  return getLastGoodPriceLevel() ?? PriceLevel.UNKNOWN;
};
