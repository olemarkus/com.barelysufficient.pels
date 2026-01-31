import { calculateAveragePrice, calculateThresholds, isPriceAtLevel } from './priceMath';

type PriceEntry = {
  startsAt: string;
  totalPrice: number;
};

export const getCurrentHourPrice = (prices: PriceEntry[], nowMs: number = Date.now()): PriceEntry | null => {
  if (prices.length === 0) return null;
  return prices.find((price) => {
    const hourStart = new Date(price.startsAt).getTime();
    return nowMs >= hourStart && nowMs < hourStart + 60 * 60 * 1000;
  }) || null;
};

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
  const avgPrice = calculateAveragePrice(prices, (entry) => entry.totalPrice);
  const thresholds = calculateThresholds(avgPrice, thresholdPercent);
  return isPriceAtLevel({
    price: currentPrice.totalPrice,
    avgPrice,
    thresholds,
    minDiff,
    level,
  });
};
