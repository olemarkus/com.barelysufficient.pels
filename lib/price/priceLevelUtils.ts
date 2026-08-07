import {
  calculateAveragePrice,
  calculateThresholds,
  getPriceLevelFlags,
  isPriceAtLevel,
} from './priceMath';
import { resolvePlanningPrice } from './budgetPrice';

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
 * Both classifications of the current hour from ONE pass over the series.
 *
 * `getPriceLevelFlags` already computes `isCheap` and `isExpensive` together, so
 * asking `isCurrentHourAtLevel` twice re-derives the current hour, the average,
 * and the thresholds for an answer it had in hand. That is cheap here — but the
 * caller has to hand in `prices`, and on the PELS runtime the only source is
 * `PriceService.getCombinedHourlyPrices()`, which is uncached and rebuilds the
 * whole series from settings (~25 ms on a Homey Pro). Two predicate calls meant
 * two rebuilds. See `PriceService.getCurrentHourPriceLevel`.
 *
 * Not mutually exclusive by construction: the flags are `price <= low` and
 * `price >= high`, so at `thresholdPercent` 0 a price exactly on the average is
 * both. Callers that need one winner apply their own precedence.
 */
export const resolveCurrentHourPriceLevel = (params: {
  prices: PriceEntry[];
  thresholdPercent: number;
  minDiff: number;
  nowMs?: number;
}): { cheap: boolean; expensive: boolean } => {
  const { prices, thresholdPercent, minDiff, nowMs } = params;
  const currentPrice = getCurrentHourPrice(prices, nowMs);
  if (!currentPrice) return { cheap: false, expensive: false };
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
  return { cheap: flags.isCheap, expensive: flags.isExpensive };
};
