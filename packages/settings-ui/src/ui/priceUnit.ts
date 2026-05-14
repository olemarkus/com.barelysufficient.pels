// Shared price-unit resolution for chart axes and tooltips. Both the Budget
// chart and the Deadline-plan horizon chart format prices the same way so the
// user is never left guessing whether a value is øre or kr per kWh.

import type { CostDisplay } from './dailyBudgetCost.ts';

const DEFAULT_PRICE_UNIT_LABEL = 'øre/kWh';

const normalizeUnitWithKwh = (unit: string): string => (
  unit.toLowerCase().includes('/kwh') ? unit : `${unit}/kWh`
);

/**
 * Returns the axis/tooltip label for a price value, normalizing to a `/kWh`
 * suffix when the source `CostDisplay.unit` omits it. Falls back to the
 * Norwegian convention (`øre/kWh`) when the unit is missing.
 */
export const resolvePriceUnitLabel = (display: CostDisplay): string => {
  const unit = display.unit.trim();
  if (!unit) return DEFAULT_PRICE_UNIT_LABEL;
  return normalizeUnitWithKwh(unit);
};

type CombinedPricesUnitFields = {
  priceScheme?: unknown;
  priceUnit?: unknown;
};

/**
 * Derives the same {@link CostDisplay} from the raw `combinedPrices` payload
 * that `dailyBudget.ts` uses. Deadline-plan rendering reuses this so its
 * tooltips and axis labels stay aligned with the Budget chart.
 */
export const resolveCostDisplayFromCombinedPrices = (combinedPrices: unknown): CostDisplay => {
  if (!combinedPrices || typeof combinedPrices !== 'object') {
    return { unit: 'kr', divisor: 100 };
  }
  const { priceScheme, priceUnit } = combinedPrices as CombinedPricesUnitFields;
  if (priceScheme === 'flow' || priceScheme === 'homey') {
    const unit = typeof priceUnit === 'string' && priceUnit !== 'price units' ? priceUnit : '';
    return { unit, divisor: 1 };
  }
  return { unit: 'kr', divisor: 100 };
};
