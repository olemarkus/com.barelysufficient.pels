export type PriceThresholds = {
  low: number;
  high: number;
};

const toNumber = (value: unknown, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

export const calculateAveragePrice = <T>(
  prices: T[],
  getValue: (entry: T) => number,
): number => {
  if (!Array.isArray(prices) || prices.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const entry of prices) {
    const value = getValue(entry);
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
};

export const calculateThresholds = (avgPrice: number, thresholdPercent: number): PriceThresholds => {
  const safeAvg = toNumber(avgPrice, 0);
  const safePercent = toNumber(thresholdPercent, 0);
  const multiplier = safePercent / 100;
  return {
    low: safeAvg * (1 - multiplier),
    high: safeAvg * (1 + multiplier),
  };
};

export const getPriceLevelFlags = (params: {
  price: number;
  avgPrice: number;
  thresholds: PriceThresholds;
  minDiff: number;
}): { isCheap: boolean; isExpensive: boolean } => {
  const { price, avgPrice, thresholds, minDiff } = params;
  const safePrice = toNumber(price, 0);
  const safeAvg = toNumber(avgPrice, 0);
  const safeMinDiff = toNumber(minDiff, 0);
  const diffFromAvg = Math.abs(safePrice - safeAvg);
  const meetsMinDiff = diffFromAvg >= safeMinDiff;
  return {
    isCheap: safePrice <= thresholds.low && meetsMinDiff,
    isExpensive: safePrice >= thresholds.high && meetsMinDiff,
  };
};

export const isPriceAtLevel = (params: {
  price: number;
  avgPrice: number;
  thresholds: PriceThresholds;
  minDiff: number;
  level: 'cheap' | 'expensive';
}): boolean => {
  const { level, ...rest } = params;
  const flags = getPriceLevelFlags(rest);
  return level === 'cheap' ? flags.isCheap : flags.isExpensive;
};
