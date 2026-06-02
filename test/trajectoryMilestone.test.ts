import { isAheadOfHourMilestone } from '../lib/objectives/deferredObjectives/trajectoryMilestone';
import type { DeferredObjectiveActivePlanHourV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 60 * 60 * 1000;
// A clock-hour boundary so "current hour" math is unambiguous.
const HOUR_START = Date.UTC(2026, 0, 1, 17);
const NOW_MS = HOUR_START + 20 * 60 * 1000; // 17:20, mid-hour

const futureHours = (
  kWhPerHour: number[],
  firstStartMs = HOUR_START + HOUR_MS,
): DeferredObjectiveActivePlanHourV1[] => (
  kWhPerHour.map((plannedKWh, index) => ({ startsAtMs: firstStartMs + index * HOUR_MS, plannedKWh }))
);

describe('isAheadOfHourMilestone', () => {
  it('is ahead when the buffered energy still needed is covered by the later committed hours', () => {
    // future committed = 10 kWh; need 6 kWh ≤ 10 × 0.98 ⇒ ahead.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 6,
      committedHours: [
        { startsAtMs: HOUR_START, plannedKWh: 4 }, // current hour — excluded
        ...futureHours([5, 5]),
      ],
      nowMs: NOW_MS,
    })).toBe(true);
  });

  it('is not ahead when the later committed hours do not cover the need', () => {
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 10,
      committedHours: futureHours([5, 5]), // 10 kWh; 10 ≤ 9.8 is false
      nowMs: NOW_MS,
    })).toBe(false);
  });

  it('honours a consumption drop: a higher energy-need (lower measured value) is not ahead', () => {
    // Same plan as the "ahead" case, but a draw-off pushed the need up past supply.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 12,
      committedHours: futureHours([5, 5]),
      nowMs: NOW_MS,
    })).toBe(false);
  });

  it('applies the conservative ahead-margin at the boundary', () => {
    // future = 10 kWh, margin 2% ⇒ threshold 9.8.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 9.85,
      committedHours: futureHours([5, 5]),
      nowMs: NOW_MS,
    })).toBe(false);
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 9.75,
      committedHours: futureHours([5, 5]),
      nowMs: NOW_MS,
    })).toBe(true);
  });

  it('returns false when there is no committed future energy', () => {
    // No commitment at all.
    expect(isAheadOfHourMilestone({ energyNeededKWh: 1, committedHours: [], nowMs: NOW_MS })).toBe(false);
    // Only the current/past hours are booked — nothing strictly after this hour.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 1,
      committedHours: [
        { startsAtMs: HOUR_START - HOUR_MS, plannedKWh: 5 }, // past
        { startsAtMs: HOUR_START, plannedKWh: 5 }, // current
      ],
      nowMs: NOW_MS,
    })).toBe(false);
  });

  it('returns false for non-finite or negative energyNeededKWh', () => {
    for (const energyNeededKWh of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(isAheadOfHourMilestone({
        energyNeededKWh,
        committedHours: futureHours([10, 10]),
        nowMs: NOW_MS,
      })).toBe(false);
    }
  });

  it('excludes the current clock hour from the future-energy sum (mid-hour nowMs)', () => {
    // The current hour books a large amount; only the strictly-later hour counts.
    // future = 4 kWh; need 3.8 ≤ 4 × 0.98 = 3.92 ⇒ ahead, and the current hour's
    // 100 kWh must NOT inflate the milestone.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 3.8,
      committedHours: [
        { startsAtMs: HOUR_START, plannedKWh: 100 }, // current hour — excluded
        ...futureHours([4]),
      ],
      nowMs: NOW_MS,
    })).toBe(true);
  });

  it('counts a 25-hour DST day correctly (hour boundaries are absolute ms)', () => {
    const dstNow = Date.UTC(2026, 9, 25, 0, 30); // math is ms-based, day length irrelevant
    const dstHourStart = Date.UTC(2026, 9, 25, 0);
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 8,
      committedHours: futureHours([5, 5], dstHourStart + HOUR_MS), // 10 kWh ≥ 8 / 0.98
      nowMs: dstNow,
    })).toBe(true);
  });
});
