import {
  calculateDurationWeightedAveragePrice,
  calculateThresholds,
  getPriceLevelFlags,
} from './priceMath';
import { resolvePlanningPrice } from './budgetPrice';
import { PriceLevel } from './priceLevels';

/** The owner's cheap/expensive band, as they configured it. */
export type PriceLevelBand = {
  thresholdPercent: number;
  minDiff: number;
};

type PriceEntry = {
  startsAt: string;
  totalPrice: number;
  /** How long this price applies — 60 on an hourly source, 15 on a quarter-hour one. */
  durationMinutes: number;
  /** Planning price (`budgetPrice ?? totalPrice`); absent for non-prosumers. */
  budgetPrice?: number;
};

/**
 * The period covering `nowMs`, or null when the series does not reach it.
 *
 * Each period is asked how long it lasts rather than assumed to be an hour: on
 * a Homey Energy zone that has moved to the 15-minute market, assuming the hour
 * would answer with the :00 quarter's price for the whole hour, and quarters
 * inside one hour have been seen to differ from that hour's average by a fifth
 * of the whole day's range.
 */
export const getCurrentPricePeriod = (prices: PriceEntry[], nowMs: number = Date.now()): PriceEntry | null => {
  if (prices.length === 0) return null;
  return prices.find((price) => {
    const startMs = new Date(price.startsAt).getTime();
    return nowMs >= startMs && nowMs < startMs + price.durationMinutes * 60 * 1000;
  }) || null;
};

/**
 * The RESOLVED price level right now, from ONE pass over the series.
 *
 * Computed over the PLANNING price (`budgetPrice ?? totalPrice`), the average
 * and the current period alike, so the level agrees with what the planner
 * schedules against (thermostat price deltas, the `price_level` flow trigger,
 * the pels_insights level capability). Identical to a total-based
 * classification when no export price is configured.
 *
 * `getPriceLevelFlags` computes `isCheap` and `isExpensive` together, so one
 * pass answers both. The caller hands in `prices`, and on the PELS runtime the
 * only source is `PriceService.getCombinedPricePeriods()`, which is uncached and
 * rebuilds the whole series from settings (~25 ms on a Homey Pro). See
 * `PriceService.getCurrentHourPriceLevel`.
 *
 * One `PriceLevel`, not the two raw flags. The flags are not mutually exclusive
 * — `price <= low` and `price >= high`, so at `thresholdPercent` 0 a price
 * exactly on the average is both — and every consumer resolved that the same
 * way, cheap-first. Resolving it here means no consumer re-derives a precedence
 * or a "do we even have prices?" shape check: no current period is
 * `UNKNOWN`, and that is the producer's answer rather than something a caller
 * infers from a price blob it had to read for the purpose.
 */
export const resolveCurrentPricePeriodLevel = (
  prices: PriceEntry[],
  band: PriceLevelBand,
  nowMs?: number,
): PriceLevel => {
  const { thresholdPercent, minDiff } = band;
  const currentPrice = getCurrentPricePeriod(prices, nowMs);
  if (!currentPrice) return PriceLevel.UNKNOWN;
  const avgPrice = calculateDurationWeightedAveragePrice(
    prices,
    (entry) => resolvePlanningPrice(entry.budgetPrice, entry.totalPrice),
    (entry) => entry.durationMinutes,
  );
  const flags = getPriceLevelFlags({
    price: resolvePlanningPrice(currentPrice.budgetPrice, currentPrice.totalPrice),
    avgPrice,
    thresholds: calculateThresholds(avgPrice, thresholdPercent),
    minDiff,
  });
  if (flags.isCheap) return PriceLevel.CHEAP;
  if (flags.isExpensive) return PriceLevel.EXPENSIVE;
  return PriceLevel.NORMAL;
};

