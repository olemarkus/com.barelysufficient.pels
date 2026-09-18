import { resolveCurrentMonthQuarterPeakKw } from '../../lib/power/capacityPeak';
import { MAX_POWER_SAMPLE_GAP_MS } from '../../lib/power/trackerTypes';

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

  it('includes an active quarter completed by a held Flow sample', () => {
    const quarterStartMs = Date.parse('2026-09-17T10:00:00.000Z');
    const result = resolveCurrentMonthQuarterPeakKw({
      lastTimestamp: quarterStartMs + 10 * 60 * 1000,
      lastPowerW: 6_000,
      capacityQuarter: {
        startMs: quarterStartMs,
        energyKWh: 1,
        trackedMs: 10 * 60 * 1000,
      },
      capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 4 },
    }, 'Europe/Brussels', quarterStartMs + 16 * 60 * 1000);

    expect(result).toBeCloseTo(6, 6);
  });

  it('includes a later full held-sample quarter after an incomplete first quarter', () => {
    const quarterStartMs = Date.parse('2026-09-17T10:00:00.000Z');
    const result = resolveCurrentMonthQuarterPeakKw({
      lastTimestamp: quarterStartMs + 10 * 60 * 1000,
      lastPowerW: 6_000,
      capacityQuarter: {
        startMs: quarterStartMs,
        energyKWh: 0,
        trackedMs: 0,
      },
    }, 'Europe/Brussels', quarterStartMs + 31 * 60 * 1000);

    expect(result).toBeCloseTo(6, 6);
  });

  it('does not project a held sample beyond the accepted tracker gap', () => {
    const lastTimestamp = Date.parse('2026-09-01T10:10:00.000Z');
    const result = resolveCurrentMonthQuarterPeakKw({
      lastTimestamp,
      lastPowerW: 9_000,
      capacityQuarter: {
        startMs: Date.parse('2026-09-01T10:00:00.000Z'),
        energyKWh: 0.2,
        trackedMs: 10 * 60 * 1000,
      },
      capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 4 },
    }, 'Europe/Brussels', lastTimestamp + MAX_POWER_SAMPLE_GAP_MS + 1);

    expect(result).toBeCloseTo(4, 6);
  });
});
