import {
  buildFlowDaySlots,
  buildFlowEntries,
  getExpectedFlowHours,
  getFlowPricePayload,
  getMissingFlowHours,
  parseFlowPricePayloadInput,
} from '../../packages/shared-domain/src/price/flowPriceUtils';

const hasMatchingSlotStart = (startsAt: string, slots: Array<{ startsAt: string }>): boolean => (
  slots.some((slot) => slot.startsAt === startsAt)
);

const quarterPeriods = (hourStartMs: number, prices: number[]) => (
  prices.map((totalPrice, index) => ({
    startsAt: new Date(hourStartMs + index * 15 * 60_000).toISOString(),
    totalPrice,
    durationMinutes: 15,
  }))
);

describe('flowPriceUtils', () => {
  it('parses array inputs and filters invalid entries', () => {
    const result = parseFlowPricePayloadInput([0.1, '0.2', '', undefined, 0], {
      dateKey: '2025-01-02',
      timeZone: 'UTC',
    });

    expect(result.pricesByHour).toEqual({
      '0': 0.1,
      '1': 0.2,
      '4': 0,
    });
  });

  it('parses single-quote JSON with trailing comma', () => {
    const result = parseFlowPricePayloadInput("{'0':0.3,'1':'0.4',}", {
      dateKey: '2025-01-02',
      timeZone: 'UTC',
    });

    expect(result.pricesByHour).toEqual({
      '0': 0.3,
      '1': 0.4,
    });
  });

  it('parses standard JSON strings', () => {
    const result = parseFlowPricePayloadInput('{"2":0.5}', {
      dateKey: '2025-01-02',
      timeZone: 'UTC',
    });

    expect(result.pricesByHour).toEqual({
      '2': 0.5,
    });
  });

  it('throws on empty or invalid input', () => {
    expect(() => parseFlowPricePayloadInput('   ', {
      dateKey: '2025-01-02',
      timeZone: 'UTC',
    })).toThrow('Price data is empty.');
    expect(() => parseFlowPricePayloadInput(123, {
      dateKey: '2025-01-02',
      timeZone: 'UTC',
    })).toThrow('No valid hourly prices found in price data.');
  });

  it('builds payload defaults and missing hours', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-02T03:04:05.000Z'));
      const payload = getFlowPricePayload({ dateKey: '2025-01-02', pricesByHour: { '0': 1 } });

      expect(payload?.updatedAt).toBe(new Date('2025-01-02T03:04:05.000Z').toISOString());
      expect(getMissingFlowHours(payload?.pricesByHour ?? {})).toContain(1);
      expect(getMissingFlowHours(payload?.pricesByHour ?? {})).not.toContain(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps spring-forward arrays to exact local slots', () => {
    const timeZone = 'Europe/Oslo';
    const dateKey = '2024-03-31';
    const parsed = parseFlowPricePayloadInput(
      Array.from({ length: 23 }, (_, index) => index + 1),
      { dateKey, timeZone },
    );

    expect(parsed.pricesBySlot).toHaveLength(23);
    expect(parsed.pricesByHour['0']).toBe(1);
    expect(parsed.pricesByHour['1']).toBe(2);
    expect(parsed.pricesByHour['2']).toBeUndefined();
    expect(parsed.pricesByHour['3']).toBe(3);
    expect(getMissingFlowHours(parsed.pricesByHour, getExpectedFlowHours(dateKey, timeZone))).toHaveLength(0);

    const payload = {
      dateKey,
      pricesByHour: parsed.pricesByHour,
      pricesBySlot: parsed.pricesBySlot,
      updatedAt: new Date('2024-03-31T00:00:00.000Z').toISOString(),
    };
    expect(buildFlowEntries(payload, timeZone)).toHaveLength(23);
  });

  it('preserves both repeated fall-back slots from 25-value arrays', () => {
    const timeZone = 'Europe/Oslo';
    const dateKey = '2024-10-27';
    const daySlots = buildFlowDaySlots(dateKey, timeZone);
    const repeatedHourSlots = daySlots.filter((slot) => slot.hour === 2);
    const parsed = parseFlowPricePayloadInput(
      Array.from({ length: daySlots.length }, (_, index) => index + 1),
      { dateKey, timeZone },
    );

    expect(daySlots).toHaveLength(25);
    expect(repeatedHourSlots).toHaveLength(2);
    expect(parsed.pricesBySlot).toHaveLength(25);

    const payload = {
      dateKey,
      pricesByHour: parsed.pricesByHour,
      pricesBySlot: parsed.pricesBySlot,
      updatedAt: new Date('2024-10-27T00:00:00.000Z').toISOString(),
    };
    const entries = buildFlowEntries(payload, timeZone);
    const repeatedEntries = entries.filter((entry) => hasMatchingSlotStart(entry.startsAt, repeatedHourSlots));

    expect(repeatedEntries).toEqual([
      { startsAt: repeatedHourSlots[0].startsAt, totalPrice: 3, durationMinutes: 60 },
      { startsAt: repeatedHourSlots[1].startsAt, totalPrice: 4, durationMinutes: 60 },
    ]);
  });

  it('reads a payload stored before periods carried a duration as hourly', () => {
    const payload = getFlowPricePayload({
      dateKey: '2026-01-19',
      pricesByHour: { '0': 1 },
      pricesBySlot: [{ startsAt: '2026-01-18T23:00:00.000Z', totalPrice: 1 }],
      updatedAt: '2026-01-18T22:00:00.000Z',
    });

    expect(payload?.pricesBySlot).toEqual([
      { startsAt: '2026-01-18T23:00:00.000Z', totalPrice: 1, durationMinutes: 60 },
    ]);
  });

  it('carries quarter-hour periods through at their own length', () => {
    const timeZone = 'Europe/Oslo';
    const hourStartMs = Date.parse('2026-01-18T23:00:00.000Z');
    const payload = {
      dateKey: '2026-01-19',
      pricesByHour: { '0': 4 },
      pricesBySlot: [{ startsAt: new Date(hourStartMs).toISOString(), totalPrice: 4, durationMinutes: 60 }],
      pricesByPeriod: quarterPeriods(hourStartMs, [1, 3, 5, 7]),
      updatedAt: '2026-01-18T22:00:00.000Z',
    };

    const entries = buildFlowEntries(payload, timeZone);

    // Four periods for hour 0, not the hourly series that sits beside them.
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.totalPrice)).toEqual([1, 3, 5, 7]);
    expect(entries.every((entry) => entry.durationMinutes === 15)).toBe(true);
  });

  it('prices an hour no period covers from the hourly map', () => {
    const timeZone = 'Europe/Oslo';
    const hourStartMs = Date.parse('2026-01-18T23:00:00.000Z');
    const payload = {
      dateKey: '2026-01-19',
      pricesByHour: { '0': 4, '1': 9 },
      pricesByPeriod: quarterPeriods(hourStartMs, [1, 3, 5, 7]),
      updatedAt: '2026-01-18T22:00:00.000Z',
    };

    const entries = buildFlowEntries(payload, timeZone);
    const hourOne = entries.filter((entry) => entry.startsAt === new Date(hourStartMs + 3_600_000).toISOString());

    expect(hourOne).toEqual([{
      startsAt: new Date(hourStartMs + 3_600_000).toISOString(),
      totalPrice: 9,
      durationMinutes: 60,
    }]);
  });

  it('leaves a period outside the payload day to the day that owns it', () => {
    const timeZone = 'Europe/Oslo';
    const hourStartMs = Date.parse('2026-01-18T23:00:00.000Z');
    const payload = {
      dateKey: '2026-01-19',
      pricesByHour: {},
      // The last belongs to the next local day, one hour past its end.
      pricesByPeriod: [
        ...quarterPeriods(hourStartMs, [1, 3, 5, 7]),
        { startsAt: new Date(hourStartMs + 25 * 3_600_000).toISOString(), totalPrice: 99, durationMinutes: 15 },
      ],
      updatedAt: '2026-01-18T22:00:00.000Z',
    };

    const entries = buildFlowEntries(payload, timeZone);

    expect(entries.map((entry) => entry.totalPrice)).toEqual([1, 3, 5, 7]);
  });

  it('drops a period whose stored duration is unusable, and keeps one with none', () => {
    const payload = getFlowPricePayload({
      dateKey: '2026-01-19',
      pricesByHour: { '0': 1 },
      pricesBySlot: [
        { startsAt: '2026-01-18T23:00:00.000Z', totalPrice: 1 },
        { startsAt: '2026-01-18T23:15:00.000Z', totalPrice: 2, durationMinutes: 0 },
        { startsAt: '2026-01-18T23:30:00.000Z', totalPrice: 3, durationMinutes: 'soon' },
      ],
      updatedAt: '2026-01-18T22:00:00.000Z',
    });

    expect(payload?.pricesBySlot).toEqual([
      { startsAt: '2026-01-18T23:00:00.000Z', totalPrice: 1, durationMinutes: 60 },
    ]);
  });
});
