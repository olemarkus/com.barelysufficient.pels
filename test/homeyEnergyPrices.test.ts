import {
  fetchHomeyEnergyCurrency,
  fetchHomeyEnergyPricesForDate,
  normalizeHomeyEnergyPrices,
} from '../lib/price/homeyEnergyPriceFetch';
import { buildFlowDaySlots } from '../lib/price/flowPriceUtils';
import {
  isHomeyEnergyApi,
  resolveCurrencyLabel,
  resolveHomeyEnergyApiFromHomeyApi,
  resolveHomeyEnergyApiFromSdk,
  type HomeyEnergyApi,
  type HomeyEnergyPriceInterval,
} from '../lib/utils/homeyEnergy';
import { getDateKeyInTimeZone } from '../lib/utils/dateUtils';
import type Homey from 'homey';

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

  it('calls Homey energy API with date key and resolves currency', async () => {
    const intervals = buildIntervals(localMidnightUtcMs, [2, 4], 60);
    const api: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: jest.fn().mockResolvedValue({
        priceInterval: '60',
        pricesPerInterval: intervals,
        priceUnit: 'NOK',
      }),
      getCurrency: jest.fn().mockResolvedValue({ currency: 'NOK' }),
    };

    const result = await fetchHomeyEnergyPricesForDate({ api, date, timeZone });
    const currency = await fetchHomeyEnergyCurrency(api);

    expect(api.fetchDynamicElectricityPrices).toHaveBeenCalledWith({ date: dateKey });
    expect(result.payload?.pricesByHour['0']).toBeCloseTo(2);
    expect(currency).toBe('NOK');
  });

  it('detects Homey energy API implementations', () => {
    const api: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: async () => ([]),
    };
    const homey = { api: { energy: api } } as unknown as Homey.App['homey'];

    expect(isHomeyEnergyApi(api)).toBe(true);
    expect(isHomeyEnergyApi({})).toBe(false);
    expect(resolveHomeyEnergyApiFromSdk(homey)).toBe(api);
    expect(resolveHomeyEnergyApiFromHomeyApi({ energy: api })).toBe(api);
    expect(resolveHomeyEnergyApiFromSdk({} as Homey.App['homey'])).toBeNull();
    expect(resolveHomeyEnergyApiFromHomeyApi(null)).toBeNull();
  });

  it('normalizes currency labels', () => {
    expect(resolveCurrencyLabel(' NOK ')).toBe('NOK');
    expect(resolveCurrencyLabel({ code: 'EUR' })).toBe('EUR');
    expect(resolveCurrencyLabel({ unit: '' })).toBeNull();
    expect(resolveCurrencyLabel(null)).toBeNull();
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

  it('returns null currency when api does not expose it', async () => {
    const api: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: async () => ([]),
    };
    await expect(fetchHomeyEnergyCurrency(api)).resolves.toBeNull();
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
      { startsAt: repeatedHourSlots[0].startsAt, totalPrice: 3 },
      { startsAt: repeatedHourSlots[1].startsAt, totalPrice: 4 },
    ]);
  });
});
