import { getHourStartInTimeZone } from '../utils/dateUtils';
import type { CombinedHourlyPrice } from './priceTypes';
import type { FlowPricePeriod } from '../../packages/shared-domain/src/price/flowPriceUtils';

const HOUR_MINUTES = 60;

/**
 * A published period, which may already carry a feed-in price.
 *
 * Only one producer attaches one this early: the Homey scheme, when the owner
 * has pointed the export price at Homey's own terms, because that is where a
 * period's raw spot and its resolved import price both exist
 * (`lib/price/homeyExportPrice.ts`). PELS's own export model decorates the
 * series later instead, and leaves this absent.
 */
export type ExportablePricePeriod = FlowPricePeriod & { exportPrice?: number };

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
  periods: ExportablePricePeriod[],
  timeZone: string,
): ExportablePricePeriod[] => {
  const buckets = new Map<number, {
    weighted: number;
    minutes: number;
    exportWeighted: number;
    exportMinutes: number;
  }>();
  for (const period of periods) {
    const startMs = Date.parse(period.startsAt);
    if (!Number.isFinite(startMs)) continue;
    const hourStartMs = getHourStartInTimeZone(new Date(startMs), timeZone);
    const current = buckets.get(hourStartMs)
      ?? { weighted: 0, minutes: 0, exportWeighted: 0, exportMinutes: 0 };
    const hasExport = typeof period.exportPrice === 'number';
    buckets.set(hourStartMs, {
      weighted: current.weighted + period.totalPrice * period.durationMinutes,
      minutes: current.minutes + period.durationMinutes,
      exportWeighted: current.exportWeighted
        + (hasExport ? (period.exportPrice as number) * period.durationMinutes : 0),
      exportMinutes: current.exportMinutes + (hasExport ? period.durationMinutes : 0),
    });
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.minutes > 0)
    .sort(([left], [right]) => left - right)
    .map(([hourStartMs, bucket]) => ({
      startsAt: new Date(hourStartMs).toISOString(),
      totalPrice: bucket.weighted / bucket.minutes,
      durationMinutes: HOUR_MINUTES,
      // An export price carried by the periods averages the same way the
      // import price does — the hour is worth what its periods were worth.
      // Only when EVERY period in the hour carried one: a half-priced hour has
      // no honest export price, and averaging the priced half would overstate
      // what the owner is paid for the whole hour.
      ...(bucket.exportMinutes === bucket.minutes && bucket.exportMinutes > 0
        ? { exportPrice: bucket.exportWeighted / bucket.minutes }
        : {}),
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
  periods: ExportablePricePeriod[],
  timeZone: string,
): CombinedHourlyPrice[] => (
  toHourlyPeriods(periods, timeZone).map(({ startsAt, totalPrice, exportPrice }) => ({
    startsAt,
    totalPrice,
    ...(typeof exportPrice === 'number' ? { exportPrice } : {}),
  }))
);
