import {
  buildFlowDaySlots,
  buildFlowEntries,
  getExpectedFlowHours,
  getFlowPricePayload,
  getMissingFlowHours,
  parseFlowPricePayloadInput,
} from '../lib/price/flowPriceUtils';

const hasMatchingSlotStart = (startsAt: string, slots: Array<{ startsAt: string }>): boolean => (
  slots.some((slot) => slot.startsAt === startsAt)
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
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2025-01-02T03:04:05.000Z'));
      const payload = getFlowPricePayload({ dateKey: '2025-01-02', pricesByHour: { '0': 1 } });

      expect(payload?.updatedAt).toBe(new Date('2025-01-02T03:04:05.000Z').toISOString());
      expect(getMissingFlowHours(payload?.pricesByHour ?? {})).toContain(1);
      expect(getMissingFlowHours(payload?.pricesByHour ?? {})).not.toContain(0);
    } finally {
      jest.useRealTimers();
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
      { startsAt: repeatedHourSlots[0].startsAt, totalPrice: 3 },
      { startsAt: repeatedHourSlots[1].startsAt, totalPrice: 4 },
    ]);
  });
});
