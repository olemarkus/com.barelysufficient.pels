import {
  createHomeyEnergyWebApi,
  fetchHomeyEnergyPricesForDate,
  normalizeHomeyEnergyPrices,
} from '../../lib/price/homeyEnergyPriceFetch';
import { buildFlowDaySlots } from '../../packages/shared-domain/src/price/flowPriceUtils';
import {
  type HomeyEnergyApi,
  type HomeyEnergyPriceInterval,
} from '../../lib/utils/homeyEnergy';
import { getDateKeyInTimeZone } from '../../lib/utils/dateUtils';

const buildIntervals = (startUtcMs: number, values: number[], intervalMinutes: number): HomeyEnergyPriceInterval[] => (
  values.map((value, index) => {
    const periodStart = new Date(startUtcMs + index * intervalMinutes * 60 * 1000).toISOString();
    const periodEnd = new Date(startUtcMs + (index + 1) * intervalMinutes * 60 * 1000).toISOString();
    return { periodStart, periodEnd, value };
  })
);

describe('Homey energy price fetch', () => {
  const timeZone = 'Europe/Oslo';
  const date = new Date(Date.UTC(2026, 0, 19, 12, 0, 0));
  const dateKey = getDateKeyInTimeZone(date, timeZone);
  const localMidnightUtcMs = Date.UTC(2026, 0, 18, 23, 0, 0);

  it('normalizes 15-minute intervals to hourly averages', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [1, 3, 5, 7, 10, 14, 18, 22], 15);
    const response = {
      priceInterval: '15',
      pricesPerInterval: intervals,
      priceUnit: 'NOK',
    };
    const result = normalizeHomeyEnergyPrices({ response, date, timeZone });

    expect(result.payload?.dateKey).toBe(dateKey);
    expect(result.payload?.pricesByHour['0']).toBeCloseTo(4);
    expect(result.payload?.pricesByHour['1']).toBeCloseTo(16);
    expect(result.intervalMinutes).toBe(15);
    expect(result.priceUnit).toBe('NOK');
  });

  it('keeps each 15-minute period, at its own length', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [1, 3, 5, 7], 15);
    const result = normalizeHomeyEnergyPrices({
      response: { priceInterval: '15', pricesPerInterval: intervals, priceUnit: 'NOK' },
      date,
      timeZone,
    });

    expect(result.payload?.pricesByPeriod).toEqual([
      { startsAt: new Date(localMidnightUtcMs).toISOString(), totalPrice: 1, durationMinutes: 15 },
      { startsAt: new Date(localMidnightUtcMs + 15 * 60_000).toISOString(), totalPrice: 3, durationMinutes: 15 },
      { startsAt: new Date(localMidnightUtcMs + 30 * 60_000).toISOString(), totalPrice: 5, durationMinutes: 15 },
      { startsAt: new Date(localMidnightUtcMs + 45 * 60_000).toISOString(), totalPrice: 7, durationMinutes: 15 },
    ]);
  });

  // An older app build reinstalled over a payload written here reads
  // `pricesBySlot`, which has always meant one entry per local hour.
  it('keeps the hourly series an older build would read', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [1, 3, 5, 7], 15);
    const result = normalizeHomeyEnergyPrices({
      response: { priceInterval: '15', pricesPerInterval: intervals, priceUnit: 'NOK' },
      date,
      timeZone,
    });

    expect(result.payload?.pricesBySlot).toEqual([
      { startsAt: new Date(localMidnightUtcMs).toISOString(), totalPrice: 4, durationMinutes: 60 },
    ]);
  });

  it('writes no separate period series for an hourly zone', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [0.5, 1.5], 60);
    const result = normalizeHomeyEnergyPrices({
      response: { interval: 60, pricesPerInterval: intervals, priceUnit: 'NOK' },
      date,
      timeZone,
    });

    expect(result.payload?.pricesByPeriod).toBeUndefined();
    expect(result.payload?.pricesBySlot).toHaveLength(2);
  });

  // Homey Energy lists every quarter twice at the 15-minute interval — 192
  // entries for one day, 96 distinct starts (verified against a live zone
  // 2026-09-15). A repeat is the same period, not a second one.
  it('drops the duplicate listing of each 15-minute period', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [1, 3, 5, 7], 15);
    const doubled = intervals.flatMap((interval) => [interval, { ...interval }]);
    const result = normalizeHomeyEnergyPrices({
      response: { priceInterval: '15', pricesPerInterval: doubled, priceUnit: 'NOK' },
      date,
      timeZone,
    });

    expect(result.payload?.pricesByPeriod).toHaveLength(4);
    // The hour average is unchanged by the repeats — as it was when every
    // quarter was averaged away at the fetch.
    expect(result.payload?.pricesByHour['0']).toBeCloseTo(4);
  });

  it('falls back to the document interval when a period carries no end', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [1, 3], 15)
      .map(({ periodStart, value }) => ({ periodStart, value }));
    const result = normalizeHomeyEnergyPrices({
      response: { interval: 15, pricesPerInterval: intervals, priceUnit: 'NOK' },
      date,
      timeZone,
    });

    expect(result.payload?.pricesByPeriod?.map((entry) => entry.durationMinutes)).toEqual([15, 15]);
  });

  it('treats a period as an hour when neither it nor the document says otherwise', () => {
    const result = normalizeHomeyEnergyPrices({
      response: {
        pricesPerInterval: [{ periodStart: new Date(localMidnightUtcMs).toISOString(), value: 2 }],
        priceUnit: 'NOK',
      },
      date,
      timeZone,
    });

    expect(result.payload?.pricesByPeriod).toBeUndefined();
    expect(result.payload?.pricesBySlot).toEqual([
      { startsAt: new Date(localMidnightUtcMs).toISOString(), totalPrice: 2, durationMinutes: 60 },
    ]);
  });

  it('keeps hourly values when intervals are 60 minutes', () => {
    const intervals = buildIntervals(localMidnightUtcMs, [0.5, 1.5], 60);
    const response = {
      interval: 60,
      pricesPerInterval: intervals,
      priceUnit: 'EUR',
    };
    const result = normalizeHomeyEnergyPrices({ response, date, timeZone });

    expect(result.payload?.pricesByHour['0']).toBeCloseTo(0.5);
    expect(result.payload?.pricesByHour['1']).toBeCloseTo(1.5);
    expect(result.intervalMinutes).toBe(60);
    expect(result.priceUnit).toBe('EUR');
  });

  it('calls Homey energy API with the date key', async () => {
    const intervals = buildIntervals(localMidnightUtcMs, [2, 4], 60);
    const api: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockResolvedValue({
        priceInterval: '60',
        pricesPerInterval: intervals,
        priceUnit: 'NOK',
      }),
    };

    const result = await fetchHomeyEnergyPricesForDate({ api, date, timeZone });

    expect(api.fetchDynamicElectricityPrices).toHaveBeenCalledWith({ date: dateKey });
    expect(result.payload?.pricesByHour['0']).toBeCloseTo(2);
    expect(result.priceUnit).toBe('NOK');
  });

  it('reads day-ahead prices from the Web API route for the requested date', async () => {
    const get = vi.fn().mockResolvedValue({ priceInterval: '60', pricesPerInterval: [], priceUnit: 'EUR' });

    await expect(createHomeyEnergyWebApi(get).fetchDynamicElectricityPrices({ date: dateKey }))
      .resolves.toEqual({ priceInterval: '60', pricesPerInterval: [], priceUnit: 'EUR' });
    expect(get).toHaveBeenCalledWith(`manager/energy/price/electricity/dynamic?date=${dateKey}`);
  });

  it('handles empty or mismatched price data', () => {
    const intervals = buildIntervals(localMidnightUtcMs - 60 * 60 * 1000, [5], 60);
    const response = {
      interval: 60,
      pricesPerInterval: intervals,
      priceUnit: 'NOK',
    };
    const result = normalizeHomeyEnergyPrices({ response, date, timeZone });

    expect(result.payload).toBeNull();
    expect(result.intervalMinutes).toBe(60);
  });

  it('returns null payload for empty responses', () => {
    const result = normalizeHomeyEnergyPrices({ response: [], date, timeZone });

    expect(result.payload).toBeNull();
    expect(result.intervalMinutes).toBeNull();
    expect(result.priceUnit).toBeNull();
  });

  it('accepts array responses and skips invalid interval values', () => {
    const intervals = [
      { periodStart: new Date(localMidnightUtcMs).toISOString(), value: 1 },
      { periodStart: 'invalid', value: 2 },
      { periodStart: new Date(localMidnightUtcMs + 60 * 60 * 1000).toISOString(), value: '' },
    ];
    const response = [{
      priceInterval: '60',
      pricesPerInterval: intervals,
      priceUnit: 'NOK',
    }];

    const result = normalizeHomeyEnergyPrices({ response, date, timeZone });
    expect(result.priceUnit).toBe('NOK');
    expect(result.payload?.pricesByHour['0']).toBe(1);
    expect(result.payload?.pricesByHour['1']).toBeUndefined();
  });

  it('preserves 23 exact slots on spring-forward days', () => {
    const springDate = new Date(Date.UTC(2026, 2, 29, 12, 0, 0));
    const springDateKey = getDateKeyInTimeZone(springDate, timeZone);
    const springSlots = buildFlowDaySlots(springDateKey, timeZone);
    const response = {
      interval: 60,
      pricesPerInterval: springSlots.map((slot, index) => ({
        periodStart: slot.startsAt,
        periodEnd: new Date(Date.parse(slot.startsAt) + 60 * 60 * 1000).toISOString(),
        value: index + 1,
      })),
      priceUnit: 'NOK',
    };

    const result = normalizeHomeyEnergyPrices({ response, date: springDate, timeZone });

    expect(springSlots).toHaveLength(23);
    expect(result.payload?.pricesBySlot).toHaveLength(23);
    expect(result.payload?.pricesByHour['2']).toBeUndefined();
    expect(result.payload?.pricesByHour['3']).toBe(3);
  });

  it('preserves both repeated fall-back slots distinctly', () => {
    const fallDate = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));
    const fallDateKey = getDateKeyInTimeZone(fallDate, timeZone);
    const fallSlots = buildFlowDaySlots(fallDateKey, timeZone);
    const repeatedHourSlots = fallSlots.filter((slot) => slot.hour === 2);
    const response = {
      interval: 60,
      pricesPerInterval: fallSlots.map((slot, index) => ({
        periodStart: slot.startsAt,
        periodEnd: new Date(Date.parse(slot.startsAt) + 60 * 60 * 1000).toISOString(),
        value: index + 1,
      })),
      priceUnit: 'NOK',
    };

    const result = normalizeHomeyEnergyPrices({ response, date: fallDate, timeZone });
    const repeatedEntries = result.payload?.pricesBySlot?.filter(
      (entry) => repeatedHourSlots.some((slot) => slot.startsAt === entry.startsAt),
    );

    expect(fallSlots).toHaveLength(25);
    expect(repeatedHourSlots).toHaveLength(2);
    expect(result.payload?.pricesBySlot).toHaveLength(25);
    expect(repeatedEntries).toEqual([
      { startsAt: repeatedHourSlots[0].startsAt, totalPrice: 3, durationMinutes: 60 },
      { startsAt: repeatedHourSlots[1].startsAt, totalPrice: 4, durationMinutes: 60 },
    ]);
  });
});
