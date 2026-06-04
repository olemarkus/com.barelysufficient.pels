import {
  buildCombinedHourlyPricesFromPayloads,
  purgeStaleFlowPriceSlots,
  storeFlowPriceData,
} from '../../lib/price/priceServiceFlowHelpers';

describe('priceServiceFlowHelpers DST date keys', () => {
  it('keeps tomorrow payload on the spring-forward eve boundary', () => {
    const logDebug = vi.fn();
    const result = buildCombinedHourlyPricesFromPayloads({
      now: new Date('2024-03-30T22:30:00.000Z'),
      timeZone: 'Europe/Oslo',
      todayPayload: {
        dateKey: '2024-03-30',
        pricesByHour: { '23': 1 },
        updatedAt: new Date('2024-03-30T20:00:00.000Z').toISOString(),
      },
      tomorrowPayload: {
        dateKey: '2024-03-31',
        pricesByHour: { '0': 2, '1': 3, '3': 4 },
        updatedAt: new Date('2024-03-30T20:00:00.000Z').toISOString(),
      },
      logDebug,
      label: 'Flow prices',
    });

    expect(result.some((entry) => entry.totalPrice === 4)).toBe(true);
    expect(logDebug).not.toHaveBeenCalledWith(
      expect.stringContaining('Ignoring stored tomorrow data'),
      expect.anything(),
    );
  });

  it('stores tomorrow under the next local date on spring-forward eve', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2024-03-30T22:30:00.000Z'));
      const setSetting = vi.fn();
      const updateCombinedPrices = vi.fn();

      const result = storeFlowPriceData({
        kind: 'tomorrow',
        raw: [1, 2, 4],
        timeZone: 'Europe/Oslo',
        logDebug: vi.fn(),
        setSetting,
        updateCombinedPrices,
      });

      expect(result.dateKey).toBe('2024-03-31');
      expect(setSetting).toHaveBeenCalledWith(
        'flow_prices_tomorrow',
        expect.objectContaining({ dateKey: '2024-03-31' }),
      );
      expect(updateCombinedPrices).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('purgeStaleFlowPriceSlots', () => {
  const now = new Date('2026-05-11T10:00:00.000Z');
  const timeZone = 'Europe/Oslo';
  const todayKey = '2026-05-11';
  const tomorrowKey = '2026-05-12';

  it('returns no changes when both slots match expected keys', () => {
    const result = purgeStaleFlowPriceSlots({
      now,
      timeZone,
      todayPayload: { dateKey: todayKey, pricesByHour: { '0': 1 }, updatedAt: now.toISOString() },
      tomorrowPayload: { dateKey: tomorrowKey, pricesByHour: { '0': 2 }, updatedAt: now.toISOString() },
    });
    expect(result.changes).toEqual([]);
    expect(result.todayPayload?.dateKey).toBe(todayKey);
    expect(result.tomorrowPayload?.dateKey).toBe(tomorrowKey);
  });

  it('promotes a stale tomorrow payload dated today when today slot is empty', () => {
    const stalePayload = { dateKey: todayKey, pricesByHour: { '0': 5 }, updatedAt: now.toISOString() };
    const result = purgeStaleFlowPriceSlots({
      now,
      timeZone,
      todayPayload: null,
      tomorrowPayload: stalePayload,
    });
    expect(result.todayPayload).toBe(stalePayload);
    expect(result.tomorrowPayload).toBeNull();
    expect(result.changes).toEqual([
      { slot: 'tomorrow', action: 'promoted_to_today', from: todayKey },
    ]);
  });

  it('clears a stale tomorrow payload dated before tomorrow', () => {
    const result = purgeStaleFlowPriceSlots({
      now,
      timeZone,
      todayPayload: { dateKey: todayKey, pricesByHour: { '0': 1 }, updatedAt: now.toISOString() },
      tomorrowPayload: { dateKey: todayKey, pricesByHour: { '0': 2 }, updatedAt: now.toISOString() },
    });
    expect(result.tomorrowPayload).toBeNull();
    expect(result.changes).toEqual([
      { slot: 'tomorrow', action: 'cleared', from: todayKey },
    ]);
  });

  it('clears a stale today payload dated before today', () => {
    const yesterday = '2026-05-10';
    const result = purgeStaleFlowPriceSlots({
      now,
      timeZone,
      todayPayload: { dateKey: yesterday, pricesByHour: { '0': 1 }, updatedAt: now.toISOString() },
      tomorrowPayload: null,
    });
    expect(result.todayPayload).toBeNull();
    expect(result.changes).toEqual([
      { slot: 'today', action: 'cleared', from: yesterday },
    ]);
  });
});
