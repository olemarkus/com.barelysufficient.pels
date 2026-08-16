import { resolveLastTotalPowerKw } from '../../lib/power/lastTotalPower';

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
