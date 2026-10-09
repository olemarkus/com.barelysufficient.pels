import { hasHeadroomFor, resolveLastTotalPowerKw, resolveObservedHeadroom } from '../../lib/power/lastTotalPower';

describe('resolveLastTotalPowerKw', () => {
  it('converts the latched watts to kW', () => {
    expect(resolveLastTotalPowerKw({ lastPowerW: 3500 })).toBe(3.5);
  });

  it('reports null before any sample has landed', () => {
    expect(resolveLastTotalPowerKw({})).toBeNull();
  });

  it('reports null when a freshness reset cleared the latch', () => {
    expect(resolveLastTotalPowerKw({ lastPowerW: undefined })).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('gates %s at the read rather than letting it reach a comparison', (_label, value) => {
    expect(resolveLastTotalPowerKw({ lastPowerW: value })).toBeNull();
  });

  it('keeps the sign while exporting, so headroom grows instead of clamping', () => {
    expect(resolveLastTotalPowerKw({ lastPowerW: -2100 })).toBeCloseTo(-2.1, 5);
  });
});

describe('resolveObservedHeadroom', () => {
  it('is unmeasured with no latched reading, even with a limit enabled', () => {
    expect(resolveObservedHeadroom({}, 5)).toEqual({ kind: 'unmeasured' });
  });

  it('is unmeasured rather than unlimited when there is neither a reading nor a limit', () => {
    expect(resolveObservedHeadroom({}, null)).toEqual({ kind: 'unmeasured' });
  });

  it('is unlimited with a reading and no enabled limit, and carries the reading', () => {
    expect(resolveObservedHeadroom({ lastPowerW: 3500 }, null)).toEqual({ kind: 'unlimited', totalKw: 3.5 });
  });

  it('measures the limit minus the reading, signed while over the limit', () => {
    expect(resolveObservedHeadroom({ lastPowerW: 3500 }, 5))
      .toEqual({ kind: 'measured', totalKw: 3.5, limitKw: 5, headroomKw: 1.5 });
    expect(resolveObservedHeadroom({ lastPowerW: 6000 }, 5))
      .toEqual({ kind: 'measured', totalKw: 6, limitKw: 5, headroomKw: -1 });
  });
});

describe('hasHeadroomFor', () => {
  it('fits anything with no enabled limit', () => {
    expect(hasHeadroomFor({ kind: 'unlimited', totalKw: 12 }, 50)).toBe(true);
  });

  it('fits exactly the measured headroom, and no more', () => {
    const headroom = { kind: 'measured', totalKw: 3.5, limitKw: 5, headroomKw: 1.5 } as const;
    expect(hasHeadroomFor(headroom, 1.5)).toBe(true);
    expect(hasHeadroomFor(headroom, 1.6)).toBe(false);
  });
});
