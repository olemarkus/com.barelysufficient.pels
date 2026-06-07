import { isAheadOfHourMilestone } from '../../lib/objectives/deferredObjectives/trajectoryMilestone';
import type { DeferredObjectiveActivePlanHourV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';

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

describe('isAheadOfHourMilestone — unit trajectory (bug 1)', () => {
  // Committed hours carrying the persisted per-hour unit milestone (cumulative
  // target value by END of hour). Current hour at HOUR_START, then future hours.
  const milestoneHours = (
    currentMilestone: number,
    futureMilestones: number[],
  ): DeferredObjectiveActivePlanHourV1[] => [
    { startsAtMs: HOUR_START, plannedKWh: 2, plannedUnitMilestone: currentMilestone },
    ...futureMilestones.map((plannedUnitMilestone, i) => ({
      startsAtMs: HOUR_START + (i + 1) * HOUR_MS,
      plannedKWh: 2,
      plannedUnitMilestone,
    })),
  ];

  it('decides on UNITS and ignores a drifted energy figure (the bug-1 fix)', () => {
    // This hour's frozen target is 52; measured 53 is at/above it AND future hours
    // exist ⇒ ahead — regardless of energyNeededKWh, which a drifted/leaky rate
    // could make wildly wrong. Single-milestone compare: no cross-hour subtraction.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 999, // would say NOT ahead via the energy gate
      measuredValue: 53,
      committedHours: milestoneHours(52, [54, 56]),
      nowMs: NOW_MS,
    })).toBe(true);
  });

  it('is not ahead when measured is behind this hour\'s milestone', () => {
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 0, // energy gate would say ahead; the unit gate overrides
      measuredValue: 51, // below this hour's target of 52
      committedHours: milestoneHours(52, [54, 56]),
      nowMs: NOW_MS,
    })).toBe(false);
  });

  it('is ahead exactly at this hour\'s milestone', () => {
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 999,
      measuredValue: 52, // exactly at this hour's target
      committedHours: milestoneHours(52, [54, 56]),
      nowMs: NOW_MS,
    })).toBe(true);
  });

  it('is not ahead when there are no future committed hours to defer into', () => {
    // At/above this hour's milestone, but nothing later to carry the rest ⇒ keep
    // heating (releasing would just stop with no fallback).
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 999,
      measuredValue: 60,
      committedHours: milestoneHours(52, []), // only the current hour, no future
      nowMs: NOW_MS,
    })).toBe(false);
  });

  it('falls back to the energy gate when no measured value is supplied', () => {
    // No measuredValue ⇒ unit path inapplicable ⇒ energy comparison (future 4 kWh).
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 6, // 6 ≤ 4 × 0.98 is false
      committedHours: milestoneHours(52, [54, 56]),
      nowMs: NOW_MS,
    })).toBe(false);
  });

  it('falls back to the energy gate when the commitment has no persisted milestones', () => {
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 6,
      measuredValue: 54,
      committedHours: [{ startsAtMs: HOUR_START, plannedKWh: 4 }, ...futureHours([5, 5])], // 10 kWh ⇒ 6 ≤ 9.8 true
      nowMs: NOW_MS,
    })).toBe(true);
  });

  it('mixed-anchor commitment: uses ONLY this hour\'s milestone (locks the P1 closed)', () => {
    // Simulates what mergeHoursPreservingCommitment produces: the current hour's
    // milestone was frozen at an EARLIER revision (lower measured anchor), while
    // the future hours were re-anchored later at a much higher measured value —
    // so their milestones (80, 90) are on a different scale than the current
    // hour's (52). The old code subtracted across these (final − current) and
    // could mis-release; the single-milestone compare reads ONLY the current
    // hour's 52, so the inflated future scale is irrelevant to the result.
    const mixedAnchorHours: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: HOUR_START, plannedKWh: 2, plannedUnitMilestone: 52 }, // old, lower anchor
      { startsAtMs: HOUR_START + HOUR_MS, plannedKWh: 2, plannedUnitMilestone: 80 }, // new, higher anchor
      { startsAtMs: HOUR_START + 2 * HOUR_MS, plannedKWh: 2, plannedUnitMilestone: 90 },
    ];
    // Below this hour's target (52) ⇒ NOT ahead, despite the inflated future milestones.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 999, measuredValue: 51, committedHours: mixedAnchorHours, nowMs: NOW_MS,
    })).toBe(false);
    // At/above this hour's target ⇒ ahead, again independent of the future scale.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 0, measuredValue: 53, committedHours: mixedAnchorHours, nowMs: NOW_MS,
    })).toBe(true);
  });

  it('current hour committed but milestone missing ⇒ energy fallback (no stale earlier substitution)', () => {
    // Latest started hour is the CURRENT hour (HOUR_START), which lacks a milestone
    // (booked before a rate existed); an EARLIER elapsed hour has one (40). The gate
    // must NOT reach back to the earlier 40 — it falls through to the energy gate.
    const hours: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: HOUR_START - HOUR_MS, plannedKWh: 2, plannedUnitMilestone: 40 }, // elapsed, has milestone
      { startsAtMs: HOUR_START, plannedKWh: 2 }, // current hour, NO milestone
      { startsAtMs: HOUR_START + HOUR_MS, plannedKWh: 5 }, // future
    ];
    // If it (wrongly) used the stale 40, measured 60 ≥ 40 ⇒ true. The fix takes the
    // energy path instead: future 5 kWh, need 6 ⇒ 6 ≤ 5 × 0.98 is false.
    expect(isAheadOfHourMilestone({
      energyNeededKWh: 6,
      measuredValue: 60,
      committedHours: hours,
      nowMs: NOW_MS,
    })).toBe(false);
  });
});
