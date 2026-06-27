// Planning price (`budgetPrice`) — where import and export meet, as inputs.
//
// For a prosumer, the cost of consuming in an hour is not the grid import price
// alone: up to the forecast solar surplus, consuming merely forgoes the (low/
// negative) export price, so flexible load should shift toward hours where
// self-consuming your own solar is cheapest. `budgetPrice` is that single per-hour
// planning signal — a coverage-weighted blend of the export price (for the surplus
// band) and the import price (above it). It is DERIVED from `total` + `exportPrice`
// + the injected forecast surplus; it never feeds money/receipts (those stay on
// `total`). When no surplus is forecast it is left unset (≡ total), so non-prosumer
// behaviour is byte-identical.

import type { CombinedHourlyPrice } from './priceTypes';

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const isPositiveFinite = (value: number | undefined): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

/**
 * Coverage-weighted planning price for one hour, or `undefined` when it should fall
 * back to `total` (no export price, no trusted surplus, or no flexible appetite).
 * `coverage = clamp(surplus / expectedManagedDraw, 0, 1)` — a smooth gradient that
 * spreads load rather than over-pulling everything into thin-surplus hours.
 */
export const resolveBudgetPrice = (params: {
  totalPrice: number;
  exportPrice: number | undefined;
  surplusKwh: number | undefined;
  expectedManagedDrawKwh: number;
}): number | undefined => {
  const { totalPrice, exportPrice, surplusKwh, expectedManagedDrawKwh } = params;
  if (typeof exportPrice !== 'number' || !Number.isFinite(exportPrice)) return undefined;
  if (!isPositiveFinite(surplusKwh) || !isPositiveFinite(expectedManagedDrawKwh)) return undefined;
  const coverage = clampUnit(surplusKwh / expectedManagedDrawKwh);
  const blended = coverage * exportPrice + (1 - coverage) * totalPrice;
  return Number.isFinite(blended) ? blended : undefined;
};

/** Per-hour inputs the blend needs beyond the price entry itself. */
export type BudgetPriceInputs = {
  /** Forecast self-consumable solar surplus for the hour starting at `startsAtMs` (kWh). */
  getSurplusKwh: (startsAtMs: number) => number | undefined;
  /** Stable estimate of the hour's flexible (managed) appetite (kWh). */
  expectedManagedDrawKwh: number;
};

/**
 * Layer the planning price onto a combined hourly-price series, scheme-independently
 * (it reads only `total` + `exportPrice` off each entry). No-op (returns the input
 * untouched) when there is no flexible appetite — keeping non-prosumer behaviour
 * byte-identical.
 */
export const applyBudgetPrices = (
  prices: CombinedHourlyPrice[],
  inputs: BudgetPriceInputs | undefined,
): CombinedHourlyPrice[] => {
  if (!inputs || !isPositiveFinite(inputs.expectedManagedDrawKwh)) return prices;
  return prices.map((entry) => {
    const startsAtMs = Date.parse(entry.startsAt);
    const surplusKwh = Number.isFinite(startsAtMs) ? inputs.getSurplusKwh(startsAtMs) : undefined;
    const budgetPrice = resolveBudgetPrice({
      totalPrice: entry.totalPrice,
      exportPrice: entry.exportPrice,
      surplusKwh,
      expectedManagedDrawKwh: inputs.expectedManagedDrawKwh,
    });
    return typeof budgetPrice === 'number' ? { ...entry, budgetPrice } : entry;
  });
};
