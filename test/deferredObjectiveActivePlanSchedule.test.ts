import {
  mergeHoursPreservingCommitment,
  shouldFireNotification,
} from '../lib/plan/deferredObjectives/activePlanSchedule';

describe('mergeHoursPreservingCommitment', () => {
  it('returns the live hours when the commitment is empty (satisfied-then-drift)', () => {
    const merged = mergeHoursPreservingCommitment(
      [],
      [
        { startsAtMs: 5_000, plannedKWh: 0.75 },
        { startsAtMs: 8_000, plannedKWh: 0.5 },
      ],
    );
    expect(merged).toEqual([
      { startsAtMs: 5_000, plannedKWh: 0.75 },
      { startsAtMs: 8_000, plannedKWh: 0.5 },
    ]);
  });

  it('extends the commitment with expansion-added hours and preserves committed plannedKWh as a floor on overlap', () => {
    // The committed kWh is the contract for that hour. A shrinking live
    // value (allocator's per-cycle re-fill against a lower current need)
    // must not be allowed to rewrite the commitment downward — otherwise
    // the persisted `commitment.hours[].plannedKWh` floor would shrink and
    // silently weaken the guarantee against further cycles' optimizer
    // thrash.
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: 2_000, plannedKWh: 0.65 }],
      [
        { startsAtMs: 2_000, plannedKWh: 0.4 },
        { startsAtMs: 7_000, plannedKWh: 0.3 },
      ],
    );
    expect(merged).toEqual([
      { startsAtMs: 2_000, plannedKWh: 0.65 },
      { startsAtMs: 7_000, plannedKWh: 0.3 },
    ]);
  });

  it('adopts the live plannedKWh on overlap when live exceeds the committed kWh (growth case)', () => {
    // Mirror of the floor test: when live's plannedKWh exceeds committed
    // (e.g. drift made the original commitment under-deliver and the
    // re-fill now claims more for the same hour), the live value wins
    // because it represents the larger contract.
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: 2_000, plannedKWh: 0.4 }],
      [
        { startsAtMs: 2_000, plannedKWh: 0.65 },
        { startsAtMs: 7_000, plannedKWh: 0.3 },
      ],
    );
    expect(merged).toEqual([
      { startsAtMs: 2_000, plannedKWh: 0.65 },
      { startsAtMs: 7_000, plannedKWh: 0.3 },
    ]);
  });

  it('preserves committed hours that the live plan no longer fills (commitment cannot shrink)', () => {
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: 2_000, plannedKWh: 0.65 },
        { startsAtMs: 4_000, plannedKWh: 0.3 },
      ],
      [],
    );
    expect(merged).toEqual([
      { startsAtMs: 2_000, plannedKWh: 0.65 },
      { startsAtMs: 4_000, plannedKWh: 0.3 },
    ]);
  });

  it('preserves the commitment when live disagrees (optimizer churn, not expansion)', () => {
    // Live is missing a committed hour — that is NOT expansion, it is the
    // committed-replan path producing a different set of hours than the
    // commitment. Preserve the commitment as-is so the schedule does not
    // churn from optimizer thrash.
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: 2_000, plannedKWh: 1.0 },
        { startsAtMs: 4_000, plannedKWh: 1.0 },
      ],
      [
        { startsAtMs: 1_000, plannedKWh: 1.0 },
        { startsAtMs: 5_000, plannedKWh: 1.0 },
      ],
    );
    expect(merged).toEqual([
      { startsAtMs: 2_000, plannedKWh: 1.0 },
      { startsAtMs: 4_000, plannedKWh: 1.0 },
    ]);
  });

  it('returns live sorted by startsAtMs when expansion adds out-of-order new hours', () => {
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: 10_000, plannedKWh: 0.5 }],
      [
        { startsAtMs: 15_000, plannedKWh: 0.4 },
        { startsAtMs: 10_000, plannedKWh: 0.5 },
        { startsAtMs: 5_000, plannedKWh: 0.3 },
      ],
    );
    expect(merged.map((h) => h.startsAtMs)).toEqual([5_000, 10_000, 15_000]);
  });
});

describe('shouldFireNotification', () => {
  it('stays quiet when the planned-hour count is unchanged', () => {
    expect(shouldFireNotification(3, 3, 'cannot_meet')).toBe(false);
    expect(shouldFireNotification(0, 0, 'cannot_meet')).toBe(false);
  });

  it('fires whenever the schedule still has planned hours after a count change', () => {
    expect(shouldFireNotification(2, 3, 'on_track')).toBe(true);
    expect(shouldFireNotification(3, 1, 'satisfied')).toBe(true);
  });

  it('fires on an empty collapse for degraded statuses', () => {
    expect(shouldFireNotification(3, 0, 'cannot_meet')).toBe(true);
    expect(shouldFireNotification(3, 0, 'invalid')).toBe(true);
    // feasible_above_floor is the only at_risk that can reach an empty floor
    // schedule (reserve/policy at-risk always plan buckets); an empty floor
    // schedule is still a "plan blew up" event, so it must fire.
    expect(shouldFireNotification(3, 0, 'at_risk')).toBe(true);
  });

  it('suppresses an empty collapse when the target is already met', () => {
    expect(shouldFireNotification(3, 0, 'satisfied')).toBe(false);
    expect(shouldFireNotification(3, 0, 'on_track')).toBe(false);
  });
});
