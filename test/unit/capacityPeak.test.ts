import { resolveCurrentMonthQuarterPeakKw } from '../../lib/power/capacityPeak';

describe('resolveCurrentMonthQuarterPeakKw', () => {
  it('reports the highest completed quarter in the current local month', () => {
    const nowMs = Date.parse('2026-09-17T10:08:00.000Z');
    const result = resolveCurrentMonthQuarterPeakKw({
      capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 5.6 },
    }, 'Europe/Brussels', nowMs);

    expect(result).toBeCloseTo(5.6, 6);
  });

  it('returns null without a completed quarter in the current month', () => {
    const nowMs = Date.parse('2026-09-01T00:05:00.000Z');
    expect(resolveCurrentMonthQuarterPeakKw({}, 'Europe/Brussels', nowMs)).toBeNull();
  });

  it('ignores a retained peak from the previous local month', () => {
    const nowMs = Date.parse('2026-09-01T00:05:00.000Z');
    expect(resolveCurrentMonthQuarterPeakKw({
      capacityMonthlyPeak: { monthKey: '2026-08', peakKw: 8 },
    }, 'Europe/Brussels', nowMs)).toBeNull();
  });
});
