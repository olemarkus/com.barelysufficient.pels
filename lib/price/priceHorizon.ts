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

// A delivery tick books the stretch since the previous tick, so it can price
// periods that started before a day rollover dropped their payload. A day of
// served periods covers any tick gap within one process.
const METERED_PRICE_RETENTION_MS = 24 * 60 * MINUTE_MS;

/**
 * The periods served now, plus earlier served periods that have started, still
 * fall inside the retention window, and no longer appear in the series (the
 * rollover cleared their day). A retained period keeps the price, tone and
 * currency it was served with. A period that has not started is never
 * retained: a source that withdraws a future period has withdrawn its price.
 */
export const retainServedMeteredPeriods = (
  previous: readonly MeteredPricePeriod[],
  served: readonly MeteredPricePeriod[],
  nowMs: number,
): MeteredPricePeriod[] => {
  const sameCurrency = (period: MeteredPricePeriod): boolean => served.every((current) => (
    current.costDisplay.unit === period.costDisplay.unit
      && current.costDisplay.divisor === period.costDisplay.divisor
  ));
  const retained = previous.filter((period) => period.startMs < nowMs
    && period.endMs > nowMs - METERED_PRICE_RETENTION_MS
    && sameCurrency(period)
    && !served.some((current) => current.startMs < period.endMs && current.endMs > period.startMs));
  return [...retained, ...served].sort((left, right) => left.startMs - right.startMs);
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
