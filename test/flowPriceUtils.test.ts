import {
  getFlowPricePayload,
  getMissingFlowHours,
  parseFlowPriceInput,
} from '../lib/price/flowPriceUtils';

describe('flowPriceUtils', () => {
  it('parses array inputs and filters invalid entries', () => {
    const result = parseFlowPriceInput([0.1, '0.2', '', undefined, 0]);

    expect(result).toEqual({
      '0': 0.1,
      '1': 0.2,
      '4': 0,
    });
  });

  it('parses single-quote JSON with trailing comma', () => {
    const result = parseFlowPriceInput("{'0':0.3,'1':'0.4',}");

    expect(result).toEqual({
      '0': 0.3,
      '1': 0.4,
    });
  });

  it('parses standard JSON strings', () => {
    const result = parseFlowPriceInput('{"2":0.5}');

    expect(result).toEqual({
      '2': 0.5,
    });
  });

  it('throws on empty or invalid input', () => {
    expect(() => parseFlowPriceInput('   ')).toThrow('Price data is empty.');
    expect(() => parseFlowPriceInput(123)).toThrow('No valid hourly prices found in price data.');
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
});
