import { resolvePowerCycleReading } from '../../lib/power/powerCycleReading';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/power/sampleFreshness';

const NOW_MS = Date.UTC(2026, 3, 18, 10, 0, 0);

// The reading is resolved from the tracker's own latch — the fixture states
// tracker state exactly as ingest would have latched it (watts and stamp from
// the same sample), and the resolver derives everything else.
const resolve = (ageMs: number, totalKw = 4) => resolvePowerCycleReading({
  powerTracker: { lastPowerW: totalKw * 1000, lastTimestamp: NOW_MS - ageMs },
  nowMs: NOW_MS,
});

describe('resolvePowerCycleReading — what the planner is allowed to know', () => {
  it('answers a measured headroom as the real difference', () => {
    const reading = resolve(1000, 4);
    expect(reading.isMeasured).toBe(true);
    if (!reading.isMeasured) throw new Error('unreachable');
    expect(reading.totalKw).toBe(4);
    expect(reading.headroomKw(6)).toBe(2);
    expect(reading.headroomKw(3)).toBe(-1);
  });

  it('carries a minutes-old reading forward as measured', () => {
    // Between the 60 s staleness threshold and the 10-minute shed timeout a
    // gap is a no-op (owner ruling 2026-08-31): the last good value carries
    // forward AS MEASURED — no hold, no synthesized 0.
    const reading = resolve(POWER_SAMPLE_STALE_THRESHOLD_MS + 60_000, 4);
    expect(reading.isMeasured).toBe(true);
    if (!reading.isMeasured) throw new Error('unreachable');
    expect(reading.headroomKw(6)).toBe(2);
  });

  it('answers the silent-meter variant once silence passes the shed timeout — a signal, never a number', () => {
    // This used to force a sentinel `-1` headroom, which every consumer then
    // did arithmetic on (owner ruling 2026-09-02). The silent variant carries
    // no headroom at all: the planner takes an explicit directive instead.
    const reading = resolve(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, 9.9);

    expect(reading.isMeasured).toBe(false);
    expect(reading).not.toHaveProperty('headroomKw');
    // The carried reading is still on the display facts — the owner may see
    // the last real number — but nothing plans on it.
    expect(reading.totalKw).toBe(9.9);
    expect(reading.lastPowerUpdateMs).toBe(NOW_MS - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
  });

  // The measurement gate is the reading's precondition, not a case it hedges
  // for: a build reaching this resolver with an unsampled tracker is a wiring
  // bug, and it fails loud instead of planning on a fabricated number.
  it('throws on an unsampled tracker — a build past the gate is a violation, not a hold', () => {
    expect(() => resolvePowerCycleReading({ powerTracker: {}, nowMs: NOW_MS })).toThrow(/measurement gate/);
    expect(() => resolvePowerCycleReading({
      powerTracker: { lastPowerW: 4000 },
      nowMs: NOW_MS,
    })).toThrow(/measurement gate/);
    expect(() => resolvePowerCycleReading({
      powerTracker: { lastPowerW: Number.NaN, lastTimestamp: NOW_MS },
      nowMs: NOW_MS,
    })).toThrow(/measurement gate/);
  });

  it('stamps the display from the same sample as the watts — one view, no nullable', () => {
    const reading = resolve(1000, 4);
    expect(reading.totalKw).toBe(4);
    expect(reading.lastPowerUpdateMs).toBe(NOW_MS - 1000);
  });
});
