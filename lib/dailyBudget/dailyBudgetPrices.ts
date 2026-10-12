import { clamp } from '../../packages/shared-domain/src/utils/math';
import { resolvePlanningPrice } from '../price/budgetPrice';
import type { readCombinedPriceData } from '../price/priceStore';
import { PRICE_SHAPING_PRICE_RANGE_EPSILON } from './dailyBudgetConstants';
import type { DayContext } from './dailyBudgetState';
import type { DailyBudgetSettings } from './dailyBudgetTypes';

/** The combined prices as the price store's reader hands them out. */
export type CombinedPriceData = NonNullable<ReturnType<typeof readCombinedPriceData>>;

/**
 * The day's prices as the plan and the payload read them. `priceSpreadFactor`
 * and `effectivePriceShapingFlexShare` are 0 whenever shaping is not active.
 */
export type PriceData = {
  /** Import money series (`total`): what the payload publishes and cost lines read. */
  prices?: Array<number | null>;
  /** Planning-price series (`budgetPrice ?? total`); ≡ `prices` for non-prosumers. */
  planningPrices?: Array<number | null>;
  priceFactors?: Array<number | null>;
  priceShapingActive: boolean;
  priceSpreadFactor: number;
  /** The share of the remaining budget that price shaping may move. */
  effectivePriceShapingFlexShare: number;
};

/** A day that carries no prices: the budget is off. */
export const NO_PRICE_DATA: PriceData = {
  priceShapingActive: false,
  priceSpreadFactor: 0,
  effectivePriceShapingFlexShare: 0,
};

export function buildPriceData(
  context: DayContext,
  settings: DailyBudgetSettings,
  combinedPrices: CombinedPriceData | null,
  priceOptimizationEnabled: boolean,
): PriceData {
  const priceShape = buildPriceFactors(
    context.bucketStartUtcMs,
    context.currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    settings.priceShapingEnabled,
  );
  return {
    ...priceShape,
    effectivePriceShapingFlexShare: priceShape.priceShapingActive && priceShape.priceSpreadFactor > 0
      ? clamp(settings.priceShapingFlexShare, 0, 1)
      : 0,
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

export function buildPriceFactors(
  bucketStartUtcMs: number[],
  currentBucketIndex: number,
  combinedPrices: CombinedPriceData | null,
  priceOptimizationEnabled: boolean,
  priceShapingEnabled: boolean,
): Omit<PriceData, 'effectivePriceShapingFlexShare'> {
  const safeCurrentBucketIndex = Math.max(0, currentBucketIndex);
  const series = buildPriceSeriesPair({ bucketStartUtcMs, combinedPrices });
  if (!series) {
    return { priceShapingActive: false, priceSpreadFactor: 0 };
  }
  // Money series (`prices`, on `total`) is what the payload publishes and cost
  // lines consume; the planning series drives shaping/allocation below.
  const { prices: pricesAll, planningPrices: planningPricesAll } = series;
  const unshaped = {
    prices: pricesAll,
    planningPrices: planningPricesAll,
    priceShapingActive: false,
    priceSpreadFactor: 0,
  };
  if (!priceOptimizationEnabled || !priceShapingEnabled) return unshaped;
  const remainingPrices = planningPricesAll.slice(safeCurrentBucketIndex);
  if (remainingPrices.some((value) => typeof value !== 'number')) return unshaped;
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
