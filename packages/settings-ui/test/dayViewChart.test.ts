import {
  formatAxisTick,
  readChartPalette,
  roundedAxisMaxToInterval,
} from '../src/ui/dayViewChart.ts';

describe('roundedAxisMaxToInterval', () => {
  it('returns a 1-unit axis for non-finite or non-positive inputs', () => {
    expect(roundedAxisMaxToInterval(Number.NaN, 4)).toEqual({ max: 1, interval: 0.25 });
    expect(roundedAxisMaxToInterval(Number.POSITIVE_INFINITY, 4)).toEqual({ max: 1, interval: 0.25 });
    expect(roundedAxisMaxToInterval(Number.NEGATIVE_INFINITY, 4)).toEqual({ max: 1, interval: 0.25 });
    expect(roundedAxisMaxToInterval(0, 4)).toEqual({ max: 1, interval: 0.25 });
    expect(roundedAxisMaxToInterval(-0.5, 4)).toEqual({ max: 1, interval: 0.25 });
  });

  // Regression: TODO 559. Live walk 2026-05-16 showed Today=3.7 producing
  // ticks 0,1,2,3,3.7 because the old helper pinned max=3.7 with splitNumber=4
  // and ECharts gave up trying to find a clean interval.
  it('rounds max up so splitNumber clean ticks fit (3.7 → 4)', () => {
    expect(roundedAxisMaxToInterval(3.7, 4)).toEqual({ max: 4, interval: 1 });
  });

  // Regression: TODO 559. Daily usage chart at 71 produced ticks 0,20,40,60,71.
  it('rounds large kWh totals to a nice 20-step grid (71 → 80)', () => {
    expect(roundedAxisMaxToInterval(71, 4)).toEqual({ max: 80, interval: 20 });
  });

  // Regression: TODO 559. Typical day at 1 → ticks 0,0.3,0.6,0.9,1.
  it('keeps a 1 kWh max on a clean 0.25-step grid', () => {
    expect(roundedAxisMaxToInterval(1, 4)).toEqual({ max: 1, interval: 0.25 });
  });

  it('keeps an already-clean max unchanged', () => {
    expect(roundedAxisMaxToInterval(4, 4)).toEqual({ max: 4, interval: 1 });
    expect(roundedAxisMaxToInterval(100, 4)).toEqual({ max: 100, interval: 25 });
    expect(roundedAxisMaxToInterval(10, 4)).toEqual({ max: 10, interval: 2.5 });
  });

  it('picks nice 0.1/0.2/0.25 steps in the sub-kWh regime', () => {
    expect(roundedAxisMaxToInterval(0.3, 4)).toEqual({ max: 0.4, interval: 0.1 });
    expect(roundedAxisMaxToInterval(0.45, 4)).toEqual({ max: 0.8, interval: 0.2 });
    expect(roundedAxisMaxToInterval(0.95, 4)).toEqual({ max: 1, interval: 0.25 });
  });

  it('always returns max >= dataMax and divisible by splitNumber × interval', () => {
    const inputs = [0.07, 0.5, 1.2, 3.7, 12, 71, 240];
    for (const dataMax of inputs) {
      const { max, interval } = roundedAxisMaxToInterval(dataMax, 4);
      expect(max).toBeGreaterThanOrEqual(dataMax);
      // 4 clean intervals up to max.
      expect(max / interval).toBeCloseTo(Math.round(max / interval), 9);
      expect(Math.round(max / interval)).toBe(4);
    }
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

describe('formatAxisTick', () => {
  it('returns integer-only strings when the interval is whole', () => {
    expect(formatAxisTick(0, 1)).toBe('0');
    expect(formatAxisTick(1, 1)).toBe('1');
    expect(formatAxisTick(20, 20)).toBe('20');
    expect(formatAxisTick(80, 20)).toBe('80');
  });

  // Regression: PR #842 review. With dataMax=0.95 the helper picks
  // interval=0.25; ticks 0.25 and 0.75 must render at their exact value,
  // not "0.3" / "0.8".
  it('preserves 0.25-step precision in the sub-kWh regime', () => {
    expect(formatAxisTick(0, 0.25)).toBe('0');
    expect(formatAxisTick(0.25, 0.25)).toBe('0.25');
    expect(formatAxisTick(0.5, 0.25)).toBe('0.5');
    expect(formatAxisTick(0.75, 0.25)).toBe('0.75');
    expect(formatAxisTick(1, 0.25)).toBe('1');
  });

  // Regression: PR #842 review. With dataMax=10 the helper picks
  // interval=2.5; ticks 2.5 and 7.5 must render at the half-step, not
  // be rounded to 3 / 8.
  it('preserves 2.5-step precision in the mid-range regime', () => {
    expect(formatAxisTick(0, 2.5)).toBe('0');
    expect(formatAxisTick(2.5, 2.5)).toBe('2.5');
    expect(formatAxisTick(5, 2.5)).toBe('5');
    expect(formatAxisTick(7.5, 2.5)).toBe('7.5');
    expect(formatAxisTick(10, 2.5)).toBe('10');
  });

  it('preserves 0.1 step precision', () => {
    expect(formatAxisTick(0, 0.1)).toBe('0');
    expect(formatAxisTick(0.1, 0.1)).toBe('0.1');
    expect(formatAxisTick(0.4, 0.1)).toBe('0.4');
  });

  it('returns empty string for non-finite values', () => {
    expect(formatAxisTick(Number.NaN, 1)).toBe('');
    expect(formatAxisTick(Number.POSITIVE_INFINITY, 1)).toBe('');
  });

  // Binary-float drift safety: 0.3 from arithmetic can be
  // 0.30000000000000004 — the formatter still renders "0.3".
  it('absorbs binary-float drift in tick values', () => {
    expect(formatAxisTick(0.1 + 0.2, 0.1)).toBe('0.3');
  });
});
