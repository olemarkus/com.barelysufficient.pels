import {
  calculateDurationWeightedAveragePrice,
  calculateThresholds,
  getPriceLevelFlags,
} from './priceMath';
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
 * Computed over the IMPORT price (`totalPrice`), the average and the current
 * period alike, so every level an owner sees (thermostat price deltas, the
 * `price_level` flow trigger, the pels_insights level capability) matches the
 * price curve they are billed on. Solar never changes a level (owner ruling
 * 2026-10-05): the planning price (`budgetPrice`) steers daily-budget shaping
 * and smart-task scheduling only, and solar surplus has its own controls.
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
  const currentPrice = getCurrentPricePeriod(prices, nowMs);
  if (!currentPrice) return PriceLevel.UNKNOWN;
  return createPricePeriodClassifier(prices, band)(currentPrice);
};

/**
 * Classifies any period of `prices` against the owner's band, over the
 * duration-weighted average of the whole series. Built once per series, so the
 * current level and the look-ahead below answer from the same average.
 */
const createPricePeriodClassifier = (
  prices: PriceEntry[],
  band: PriceLevelBand,
): (period: PriceEntry) => PriceLevel => {
  const avgPrice = calculateDurationWeightedAveragePrice(
    prices,
    (entry) => entry.totalPrice,
    (entry) => entry.durationMinutes,
  );
  const thresholds = calculateThresholds(avgPrice, band.thresholdPercent);
  return (period) => {
    const flags = getPriceLevelFlags({
      price: period.totalPrice,
      avgPrice,
      thresholds,
      minDiff: band.minDiff,
    });
    if (flags.isCheap) return PriceLevel.CHEAP;
    if (flags.isExpensive) return PriceLevel.EXPENSIVE;
    return PriceLevel.NORMAL;
  };
};

/** The window a look-ahead covers: periods starting after `nowMs`, up to and including `nowMs + horizonMs`. */
export type PriceLevelLookahead = {
  nowMs: number;
  horizonMs: number;
};

/**
 * A look-ahead's answer. `unavailable` is a series that could not be built
 * right now, or one with no price for the period in force, kept apart from an
 * empty `levels`: "no change is coming" and "the prices could not be read"
 * send a Flow opposite ways.
 */
export type PriceLevelChangesRead =
  | { state: 'resolved'; levels: PriceLevel[] }
  | { state: 'unavailable' };

const MINUTE_MS = 60 * 1000;

const periodStartMs = (period: PriceEntry): number => new Date(period.startsAt).getTime();

/**
 * The levels the price CHANGES TO inside the window, in time order.
 *
 * A change is a period that starts inside the window at a different level from
 * the period ending where it starts. The period in force at `nowMs` began
 * before the window, so it is never a change itself, but it is what the first
 * period in the window is compared with. A period with no predecessor in the
 * series (a gap in the prices) counts as a change: PELS knew no level before it.
 *
 * Classified against the same average and band as
 * {@link resolveCurrentPricePeriodLevel}, so a level reported here is the
 * current level once that period starts, provided the series holds until then.
 * It does not always hold: tomorrow's prices arriving, or a new day dropping
 * the old one, move the average. That is a promise about the level, not about
 * `price_level_changed`, which fires only when PELS next publishes its status
 * and can miss a period shorter than the gap between two meter readings. Past the last known price nothing is
 * reported, because missing prices are not a level.
 *
 * A series with no period in force at `nowMs` is `unavailable`: a price source
 * that cannot price this period yields no periods rather than an error (a
 * Homey price formula never read, unreadable or unsupported, or no prices
 * stored for today), and that must not read as "no change is coming".
 */
export const resolvePriceLevelChangesWithin = (
  prices: PriceEntry[],
  band: PriceLevelBand,
  window: PriceLevelLookahead,
): PriceLevelChangesRead => {
  if (getCurrentPricePeriod(prices, window.nowMs) === null) return { state: 'unavailable' };
  const classify = createPricePeriodClassifier(prices, band);
  const byEndMs = new Map(prices.map((period) => [
    periodStartMs(period) + period.durationMinutes * MINUTE_MS,
    period,
  ]));
  const windowEndMs = window.nowMs + window.horizonMs;
  const levels = prices
    .filter((period) => {
      const startMs = periodStartMs(period);
      return startMs > window.nowMs && startMs <= windowEndMs;
    })
    .sort((a, b) => periodStartMs(a) - periodStartMs(b))
    .flatMap((period) => {
      const level = classify(period);
      const previous = byEndMs.get(periodStartMs(period));
      return previous !== undefined && classify(previous) === level ? [] : [level];
    });
  return { state: 'resolved', levels };
};

