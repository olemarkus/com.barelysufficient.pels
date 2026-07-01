import { calculateAveragePrice, calculateThresholds, isPriceAtLevel } from './priceMath';
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
