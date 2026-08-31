import { resolvePowerCycleReading } from '../../lib/power/powerCycleReading';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/power/sampleFreshness';

const NOW_MS = Date.UTC(2026, 3, 18, 10, 0, 0);

const resolve = (ageMs: number | null, totalKw: number | null = 4) => resolvePowerCycleReading({
  powerTracker: ageMs === null ? {} : { lastTimestamp: NOW_MS - ageMs },
  totalKw,
  nowMs: NOW_MS,
});

describe('resolvePowerCycleReading — what the planner is allowed to know', () => {
  it('answers a measured headroom as the real difference', () => {
    const reading = resolve(1000, 4);

    expect(reading.isMeasured).toBe(true);
    expect(reading.headroomKw(6)).toBeCloseTo(2, 6);
    expect(reading.headroomKw(3)).toBeCloseTo(-1, 6);
  });

  // Owner ruling 2026-08-31: between the 60 s staleness threshold and the
  // 10-minute shed timeout the last good value carries forward AS MEASURED —
  // a transient gap is a no-op, not a hold. (The old `stale_hold` 0 kW
  // synthesis re-decided on the strength of a sample merely being old.)
  it('carries a minutes-old reading forward as measured', () => {
    const reading = resolve(POWER_SAMPLE_STALE_THRESHOLD_MS + 60_000, 4);

    expect(reading.isMeasured).toBe(true);
    expect(reading.headroomKw(6)).toBeCloseTo(2, 6);
    expect(reading.measuredAtOrBelowKw(4)).toBe(true);
    expect(reading.display.measuredTotalKw).toBe(4);
  });

  // The one silent-window build is the escalation's fail-closed pass: it must
  // shed, and it must never spend the cached total, however large.
  it('forces -1 and spends nothing once silence passes the shed timeout', () => {
    const reading = resolve(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, 9.9);

    expect(reading.isMeasured).toBe(false);
    expect(reading.headroomKw(6)).toBe(-1);
    expect(reading.headroomKw(0)).toBe(-1);
    expect(reading.measuredAtOrBelowKw(100)).toBe(false);
    expect(reading.display.measuredTotalKw).toBeNull();
  });

  // Defensive only: production's measurement gate prevents a build with no
  // total, so the hold is the boundary where that absence stops.
  it('reports no measurement when there is no total, even on a fresh timestamp', () => {
    const reading = resolve(1000, null);

    expect(reading.isMeasured).toBe(false);
    expect(reading.headroomKw(6)).toBe(0);
    expect(reading.measuredAtOrBelowKw(100)).toBe(false);
  });

  it('answers measuredAtOrBelowKw and measuredAboveKw only on a positive measurement', () => {
    const measured = resolve(1000, 4);
    expect(measured.measuredAtOrBelowKw(4)).toBe(true);
    expect(measured.measuredAtOrBelowKw(3.9)).toBe(false);
    expect(measured.measuredAboveKw(3.9)).toBe(true);
    expect(measured.measuredAboveKw(4)).toBe(false);

    const silent = resolve(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, 4);
    expect(silent.measuredAtOrBelowKw(100)).toBe(false);
    expect(silent.measuredAboveKw(0)).toBe(false);
  });

  it('resolves the measured draw once, rather than leaving consumers to recombine it', () => {
    expect(resolve(1000, 4).display.measuredTotalKw).toBe(4);
    expect(resolve(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, 4).display.measuredTotalKw).toBeNull();
    expect(resolve(1000, null).display.measuredTotalKw).toBeNull();
  });
});
