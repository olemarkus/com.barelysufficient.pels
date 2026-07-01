import { clamp } from '../utils/mathUtils';
import { resolvePlanningPrice } from '../price/budgetPrice';
import {
  PRICE_SHAPING_FLEX_SHARE,
  PRICE_SHAPING_PRICE_RANGE_EPSILON,
} from './dailyBudgetConstants';

export type CombinedPriceEntry = {
  startsAt: string;
  total: number;
  // Optional planning price (`budgetPrice ?? total` at consumption time) — the
  // export/import blend the producer derives over the forecast solar surplus
  // (see lib/price/budgetPrice.ts). Absent for non-prosumers, in which case
  // every consumer falls back to `total` and behaviour is byte-identical.
  budgetPrice?: number;
  // Optional price-tier flags. Present on the canonical price store entries
  // (see lib/price/priceTypes.ts) and consumed by the snapshot signature so
  // that threshold/surcharge changes which only flip these flags still
  // re-seed adjacent days. Optional here because legacy/test data may omit
  // them.
  isCheap?: boolean;
  isExpensive?: boolean;
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
  priceShapingFlexShare?: number;
}): {
  prices?: Array<number | null>;
  priceFactors?: Array<number | null>;
  priceShapingActive: boolean;
  priceSpreadFactor?: number;
  effectivePriceShapingFlexShare?: number;
} {
  const priceShape = buildPriceFactors(params);
  const configuredFlexShare = typeof params.priceShapingFlexShare === 'number'
    ? params.priceShapingFlexShare
    : PRICE_SHAPING_FLEX_SHARE;
  const priceSpreadFactor = typeof priceShape.priceSpreadFactor === 'number'
    ? priceShape.priceSpreadFactor
    : 0;
  const effectivePriceShapingFlexShare = priceShape.priceShapingActive
    && priceSpreadFactor > 0
    ? clamp(configuredFlexShare, 0, 1)
    : 0;
  return {
    prices: priceShape.prices,
    priceFactors: priceShape.priceFactors,
    priceShapingActive: priceShape.priceShapingActive,
    priceSpreadFactor,
    effectivePriceShapingFlexShare,
  };
}

/**
 * Map combined price entries onto the bucket timestamps, producing both series
 * in one pass over the entries:
 * - `prices` — the import money price (`total`). Feeds the published
 *   `buckets.price` and every cost/money surface (Budget chart actuals, pace and
 *   projection cost lines) — those MUST stay on `total`.
 * - `planningPrices` — the planning price (`budgetPrice ?? total`, the shared
 *   `resolvePlanningPrice` rule). Feeds price shaping and the remaining-budget
 *   allocation only, so a prosumer's day plan shifts load toward
 *   forecast-surplus hours. Identical to `prices` when no entry carries a
 *   `budgetPrice`.
 *
 * Returns `undefined` when there are no entries; otherwise both series exist
 * and cover the same buckets (a bucket is priced on both or on neither).
 */
export function buildPriceSeriesPair(params: {
  bucketStartUtcMs: number[];
  combinedPrices?: CombinedPriceData | null;
}): { prices: Array<number | null>; planningPrices: Array<number | null> } | undefined {
  const { bucketStartUtcMs, combinedPrices } = params;
  const entries = combinedPrices?.prices;
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const byStart = new Map<number, { total: number; planning: number }>();
  for (const entry of entries) {
    const ts = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(ts)) continue;
    byStart.set(ts, {
      total: entry.total,
      planning: resolvePlanningPrice(entry.budgetPrice, entry.total),
    });
  }
  return {
    prices: bucketStartUtcMs.map((ts) => byStart.get(ts)?.total ?? null),
    planningPrices: bucketStartUtcMs.map((ts) => byStart.get(ts)?.planning ?? null),
  };
}

export function buildPriceFactors(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): {
  prices?: Array<number | null>;
  /** Planning-price series (`budgetPrice ?? total`); ≡ `prices` for non-prosumers. */
  planningPrices?: Array<number | null>;
  priceFactors?: Array<number | null>;
  priceShapingActive: boolean;
  priceSpreadFactor?: number;
} {
  const {
    bucketStartUtcMs,
    currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  } = params;

  const safeCurrentBucketIndex = Math.max(0, currentBucketIndex);
  const series = buildPriceSeriesPair({ bucketStartUtcMs, combinedPrices });
  if (!series) {
    return { priceShapingActive: false };
  }
  // Money series (`prices`, on `total`) is what the payload publishes and cost
  // lines consume; the planning series drives shaping/allocation below.
  const { prices: pricesAll, planningPrices: planningPricesAll } = series;
  if (!priceOptimizationEnabled || !priceShapingEnabled) {
    return { prices: pricesAll, planningPrices: planningPricesAll, priceShapingActive: false };
  }
  const remainingPrices = planningPricesAll.slice(safeCurrentBucketIndex);
  if (remainingPrices.some((value) => typeof value !== 'number')) {
    return { prices: pricesAll, planningPrices: planningPricesAll, priceShapingActive: false };
  }
  const numericPrices = remainingPrices as number[];
  const priceList = [...numericPrices].sort((a, b) => a - b);
  const median = percentile(priceList, 0.5);
  const min = priceList[0] ?? median;
  const max = priceList[priceList.length - 1] ?? median;
  const spread = Math.max(0, max - min);
  const priceSpreadFactor = spread > PRICE_SHAPING_PRICE_RANGE_EPSILON
    ? resolvePriceSpreadFactor({ spread, median })
    : 0;
  // Avoid divide-by-zero and keep shaping stable when prices are flat.
  const normalizedSpread = Math.max(1, spread);
  const minFactor = 0.7;
  const maxFactor = 1.3;
  const remainingFactors = numericPrices.map((price) => (
    clamp(1 + (median - price) / normalizedSpread, minFactor, maxFactor)
  ));
  const priceFactorsAll = [
    ...Array.from({ length: safeCurrentBucketIndex }, () => null),
    ...remainingFactors,
  ];

  return {
    prices: pricesAll,
    planningPrices: planningPricesAll,
    priceFactors: priceFactorsAll,
    priceShapingActive: true,
    priceSpreadFactor,
  };
}

function percentile(values: number[], ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  if (values.length === 0) return 0;
  const normalized = Math.max(0, Math.min(1, ratio));
  const index = Math.floor(normalized * (values.length - 1));
  return values[index] ?? 0;
}

function resolvePriceSpreadFactor(params: {
  spread: number;
  median: number;
}): number {
  const { spread, median } = params;
  if (!Number.isFinite(spread) || spread <= 0) return 0;
  const reference = Math.max(1, Math.abs(median));
  return clamp(spread / reference, 0, 1);
}
