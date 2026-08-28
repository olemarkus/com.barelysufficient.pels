import {
  calculateAveragePrice,
  calculateThresholds,
  getPriceLevelFlags,
  isPriceAtLevel,
} from './priceMath';
import { resolvePlanningPrice } from './budgetPrice';
import { PriceLevel } from './priceLevels';

type PriceEntry = {
  startsAt: string;
  totalPrice: number;
  /** Planning price (`budgetPrice ?? totalPrice`); absent for non-prosumers. */
  budgetPrice?: number;
};

export const getCurrentHourPrice = (prices: PriceEntry[], nowMs: number = Date.now()): PriceEntry | null => {
  if (prices.length === 0) return null;
  return prices.find((price) => {
    const hourStart = new Date(price.startsAt).getTime();
    return nowMs >= hourStart && nowMs < hourStart + 60 * 60 * 1000;
  }) || null;
};

/**
 * Cheap/expensive classification of the current hour. Deliberately computed
 * over the PLANNING price (`budgetPrice ?? totalPrice`) — both the average and
 * the current-hour value — so the price level agrees with what the planner
 * schedules against (thermostat price-opt deltas, the `price_level` flow
 * trigger, the pels_insights level capability). Identical to a total-based
 * classification when no export price is configured. Money strings never come
 * from here.
 */
export const isCurrentHourAtLevel = (params: {
  prices: PriceEntry[];
  level: 'cheap' | 'expensive';
  thresholdPercent: number;
  minDiff: number;
  nowMs?: number;
}): boolean => {
  const {
    prices,
    level,
    thresholdPercent,
    minDiff,
    nowMs,
  } = params;
  const currentPrice = getCurrentHourPrice(prices, nowMs);
  if (!currentPrice) return false;
  const avgPrice = calculateAveragePrice(
    prices,
    (entry) => resolvePlanningPrice(entry.budgetPrice, entry.totalPrice),
  );
  const thresholds = calculateThresholds(avgPrice, thresholdPercent);
  return isPriceAtLevel({
    price: resolvePlanningPrice(currentPrice.budgetPrice, currentPrice.totalPrice),
    avgPrice,
    thresholds,
    minDiff,
    level,
  });
};

/**
 * The RESOLVED price level of the current hour, from ONE pass over the series.
 *
 * `getPriceLevelFlags` already computes `isCheap` and `isExpensive` together, so
 * asking `isCurrentHourAtLevel` twice re-derives the current hour, the average,
 * and the thresholds for an answer it had in hand. That is cheap here — but the
 * caller has to hand in `prices`, and on the PELS runtime the only source is
 * `PriceService.getCombinedHourlyPrices()`, which is uncached and rebuilds the
 * whole series from settings (~25 ms on a Homey Pro). Two predicate calls meant
 * two rebuilds. See `PriceService.getCurrentHourPriceLevel`.
 *
 * One `PriceLevel`, not the two raw flags. The flags are not mutually exclusive
 * — `price <= low` and `price >= high`, so at `thresholdPercent` 0 a price
 * exactly on the average is both — and every consumer resolved that the same
 * way, cheap-first. Resolving it here means no consumer re-derives a precedence
 * or a "do we even have prices?" shape check: no current-hour entry is
 * `UNKNOWN`, and that is the producer's answer rather than something a caller
 * infers from a price blob it had to read for the purpose.
 */
export const resolveCurrentHourPriceLevel = (params: {
  prices: PriceEntry[];
  thresholdPercent: number;
  minDiff: number;
  nowMs?: number;
}): PriceLevel => {
  const { prices, thresholdPercent, minDiff, nowMs } = params;
  const currentPrice = getCurrentHourPrice(prices, nowMs);
  if (!currentPrice) return PriceLevel.UNKNOWN;
  const avgPrice = calculateAveragePrice(
    prices,
    (entry) => resolvePlanningPrice(entry.budgetPrice, entry.totalPrice),
  );
  const flags = getPriceLevelFlags({
    price: resolvePlanningPrice(currentPrice.budgetPrice, currentPrice.totalPrice),
    avgPrice,
    thresholds: calculateThresholds(avgPrice, thresholdPercent),
    minDiff,
  });
  if (flags.isCheap) return PriceLevel.CHEAP;
  if (flags.isExpensive) return PriceLevel.EXPENSIVE;
  return PriceLevel.NORMAL;
};
