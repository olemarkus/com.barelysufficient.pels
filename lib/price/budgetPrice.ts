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

import { getHourStartInTimeZone } from '../utils/dateUtils';
import type { CombinedPriceFields } from './priceTypes';

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

/**
 * Resolve the planning price for one entry: the finite `budgetPrice` when the
 * producer derived one, else the import `total`. The single fallback rule every
 * planning consumer (daily-budget shaping, smart-task horizons, price levels,
 * cheapest-hours) applies — so an absent `budgetPrice` is byte-identical to
 * planning on `total`. Boundary-safe for persisted payloads: a present but
 * non-finite `budgetPrice` (junk write) falls back to the total. Never used for
 * money/receipts (those stay on `total`), and never clamped — a `<= 0` planning
 * price is legal (self-consuming surplus can be cheaper than free).
 */
export const resolvePlanningPrice = (budgetPrice: number | undefined, totalPrice: number): number => (
  typeof budgetPrice === 'number' && Number.isFinite(budgetPrice) ? budgetPrice : totalPrice
);

/** Per-hour inputs the blend needs beyond the price entry itself. */
export type BudgetPriceInputs = {
  /** Forecast self-consumable solar surplus for the hour CONTAINING `instantMs` (kWh). */
  getSurplusKwh: (instantMs: number) => number | undefined;
  /** Stable estimate of the hour's flexible (managed) appetite (kWh). */
  expectedManagedDrawKwh: number;
};

/**
 * Layer the planning price onto a combined price series, scheme-independently
 * (it reads only `total` + `exportPrice` off each entry). No-op (returns the input
 * untouched) when there is no flexible appetite — keeping non-prosumer behaviour
 * byte-identical.
 *
 * The forecast surplus is an hourly figure, so each entry asks for the hour it
 * starts in — identity for an hourly entry, and the containing hour for a
 * quarter. Nothing is scaled down to the quarter, and nothing should be: the
 * blend weighs surplus against the flexible appetite, and over a quarter of an
 * hour both are a quarter of their hourly selves, so the coverage — and
 * therefore the planning price — is the same number either way. Scaling one
 * without the other is what would be wrong.
 */
export const applyBudgetPrices = <T extends CombinedPriceFields>(
  prices: T[],
  inputs: BudgetPriceInputs | undefined,
  timeZone: string,
): T[] => {
  if (!inputs || !isPositiveFinite(inputs.expectedManagedDrawKwh)) return prices;
  return prices.map((entry) => {
    const startsAtMs = Date.parse(entry.startsAt);
    const surplusKwh = Number.isFinite(startsAtMs)
      ? inputs.getSurplusKwh(getHourStartInTimeZone(new Date(startsAtMs), timeZone))
      : undefined;
    const budgetPrice = resolveBudgetPrice({
      totalPrice: entry.totalPrice,
      exportPrice: entry.exportPrice,
      surplusKwh,
      expectedManagedDrawKwh: inputs.expectedManagedDrawKwh,
    });
    return typeof budgetPrice === 'number' ? { ...entry, budgetPrice } : entry;
  });
};
