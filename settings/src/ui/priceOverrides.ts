import { calculateAveragePrice } from '../../../lib/price/priceMath';
import type { CombinedPriceData } from './priceTypes';
import { calculateThresholds } from './priceThresholds';

export type PriceOverrideOptions = {
  thresholdPercent?: number;
  minDiffOre?: number;
};

const resolveNumber = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

export const applyPriceOverrides = (data: CombinedPriceData, overrides: PriceOverrideOptions): CombinedPriceData => {
  // Keep this logic aligned with priceService.updateCombinedPrices.
  const thresholdPercent = resolveNumber(overrides.thresholdPercent, data.thresholdPercent ?? 25);
  const minDiffOre = resolveNumber(overrides.minDiffOre, data.minDiffOre ?? 0);
  const avgPrice = resolveNumber(data.avgPrice, calculateAveragePrice(data.prices, (entry) => entry.total));
  const { low: lowThreshold, high: highThreshold } = calculateThresholds(avgPrice, thresholdPercent);

  const prices = data.prices.map((entry) => {
    const total = Number.isFinite(entry.total) ? entry.total : 0;
    const diffFromAvg = Math.abs(total - avgPrice);
    const meetsMinDiff = diffFromAvg >= minDiffOre;
    return {
      ...entry,
      isCheap: total <= lowThreshold && meetsMinDiff,
      isExpensive: total >= highThreshold && meetsMinDiff,
    };
  });

  return {
    ...data,
    prices,
    avgPrice,
    lowThreshold,
    highThreshold,
    thresholdPercent,
    minDiffOre,
  };
};
