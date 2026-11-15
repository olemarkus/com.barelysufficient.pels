import { resolveCurrentMonthCapacityPeak } from '../../lib/power/capacityPeak';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { MAX_POWER_SAMPLE_GAP_MS } from '../../lib/power/trackerTypes';

// The tracked peak alone: no meter-reported peak beside it.
const peakKw = (tracker: PowerTrackerState, timeZone: string, nowMs: number): number | null => {
  const peak = resolveCurrentMonthCapacityPeak(tracker, null, timeZone, nowMs);
  return peak.state === 'recorded' ? peak.peakKw : null;
};

describe('resolveCurrentMonthCapacityPeak', () => {
  it('names a recorded peak and a month without a completed quarter as two states', () => {
    const nowMs = Date.parse('2026-09-17T10:08:00.000Z');
    expect(resolveCurrentMonthCapacityPeak({
      capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 5.6 },
    }, null, 'Europe/Brussels', nowMs)).toEqual({ state: 'recorded', peakKw: 5.6, source: 'tracked' });
    expect(resolveCurrentMonthCapacityPeak({}, null, 'Europe/Brussels', nowMs))
      .toEqual({ state: 'no_completed_quarter' });
  });

  it('reports the highest completed quarter in the current local month', () => {
    const nowMs = Date.parse('2026-09-17T10:08:00.000Z');
    const result = peakKw({
      capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 5.6 },
    }, 'Europe/Brussels', nowMs);

    expect(result).toBeCloseTo(5.6, 6);
  });

  it('returns null without a completed quarter in the current month', () => {
    const nowMs = Date.parse('2026-09-01T00:05:00.000Z');
    expect(peakKw({}, 'Europe/Brussels', nowMs)).toBeNull();
  });

  it('ignores a retained peak from the previous local month', () => {
    const nowMs = Date.parse('2026-09-01T00:05:00.000Z');
    expect(peakKw({
      capacityMonthlyPeak: { monthKey: '2026-08', peakKw: 8 },
    }, 'Europe/Brussels', nowMs)).toBeNull();
  });

  it('includes an active quarter completed by a held Flow sample', () => {
    const quarterStartMs = Date.parse('2026-09-17T10:00:00.000Z');
    const result = peakKw({
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
    const result = peakKw({
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
    const result = peakKw({
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

describe('resolveCurrentMonthCapacityPeak with the meter\'s own peak', () => {
  const nowMs = Date.parse('2026-09-17T10:08:00.000Z');
  const tracked: PowerTrackerState = { capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 5.6 } };

  it('takes the meter\'s peak when it is above the tracked one, and says so', () => {
    const meter = { peakKw: 6.4, observedAtMs: Date.parse('2026-09-03T18:15:00.000Z') };
    expect(resolveCurrentMonthCapacityPeak(tracked, meter, 'Europe/Brussels', nowMs))
      .toEqual({ state: 'recorded', peakKw: 6.4, source: 'meter' });
  });

  it('keeps the tracked peak when it is above the meter\'s', () => {
    const meter = { peakKw: 4.9, observedAtMs: Date.parse('2026-09-03T18:15:00.000Z') };
    expect(resolveCurrentMonthCapacityPeak(tracked, meter, 'Europe/Brussels', nowMs))
      .toEqual({ state: 'recorded', peakKw: 5.6, source: 'tracked' });
  });

  it('counts the meter\'s peak in a month PELS has no completed quarter for', () => {
    const meter = { peakKw: 3.2, observedAtMs: Date.parse('2026-09-02T07:30:00.000Z') };
    expect(resolveCurrentMonthCapacityPeak({}, meter, 'Europe/Brussels', nowMs))
      .toEqual({ state: 'recorded', peakKw: 3.2, source: 'meter' });
  });

  it('ignores last month\'s meter value still showing after local midnight on the 1st', () => {
    // 21:45 UTC on 31 August is 23:45 in Brussels: still August's value.
    const meter = { peakKw: 9, observedAtMs: Date.parse('2026-08-31T21:45:00.000Z') };
    const firstOfMonthMs = Date.parse('2026-08-31T22:20:00.000Z');
    expect(resolveCurrentMonthCapacityPeak({}, meter, 'Europe/Brussels', firstOfMonthMs))
      .toEqual({ state: 'no_completed_quarter' });
    expect(resolveCurrentMonthCapacityPeak(tracked, meter, 'Europe/Brussels', nowMs))
      .toEqual({ state: 'recorded', peakKw: 5.6, source: 'tracked' });
  });

  it('counts the meter again once it reports in the new month', () => {
    const meter = { peakKw: 1.8, observedAtMs: Date.parse('2026-08-31T22:15:00.000Z') };
    expect(resolveCurrentMonthCapacityPeak({}, meter, 'Europe/Brussels', Date.parse('2026-08-31T22:20:00.000Z')))
      .toEqual({ state: 'recorded', peakKw: 1.8, source: 'meter' });
  });
});
