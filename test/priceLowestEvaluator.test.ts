import { evaluateLowestPriceCard } from '../lib/price/priceLowestFlowEvaluator';

type PriceEntry = { startsAt: string; totalPrice: number };

const buildUtcDay = (dateKey: string, values: number[]): PriceEntry[] => {
  const [year, month, day] = dateKey.split('-').map((part) => Number(part));
  return values.map((price, hour) => ({
    startsAt: new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0)).toISOString(),
    totalPrice: price,
  }));
};

const buildFlatDay = (value: number): number[] => Array.from({ length: 24 }, () => value);

const buildUtcRange = (startIso: string, values: number[]): PriceEntry[] => {
  const startMs = Date.parse(startIso);
  return values.map((price, index) => ({
    startsAt: new Date(startMs + index * 60 * 60 * 1000).toISOString(),
    totalPrice: price,
  }));
};

const buildUtcDayWithMinuteOffset = (dateKey: string, values: number[], minuteOffset: number): PriceEntry[] => {
  const [year, month, day] = dateKey.split('-').map((part) => Number(part));
  return values.map((price, hour) => ({
    startsAt: new Date(Date.UTC(year, month - 1, day, hour, minuteOffset, 0, 0)).toISOString(),
    totalPrice: price,
  }));
};

describe('priceLowestFlowEvaluator', () => {
  const timeZone = 'UTC';

  it('includes ties at the cutoff for lowest-today ranking', () => {
    const values = buildFlatDay(80);
    values[5] = 10;
    values[10] = 10;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_today',
      args: { number: 1 },
      combinedPrices: buildUtcDay('2026-03-03', values),
      timeZone,
      now: new Date('2026-03-03T10:15:00.000Z'),
    });

    expect(result.matches).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('matches when current price is in the lowest window before a time', () => {
    const values = buildFlatDay(90);
    values[4] = 40;
    values[5] = 12;
    values[6] = 30;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_before',
      args: { period: 3, number: 1, time: 7 },
      combinedPrices: buildUtcDay('2026-03-03', values),
      timeZone,
      now: new Date('2026-03-03T05:05:00.000Z'),
    });

    expect(result.matches).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('returns false when current hour is outside the before-window', () => {
    const values = buildFlatDay(90);
    values[4] = 40;
    values[5] = 12;
    values[6] = 30;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_before',
      args: { period: 3, number: 1, time: 7 },
      combinedPrices: buildUtcDay('2026-03-03', values),
      timeZone,
      now: new Date('2026-03-03T08:10:00.000Z'),
    });

    expect(result.matches).toBe(false);
    expect(result.reason).toBe('outside_window');
  });

  it('supports wrap behavior across midnight for before-window checks', () => {
    const todayValues = buildFlatDay(70);
    todayValues[23] = 5;
    const tomorrowValues = buildFlatDay(70);
    tomorrowValues[0] = 30;
    tomorrowValues[1] = 20;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_before',
      args: { period: 3, number: 1, time: 2 },
      combinedPrices: [
        ...buildUtcDay('2026-03-03', todayValues),
        ...buildUtcDay('2026-03-04', tomorrowValues),
      ],
      timeZone,
      now: new Date('2026-03-03T23:20:00.000Z'),
    });

    expect(result.matches).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('returns false when day data is missing for current-slot evaluation', () => {
    const values = buildFlatDay(50);
    const entries = values
      .map((price, hour) => ({
        startsAt: new Date(Date.UTC(2026, 2, 3, hour, 0, 0, 0)).toISOString(),
        totalPrice: price,
        hour,
      }))
      .filter((entry) => entry.hour !== 10)
      .map(({ startsAt, totalPrice }) => ({ startsAt, totalPrice }));

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_today',
      args: { number: 3 },
      combinedPrices: entries,
      timeZone,
      now: new Date('2026-03-03T10:00:00.000Z'),
    });

    expect(result.matches).toBe(false);
    expect(['missing_current_slot', 'incomplete_day_slots']).toContain(result.reason);
  });

  it('returns missing_current_slot when all current-hour slots start in the future', () => {
    const values = buildFlatDay(70);
    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_today',
      args: { number: 3 },
      combinedPrices: buildUtcDayWithMinuteOffset('2026-03-03', values, 30),
      timeZone,
      now: new Date('2026-03-03T10:05:00.000Z'),
    });
    expect(result.matches).toBe(false);
    expect(result.reason).toBe('missing_current_slot');
  });

  it('uses the active duplicate local hour slot on fallback days for lowest-today', () => {
    const fallbackDayValues = Array.from({ length: 25 }, () => 120);
    fallbackDayValues[2] = 1;
    fallbackDayValues[3] = 80;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_today',
      args: { number: 1 },
      combinedPrices: buildUtcRange('2026-10-24T22:00:00.000Z', fallbackDayValues),
      timeZone: 'Europe/Oslo',
      now: new Date('2026-10-25T01:30:00.000Z'),
    });

    expect(result.reason).toBe('ok');
    expect(result.candidateCount).toBe(25);
    expect(result.currentPrice).toBe(80);
    expect(result.matches).toBe(false);
  });

  it('uses the active duplicate local hour slot in before-window evaluation on fallback days', () => {
    const fallbackDayValues = Array.from({ length: 25 }, () => 120);
    fallbackDayValues[2] = 1;
    fallbackDayValues[3] = 110;
    fallbackDayValues[4] = 90;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_before',
      args: { period: 2, number: 1, time: 4 },
      combinedPrices: buildUtcRange('2026-10-24T22:00:00.000Z', fallbackDayValues),
      timeZone: 'Europe/Oslo',
      now: new Date('2026-10-25T01:30:00.000Z'),
    });

    expect(result.reason).toBe('ok');
    expect(result.candidateCount).toBe(2);
    expect(result.currentPrice).toBe(110);
    expect(result.matches).toBe(false);
  });

  it('returns invalid_args when before-window period is outside flow-card bounds', () => {
    const values = buildFlatDay(70);

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_before',
      args: { period: 1, number: 1, time: 7 },
      combinedPrices: buildUtcDay('2026-03-03', values),
      timeZone,
      now: new Date('2026-03-03T05:00:00.000Z'),
    });

    expect(result.matches).toBe(false);
    expect(result.reason).toBe('invalid_args');
  });

  it('uses epsilon when current price is near the cutoff', () => {
    const values = buildFlatDay(80);
    values[3] = 10;
    values[7] = 20;
    values[10] = 20.0000005;

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_today',
      args: { number: 2 },
      combinedPrices: buildUtcDay('2026-03-03', values),
      timeZone,
      now: new Date('2026-03-03T10:30:00.000Z'),
      epsilon: 0.000001,
    });

    expect(result.matches).toBe(true);
    expect(result.cutoff).toBe(20);
  });

  it('returns invalid_args when number exceeds flow-card bounds', () => {
    const values = buildFlatDay(70);

    const result = evaluateLowestPriceCard({
      cardId: 'price_lowest_today',
      args: { number: 25 },
      combinedPrices: buildUtcDay('2026-03-03', values),
      timeZone,
      now: new Date('2026-03-03T10:00:00.000Z'),
    });

    expect(result.matches).toBe(false);
    expect(result.reason).toBe('invalid_args');
  });
});
