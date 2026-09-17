// The price level answers "what is the price right now". On a Homey Energy zone
// that has moved to the 15-minute market, now is a quarter, and a quarter's
// price has been seen to sit a fifth of the whole day's range away from its own
// hour's average — so reading the hour would answer with the :00 quarter and
// hold that answer for 45 minutes after it stopped being true.
import { getCurrentPricePeriod, resolveCurrentPricePeriodLevel } from '../../lib/price/priceLevelUtils';
import { PriceLevel } from '../../lib/price/priceLevels';

const HOUR_START_MS = Date.parse('2026-09-15T22:00:00.000Z');

const quarters = (values: number[]) => values.map((totalPrice, index) => ({
  startsAt: new Date(HOUR_START_MS + index * 15 * 60_000).toISOString(),
  totalPrice,
  durationMinutes: 15,
}));

describe('getCurrentPricePeriod', () => {
  it('picks the quarter that covers now, not the hour it sits in', () => {
    const periods = quarters([1, 2, 3, 4]);

    const atSeventeenPast = getCurrentPricePeriod(periods, HOUR_START_MS + 17 * 60_000);

    expect(atSeventeenPast?.totalPrice).toBe(2);
  });

  it('holds a quarter until its last millisecond', () => {
    const periods = quarters([1, 2, 3, 4]);

    expect(getCurrentPricePeriod(periods, HOUR_START_MS + 15 * 60_000 - 1)?.totalPrice).toBe(1);
    expect(getCurrentPricePeriod(periods, HOUR_START_MS + 15 * 60_000)?.totalPrice).toBe(2);
  });

  it('still covers a whole hour when the source publishes hours', () => {
    const hourly = [{
      startsAt: new Date(HOUR_START_MS).toISOString(),
      totalPrice: 7,
      durationMinutes: 60,
    }];

    expect(getCurrentPricePeriod(hourly, HOUR_START_MS + 59 * 60_000)?.totalPrice).toBe(7);
    expect(getCurrentPricePeriod(hourly, HOUR_START_MS + 60 * 60_000)).toBeNull();
  });

  it('has no answer once the series runs out', () => {
    expect(getCurrentPricePeriod(quarters([1, 2, 3, 4]), HOUR_START_MS + 3_600_000)).toBeNull();
    expect(getCurrentPricePeriod([], HOUR_START_MS)).toBeNull();
  });
});

describe('resolveCurrentPricePeriodLevel', () => {
  // The day averages just under 10, so the 25% band runs 7.48 to 12.46. The
  // third quarter of the first hour is 1, well under it, while its own hour
  // averages 9.25 — dead normal. Reading the hour would never call this cheap.
  const day = [
    ...quarters([12, 12, 1, 12]),
    ...Array.from({ length: 23 }, (_, index) => ({
      startsAt: new Date(HOUR_START_MS + (index + 1) * 3_600_000).toISOString(),
      totalPrice: 10,
      durationMinutes: 60,
    })),
  ];

  const levelAt = (nowMs: number): PriceLevel => resolveCurrentPricePeriodLevel(
    day,
    { thresholdPercent: 25, minDiff: 0 },
    nowMs,
  );

  it('calls a cheap quarter cheap, and its neighbours normal', () => {
    expect(levelAt(HOUR_START_MS + 5 * 60_000)).toBe(PriceLevel.NORMAL);
    expect(levelAt(HOUR_START_MS + 35 * 60_000)).toBe(PriceLevel.CHEAP);
    expect(levelAt(HOUR_START_MS + 50 * 60_000)).toBe(PriceLevel.NORMAL);
  });

  it('weights each period by its length when averaging the day', () => {
    // One 15-minute price of 100 against 23 hours of 10. Weighted, the day
    // averages ~10.6 and the quarter is expensive. Counted per entry it would
    // average ~13.9 and the same quarter would be merely normal, because a
    // quarter would have pulled on the average as hard as a whole hour.
    const mixed = [
      { startsAt: new Date(HOUR_START_MS).toISOString(), totalPrice: 100, durationMinutes: 15 },
      ...Array.from({ length: 23 }, (_, index) => ({
        startsAt: new Date(HOUR_START_MS + (index + 1) * 3_600_000).toISOString(),
        totalPrice: 10,
        durationMinutes: 60,
      })),
    ];

    const level = resolveCurrentPricePeriodLevel(
      mixed,
      { thresholdPercent: 25, minDiff: 0 },
      HOUR_START_MS + 60_000,
    );

    expect(level).toBe(PriceLevel.EXPENSIVE);
  });

  it('is UNKNOWN when no period covers now', () => {
    expect(levelAt(HOUR_START_MS - 60_000)).toBe(PriceLevel.UNKNOWN);
  });
});
