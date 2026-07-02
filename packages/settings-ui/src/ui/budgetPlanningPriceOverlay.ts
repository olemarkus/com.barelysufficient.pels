// Overlay the Budget hourly chart's per-bucket price series (`buckets.price`,
// the import money price) with the PLANNING price (`budgetPrice ?? total`) for
// any bucket a combined-price row diverges on. The hourly chart's price CURVE
// and its readout `Price` segment describe WHY the green budget bars are shaped
// the way they are, and the bars are shaped by the planning price (post-#1808),
// so the curve must follow the same signal or the visualization contradicts
// itself for a prosumer.
//
// Kept out of `budgetRedesignResolvers.ts` so that file stays under its line
// ceiling and `resolveChartData` stays under its complexity ceiling; this
// module owns the single planning-price overlay decision for the Budget chart.

import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  PLANNING_PRICE_REASON_LINE,
  planningPriceDivergesFromImport,
} from '../../../shared-domain/src/price/planningPrice.ts';
import type { CombinedPriceRow } from './combinedPrices.ts';

// Index the per-hour planning price (`budgetPrice`) from the combined rows,
// keyed by hour-start epoch ms. Only finite values land, so an absent/junk
// budgetPrice leaves the hour on the import price.
const buildBudgetPriceByStart = (priceRows: CombinedPriceRow[]): Map<number, number> => {
  const byStart = new Map<number, number>();
  for (const row of priceRows) {
    // Finite-gate the planning price (not just `typeof number`) so a NaN/Infinity
    // never lands in the map and later reads as a "divergence". `normalizeCombined-
    // Prices` already finite-gates `budgetPrice`, so this is defensive at the
    // consumer, matching the boundary convention. `Number.isFinite` is the global
    // (no `lib/**` import).
    if (typeof row.budgetPrice !== 'number' || !Number.isFinite(row.budgetPrice)) continue;
    const startsAtMs = new Date(row.startsAt).getTime();
    if (Number.isFinite(startsAtMs)) byStart.set(startsAtMs, row.budgetPrice);
  }
  return byStart;
};

const overlayHourlyPlanningPrice = (
  payload: DailyBudgetDayPayload,
  priceRows: CombinedPriceRow[],
  divisor: number,
): { payload: DailyBudgetDayPayload; diverged: boolean } => {
  const importPrices = payload.buckets.price;
  const startUtc = payload.buckets.startUtc;
  // Array-guard every input before `.length`/iteration so a null/undefined
  // `priceRows` (or a malformed payload where `price`/`startUtc` isn't an array)
  // can't throw — it degrades to "no overlay" instead.
  if (
    !Array.isArray(priceRows)
    || priceRows.length === 0
    || !Array.isArray(importPrices)
    || !Array.isArray(startUtc)
  ) {
    return { payload, diverged: false };
  }
  const budgetPriceByStart = buildBudgetPriceByStart(priceRows);
  if (budgetPriceByStart.size === 0) return { payload, diverged: false };
  let diverged = false;
  const overlaid = importPrices.map((total, index) => {
    if (typeof total !== 'number') return total;
    const startsAtMs = new Date(startUtc[index] ?? '').getTime();
    const budgetPrice = Number.isFinite(startsAtMs) ? budgetPriceByStart.get(startsAtMs) : undefined;
    if (!planningPriceDivergesFromImport(budgetPrice, total, divisor)) return total;
    diverged = true;
    return budgetPrice as number;
  });
  if (!diverged) return { payload, diverged: false };
  return {
    payload: { ...payload, buckets: { ...payload.buckets, price: overlaid } },
    diverged: true,
  };
};

/**
 * Resolve the payload the hourly chart should render (with `buckets.price`
 * possibly overlaid to the planning price) plus the "using your solar" reason
 * line to render beneath it. When `showPrice` is false, or nothing diverges (no
 * rows, or a non-prosumer with no diverging `budgetPrice`), the ORIGINAL
 * payload is returned untouched (reference-equal) and the note is null — so the
 * Budget chart is byte-identical outside a solar home. `divisor` gates
 * divergence on the DISPLAY resolution so the overlay/note never appears
 * without a visible price change. Only `buckets.price` is ever touched; the
 * money/cost cumulatives and the hero's estimated-cost line read the untouched
 * import price elsewhere.
 */
export const resolveHourlyChartPricePayload = (params: {
  payload: DailyBudgetDayPayload;
  showPrice: boolean;
  priceRows: CombinedPriceRow[];
  divisor: number;
}): { payload: DailyBudgetDayPayload; planningPriceNote: string | null } => {
  if (!params.showPrice) return { payload: params.payload, planningPriceNote: null };
  const { payload, diverged } = overlayHourlyPlanningPrice(params.payload, params.priceRows, params.divisor);
  return { payload, planningPriceNote: diverged ? PLANNING_PRICE_REASON_LINE : null };
};
