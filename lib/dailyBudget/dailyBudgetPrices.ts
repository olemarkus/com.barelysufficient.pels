import { clamp } from '../utils/mathUtils';

export type CombinedPriceEntry = {
  startsAt: string;
  total: number;
};

export type CombinedPriceData = {
  prices?: CombinedPriceEntry[];
  lastFetched?: string;
  priceUnit?: string;
};

export function buildPriceDebugData(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): { prices?: Array<number | null>; priceFactors?: Array<number | null>; priceShapingActive: boolean } {
  const priceShape = buildPriceFactors(params);
  return {
    prices: priceShape.prices,
    priceFactors: priceShape.priceFactors,
    priceShapingActive: priceShape.priceShapingActive,
  };
}

/**
 * Map combined price entries onto the bucket timestamps.
 */
export function buildPriceSeries(params: {
  bucketStartUtcMs: number[];
  combinedPrices?: CombinedPriceData | null;
}): Array<number | null> | undefined {
  const { bucketStartUtcMs, combinedPrices } = params;
  const entries = combinedPrices?.prices;
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const priceByStart = new Map<number, number>();
  entries.forEach((entry) => {
    const ts = new Date(entry.startsAt).getTime();
    if (Number.isFinite(ts)) priceByStart.set(ts, entry.total);
  });
  return bucketStartUtcMs.map((ts) => {
    const value = priceByStart.get(ts);
    return typeof value === 'number' ? value : null;
  });
}

export function buildPriceFactors(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): { prices?: Array<number | null>; priceFactors?: Array<number | null>; priceShapingActive: boolean } {
  const {
    bucketStartUtcMs,
    currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  } = params;

  const safeCurrentBucketIndex = Math.max(0, currentBucketIndex);
  const pricesAll = buildPriceSeries({ bucketStartUtcMs, combinedPrices });
  if (!pricesAll) {
    return { priceShapingActive: false };
  }
  if (!priceOptimizationEnabled || !priceShapingEnabled) {
    return { prices: pricesAll, priceShapingActive: false };
  }
  const remainingPrices = pricesAll.slice(safeCurrentBucketIndex);
  if (remainingPrices.some((value) => typeof value !== 'number')) {
    return { prices: pricesAll, priceShapingActive: false };
  }
  const numericPrices = remainingPrices as number[];
  const priceList = [...numericPrices].sort((a, b) => a - b);
  const median = percentile(priceList, 0.5);
  const p10 = percentile(priceList, 0.1);
  const p90 = percentile(priceList, 0.9);
  const spread = Math.max(1, p90 - p10);
  const minFactor = 0.7;
  const maxFactor = 1.3;
  const remainingFactors = numericPrices.map((price) => clamp(1 + (median - price) / spread, minFactor, maxFactor));
  const priceFactorsAll = [
    ...Array.from({ length: safeCurrentBucketIndex }, () => null),
    ...remainingFactors,
  ];

  return {
    prices: pricesAll,
    priceFactors: priceFactorsAll,
    priceShapingActive: true,
  };
}

function percentile(values: number[], ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  if (values.length === 0) return 0;
  const normalized = Math.max(0, Math.min(1, ratio));
  const index = Math.floor(normalized * (values.length - 1));
  return values[index] ?? 0;
}
