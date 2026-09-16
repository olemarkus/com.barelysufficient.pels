import { toHourlyPrices } from '../../lib/price/hourlyPriceProjection';
import type { FlowPricePeriod } from '../../packages/shared-domain/src/price/flowPriceUtils';

const timeZone = 'Europe/Oslo';
const localMidnightUtcMs = Date.UTC(2026, 0, 18, 23, 0, 0);

const quarters = (startUtcMs: number, values: number[]): FlowPricePeriod[] => (
  values.map((totalPrice, index) => ({
    startsAt: new Date(startUtcMs + index * 15 * 60_000).toISOString(),
    totalPrice,
    durationMinutes: 15,
  }))
);

describe('toHourlyPrices', () => {
  it('averages an hour of quarters into the hour an hourly source would have published', () => {
    const result = toHourlyPrices(quarters(localMidnightUtcMs, [1, 3, 5, 7]), timeZone);

    expect(result).toEqual([{
      startsAt: new Date(localMidnightUtcMs).toISOString(),
      totalPrice: 4,
    }]);
  });

  it('leaves an already-hourly series at its own prices', () => {
    const hourly: FlowPricePeriod[] = [
      { startsAt: new Date(localMidnightUtcMs).toISOString(), totalPrice: 1.5, durationMinutes: 60 },
      { startsAt: new Date(localMidnightUtcMs + 3_600_000).toISOString(), totalPrice: 2.5, durationMinutes: 60 },
    ];

    expect(toHourlyPrices(hourly, timeZone)).toEqual([
      { startsAt: hourly[0].startsAt, totalPrice: 1.5 },
      { startsAt: hourly[1].startsAt, totalPrice: 2.5 },
    ]);
  });

  it('weights an unevenly covered hour by how long each period lasts', () => {
    const uneven: FlowPricePeriod[] = [
      { startsAt: new Date(localMidnightUtcMs).toISOString(), totalPrice: 1, durationMinutes: 45 },
      { startsAt: new Date(localMidnightUtcMs + 45 * 60_000).toISOString(), totalPrice: 5, durationMinutes: 15 },
    ];

    // Duration-weighted: (1*45 + 5*15) / 60 = 2. A plain mean would say 3, which
    // would price three quarters of the hour at the last quarter's rate.
    expect(toHourlyPrices(uneven, timeZone)[0]?.totalPrice).toBe(2);
  });

  it('keeps a partially priced hour at the average of what it has', () => {
    const result = toHourlyPrices(quarters(localMidnightUtcMs, [2, 4]), timeZone);

    expect(result).toHaveLength(1);
    expect(result[0]?.totalPrice).toBe(3);
  });

  it('gives the repeated fall-back clock hour two separate hours', () => {
    // 2026-10-25 in Oslo: 02:00-03:00 happens twice (UTC 00:00 and 01:00).
    const firstTwoUtcMs = Date.UTC(2026, 9, 25, 0, 0, 0);
    const periods = [
      ...quarters(firstTwoUtcMs, [1, 1, 1, 1]),
      ...quarters(firstTwoUtcMs + 3_600_000, [9, 9, 9, 9]),
    ];

    const result = toHourlyPrices(periods, timeZone);

    expect(result).toEqual([
      { startsAt: new Date(firstTwoUtcMs).toISOString(), totalPrice: 1 },
      { startsAt: new Date(firstTwoUtcMs + 3_600_000).toISOString(), totalPrice: 9 },
    ]);
  });

  it('drops a period whose instant does not parse rather than pricing an hour from it', () => {
    const periods: FlowPricePeriod[] = [
      { startsAt: 'not-a-time', totalPrice: 99, durationMinutes: 15 },
      ...quarters(localMidnightUtcMs, [2, 2, 2, 2]),
    ];

    expect(toHourlyPrices(periods, timeZone)).toEqual([{
      startsAt: new Date(localMidnightUtcMs).toISOString(),
      totalPrice: 2,
    }]);
  });

  it('has no hour to report for an empty series', () => {
    expect(toHourlyPrices([], timeZone)).toEqual([]);
  });
});
