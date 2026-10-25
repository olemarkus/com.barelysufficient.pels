import type { PriceHorizonEntry, MeteredPricePeriod } from '../../packages/planner-types/src/priceHorizon';
import type { SettingsUiTaskPricePeriod } from '../../packages/contracts/src/settingsUiApi';
import { resolvePlanningPrice } from './budgetPrice';
import { resolvePriceLevelTimeline, type PriceLevelBand } from './priceLevelUtils';
import type { CombinedPricePeriod, PriceScheme } from './priceTypes';
import { resolvePlanPriceCostDisplay } from '../../packages/shared-domain/src/planPriceWidgetCopy';

const MINUTE_MS = 60 * 1000;

/** Preserve the source grid, including holes and fractional-offset boundaries. */
export const buildPriceHorizonFromPeriods = (
  periods: CombinedPricePeriod[],
  startMs: number,
  endMs: number,
): PriceHorizonEntry[] => periods.flatMap((period) => {
  const periodStartMs = Date.parse(period.startsAt);
  const periodEndMs = periodStartMs + period.durationMinutes * MINUTE_MS;
  if (periodEndMs <= startMs || periodStartMs >= endMs) return [];
  return [{
    startMs: periodStartMs,
    endMs: periodEndMs,
    price: resolvePlanningPrice(period.budgetPrice, period.totalPrice),
    moneyPrice: period.totalPrice,
  }];
});

/** Price and classify each native period once, without filling unpublished gaps. */
export const buildMeteredPricePeriods = (
  periods: CombinedPricePeriod[],
  band: PriceLevelBand,
  costDisplay: MeteredPricePeriod['costDisplay'],
): MeteredPricePeriod[] => resolvePriceLevelTimeline(periods, band).periods.map((period) => {
  const startMs = Date.parse(period.startsAt);
  return {
    startMs,
    endMs: startMs + period.durationMinutes * MINUTE_MS,
    priceValue: period.totalPrice,
    tone: period.level,
    costDisplay,
  };
});

/** Keep metered currency resolution with the period projection that carries it. */
export const buildMeteredPricePeriodsForScheme = (
  periods: CombinedPricePeriod[],
  band: PriceLevelBand,
  priceScheme: PriceScheme,
  priceUnit: string,
): MeteredPricePeriod[] => {
  const { costUnit, costDivisor } = resolvePlanPriceCostDisplay({ priceScheme, priceUnit });
  return buildMeteredPricePeriods(periods, band, { unit: costUnit, divisor: costDivisor });
};

/** Native task prices for presentation, alongside the existing hourly payload. */
export const buildTaskPricePeriodsForUi = (
  periods: CombinedPricePeriod[],
  band: PriceLevelBand,
): SettingsUiTaskPricePeriod[] => resolvePriceLevelTimeline(periods, band).periods.map((period) => {
  const startsAtMs = Date.parse(period.startsAt);
  return {
    startsAtMs,
    endsAtMs: startsAtMs + period.durationMinutes * MINUTE_MS,
    price: period.totalPrice,
    planningPrice: resolvePlanningPrice(period.budgetPrice, period.totalPrice),
    isCheap: period.level === 'cheap',
    isExpensive: period.level === 'expensive',
  };
});
