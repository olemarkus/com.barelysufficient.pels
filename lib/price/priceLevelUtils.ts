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

export const getAveragePrice = (prices: PriceEntry[]): number => (
  prices.reduce((sum, price) => sum + price.totalPrice, 0) / prices.length
);

export const getThresholds = (avgPrice: number, thresholdPercent: number, minDiff: number): {
  low: number;
  high: number;
  minDiff: number;
} => {
  const thresholdMultiplier = thresholdPercent / 100;
  return {
    low: avgPrice * (1 - thresholdMultiplier),
    high: avgPrice * (1 + thresholdMultiplier),
    minDiff,
  };
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
  const avgPrice = getAveragePrice(prices);
  const thresholds = getThresholds(avgPrice, thresholdPercent, minDiff);
  if (level === 'cheap') {
    const diffFromAvg = avgPrice - currentPrice.totalPrice;
    return currentPrice.totalPrice <= thresholds.low && diffFromAvg >= thresholds.minDiff;
  }
  const diffFromAvg = currentPrice.totalPrice - avgPrice;
  return currentPrice.totalPrice >= thresholds.high && diffFromAvg >= thresholds.minDiff;
};
