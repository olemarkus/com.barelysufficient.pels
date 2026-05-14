import {
  readChartPalette,
  roundedKWhAxisMax,
} from '../src/ui/dayViewChart.ts';

describe('roundedKWhAxisMax', () => {
  it('returns 1 for non-finite or non-positive inputs', () => {
    expect(roundedKWhAxisMax(Number.NaN)).toBe(1);
    expect(roundedKWhAxisMax(Number.POSITIVE_INFINITY)).toBe(1);
    expect(roundedKWhAxisMax(Number.NEGATIVE_INFINITY)).toBe(1);
    expect(roundedKWhAxisMax(0)).toBe(1);
    expect(roundedKWhAxisMax(-0.5)).toBe(1);
  });

  it('rounds up to the next 0.1 below 1 kWh with a 0.1 floor', () => {
    expect(roundedKWhAxisMax(0.01)).toBe(0.1);
    expect(roundedKWhAxisMax(0.12)).toBeCloseTo(0.2, 10);
    expect(roundedKWhAxisMax(0.5)).toBe(0.5);
    expect(roundedKWhAxisMax(0.51)).toBeCloseTo(0.6, 10);
  });

  it('treats the 1 kWh boundary as the 0.1-step regime', () => {
    expect(roundedKWhAxisMax(1)).toBe(1);
  });

  it('rounds up to the next 0.1 between 1 and 5 kWh', () => {
    expect(roundedKWhAxisMax(1.01)).toBeCloseTo(1.1, 10);
    expect(roundedKWhAxisMax(2.34)).toBeCloseTo(2.4, 10);
    expect(roundedKWhAxisMax(4.95)).toBe(5);
  });

  it('treats the 5 kWh boundary as the 0.1-step regime', () => {
    expect(roundedKWhAxisMax(5)).toBe(5);
  });

  it('rounds up to the next integer above 5 kWh', () => {
    expect(roundedKWhAxisMax(5.01)).toBe(6);
    expect(roundedKWhAxisMax(7.4)).toBe(8);
    expect(roundedKWhAxisMax(20)).toBe(20);
    expect(roundedKWhAxisMax(20.01)).toBe(21);
  });
});

describe('readChartPalette', () => {
  it('reads every variable from a single getComputedStyle snapshot', () => {
    const getPropertyValue = vi.fn((variable: string): string => {
      if (variable === '--a') return '  #aaa  ';
      if (variable === '--b') return '#bbb';
      return '';
    });
    const getComputedStyleSpy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockReturnValue({ getPropertyValue } as unknown as CSSStyleDeclaration);

    try {
      const element = document.createElement('div');
      const palette = readChartPalette<{ a: string; b: string; missing: string }>(element, {
        a: '--a',
        b: '--b',
        missing: '--missing',
      });

      expect(palette).toEqual({ a: '#aaa', b: '#bbb', missing: '' });
      expect(getComputedStyleSpy).toHaveBeenCalledTimes(1);
      expect(getPropertyValue).toHaveBeenCalledTimes(3);
    } finally {
      getComputedStyleSpy.mockRestore();
    }
  });
});
