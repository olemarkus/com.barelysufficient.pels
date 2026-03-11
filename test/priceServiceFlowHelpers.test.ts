import {
  buildCombinedHourlyPricesFromPayloads,
  storeFlowPriceData,
} from '../lib/price/priceServiceFlowHelpers';

describe('priceServiceFlowHelpers DST date keys', () => {
  it('keeps tomorrow payload on the spring-forward eve boundary', () => {
    const logDebug = jest.fn();
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
      allowTomorrowAsToday: false,
    });

    expect(result.some((entry) => entry.totalPrice === 4)).toBe(true);
    expect(logDebug).not.toHaveBeenCalledWith(
      expect.stringContaining('Ignoring stored tomorrow data'),
      expect.anything(),
    );
  });

  it('stores tomorrow under the next local date on spring-forward eve', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2024-03-30T22:30:00.000Z'));
      const setSetting = jest.fn();
      const updateCombinedPrices = jest.fn();

      const result = storeFlowPriceData({
        kind: 'tomorrow',
        raw: [1, 2, 4],
        timeZone: 'Europe/Oslo',
        logDebug: jest.fn(),
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
      jest.useRealTimers();
    }
  });
});
