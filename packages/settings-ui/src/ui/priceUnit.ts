// Shared price-unit resolution for chart axes and tooltips. Both the Budget
// chart and the Deadline-plan horizon chart format prices the same way so the
// user is never left guessing whether a value is øre or kr per kWh.

import type { CostDisplay } from './dailyBudgetCost.ts';

const NEUTRAL_PRICE_LABEL = 'Price';
const ORE_PER_KWH_LABEL = 'øre/kWh';

const normalizeUnitWithKwh = (unit: string): string => (
  unit.toLowerCase().includes('/kwh') ? unit : `${unit}/kWh`
);

/**
 * Returns the axis/tooltip label for a price value already scaled to the
 * `display.unit` (i.e. divided by `display.divisor` when relevant). Falls
 * back to the neutral `Price` label when the source unit is missing, so
 * Flow / Homey payloads with placeholder units never get a misleading
 * Norwegian-specific label.
 */
export const resolvePriceUnitLabel = (display: CostDisplay): string => {
  const unit = display.unit.trim();
  if (!unit) return NEUTRAL_PRICE_LABEL;
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

/**
 * Returns the axis/tooltip label for raw price values that are **not**
 * scaled by a {@link CostDisplay} divisor — e.g. the deadline-plan horizon
 * chart that plots `hour.price` directly. For the default Norwegian scheme
 * the raw values are øre, so the label is `øre/kWh`. For Flow/Homey
 * payloads we use the supplied `priceUnit` when present, otherwise the
 * neutral `Price` label.
 */
export const resolveRawPriceUnitLabel = (combinedPrices: unknown): string => {
  if (!combinedPrices || typeof combinedPrices !== 'object') {
    return ORE_PER_KWH_LABEL;
  }
  const { priceScheme, priceUnit } = combinedPrices as CombinedPricesUnitFields;
  if (priceScheme === 'flow' || priceScheme === 'homey') {
    if (typeof priceUnit !== 'string' || priceUnit.trim() === '' || priceUnit === 'price units') {
      return NEUTRAL_PRICE_LABEL;
    }
    return normalizeUnitWithKwh(priceUnit);
  }
  return ORE_PER_KWH_LABEL;
};
