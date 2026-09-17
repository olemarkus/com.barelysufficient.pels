import { getHourStartInTimeZone } from '../utils/dateUtils';
import type { CombinedHourlyPrice } from './priceTypes';
import type { FlowPricePeriod } from '../../packages/shared-domain/src/price/flowPriceUtils';

const HOUR_MINUTES = 60;

/**
 * One hour-long period per local hour the series covers.
 *
 * A price source publishes periods — an hour each on most zones, a quarter-hour
 * each on a Homey Energy zone that has moved to the 15-minute market. Each
 * hour's price is the duration-weighted average of the periods starting inside
 * it. For four equal quarters that is their plain mean, which is exactly what an
 * hourly zone would have published for the same hour. The weighting carries the
 * honest answer when an hour is unevenly covered, and an hour with no periods at
 * all is absent rather than guessed.
 *
 * Bucketing is by the period's start instant, so a DST day's repeated or missing
 * clock hour lands on the right bucket rather than colliding on the clock hour.
 * Every bucket is one hour long: the clock hour that repeats is two of them, and
 * the one that vanishes is none.
 *
 * `flowPriceUtils.buildPricesByHourFromPeriods` does the same averaging for the
 * persisted `pricesByHour` map, keyed by clock hour. The two stay separate
 * because that one has a settings-UI consumer and must live in shared-domain,
 * while this one keys by instant so the repeated clock hour stays two hours.
 */
export const toHourlyPeriods = (
  periods: FlowPricePeriod[],
  timeZone: string,
): FlowPricePeriod[] => {
  const buckets = new Map<number, { weighted: number; minutes: number }>();
  for (const period of periods) {
    const startMs = Date.parse(period.startsAt);
    if (!Number.isFinite(startMs)) continue;
    const hourStartMs = getHourStartInTimeZone(new Date(startMs), timeZone);
    const current = buckets.get(hourStartMs) ?? { weighted: 0, minutes: 0 };
    buckets.set(hourStartMs, {
      weighted: current.weighted + period.totalPrice * period.durationMinutes,
      minutes: current.minutes + period.durationMinutes,
    });
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.minutes > 0)
    .sort(([left], [right]) => left - right)
    .map(([hourStartMs, bucket]) => ({
      startsAt: new Date(hourStartMs).toISOString(),
      totalPrice: bucket.weighted / bucket.minutes,
      durationMinutes: HOUR_MINUTES,
    }));
};

/**
 * The hour-shaped price series every consumer outside this module gets.
 *
 * Most of PELS reasons in whole hours, because that is the shape of the thing it
 * is reasoning about: the capacity tariff is an hourly peak, the daily budget is
 * spread over hourly buckets, a smart task claims hours, and the owner's
 * lowest-price Flow cards count hours. Taking `FlowPricePeriod` and returning
 * `CombinedHourlyPrice` is the point — an hour is no longer a period, so a
 * series that has not been through here cannot be handed to an hour-shaped
 * consumer, and no consumer is handed a span it might reason about.
 */
export const toHourlyPrices = (
  periods: FlowPricePeriod[],
  timeZone: string,
): CombinedHourlyPrice[] => (
  toHourlyPeriods(periods, timeZone).map(({ startsAt, totalPrice }) => ({ startsAt, totalPrice }))
);
