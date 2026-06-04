import {
  mergeHoursPreservingCommitment,
  shouldFireNotification,
} from '../../lib/objectives/deferredObjectives/activePlanSchedule';

const HOUR_MS = 60 * 60 * 1000;
// Anchor the hour constants on real hour boundaries so the partition keys
// (`floor(nowMs / HOUR_MS)`) land cleanly. TEN/ELEVEN/TWELVE/THIRTEEN are
// consecutive hour-aligned `startsAtMs` values; a `nowMs` "in hour N" is N's
// boundary plus a sub-hour offset.
const TEN = 10 * HOUR_MS;
const ELEVEN = 11 * HOUR_MS;
const TWELVE = 12 * HOUR_MS;
const THIRTEEN = 13 * HOUR_MS;
const SUB_HOUR = 30 * 60 * 1000; // 30 min into an hour

describe('mergeHoursPreservingCommitment', () => {
  it('returns the live hours when the commitment is empty (satisfied-then-drift)', () => {
    const merged = mergeHoursPreservingCommitment(
      [],
      [
        { startsAtMs: TEN, plannedKWh: 0.75 },
        { startsAtMs: ELEVEN, plannedKWh: 0.5 },
      ],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 0.75 },
      { startsAtMs: ELEVEN, plannedKWh: 0.5 },
    ]);
  });

  it('extends the commitment with expansion-added hours and preserves committed plannedKWh as a floor on overlap', () => {
    // The committed kWh is the contract for that hour. A shrinking live
    // value (allocator's per-cycle re-fill against a lower current need)
    // must not be allowed to rewrite the commitment downward — otherwise
    // the persisted `commitment.hours[].plannedKWh` floor would shrink and
    // silently weaken the guarantee against further cycles' optimizer
    // thrash. now is in the committed hour (TEN), so TEN is current (gated)
    // and covered by live; the new ELEVEN expansion is adopted.
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: TEN, plannedKWh: 0.65 }],
      [
        { startsAtMs: TEN, plannedKWh: 0.4 },
        { startsAtMs: ELEVEN, plannedKWh: 0.3 },
      ],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 0.65 },
      { startsAtMs: ELEVEN, plannedKWh: 0.3 },
    ]);
  });

  it('clears coversFromMs when a full-hour committed floor wins the overlap', () => {
    // A future hour was committed full (no coversFromMs) and is now current,
    // where the live plan re-allocates it trimmed (coversFromMs, smaller
    // post-trim kWh). The floor wins the Math.max, so the merged hour is the
    // FULL hour — coversFromMs must drop so the history chart prorates it rather
    // than treating it as an already-trimmed sub-hour span.
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: TEN, plannedKWh: 0.65 }],
      [{ startsAtMs: TEN, plannedKWh: 0.4, coversFromMs: TEN + SUB_HOUR }],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([{ startsAtMs: TEN, plannedKWh: 0.65 }]);
  });

  it('keeps coversFromMs for a freshly trimmed current hour with no committed floor', () => {
    // Satisfied-then-drift: no prior commitment, the live current hour is the
    // first booking and is already trimmed. Its coversFromMs survives so the
    // chart adds its energy whole rather than prorating it.
    const merged = mergeHoursPreservingCommitment(
      [],
      [{ startsAtMs: TEN, plannedKWh: 0.4, coversFromMs: TEN + SUB_HOUR }],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([{ startsAtMs: TEN, plannedKWh: 0.4, coversFromMs: TEN + SUB_HOUR }]);
  });

  it('prefers the committed full-hour coverage on an equal-energy overlap (tie)', () => {
    // A trimmed live current-hour bucket rounds back to the committed full-hour
    // kWh (or the device made no measurable progress). The energies tie, so the
    // committed full-hour coverage must win (`>=`) — keeping the live trimmed
    // coversFromMs would mislabel the full hour as already-trimmed and suppress
    // the chart's proration of the elapsed part.
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: TEN, plannedKWh: 0.5 }],
      [{ startsAtMs: TEN, plannedKWh: 0.5, coversFromMs: TEN + SUB_HOUR }],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([{ startsAtMs: TEN, plannedKWh: 0.5 }]);
  });

  it('adopts the live plannedKWh on overlap when live exceeds the committed kWh (growth case)', () => {
    // Mirror of the floor test: when live's plannedKWh exceeds committed
    // (e.g. drift made the original commitment under-deliver and the
    // re-fill now claims more for the same hour), the live value wins
    // because it represents the larger contract.
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: TEN, plannedKWh: 0.4 }],
      [
        { startsAtMs: TEN, plannedKWh: 0.65 },
        { startsAtMs: ELEVEN, plannedKWh: 0.3 },
      ],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 0.65 },
      { startsAtMs: ELEVEN, plannedKWh: 0.3 },
    ]);
  });

  it('preserves committed hours that the live plan no longer fills (commitment cannot shrink)', () => {
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: TEN, plannedKWh: 0.65 },
        { startsAtMs: ELEVEN, plannedKWh: 0.3 },
      ],
      [],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 0.65 },
      { startsAtMs: ELEVEN, plannedKWh: 0.3 },
    ]);
  });

  it('preserves the commitment when live disagrees (optimizer churn, not expansion)', () => {
    // Live is missing the still-current TEN committed hour — that is NOT
    // expansion, it is the committed-replan path producing a different set of
    // hours than the commitment. now is in TEN, so TEN is current and gates
    // coverage; live drops it, so freeze.
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: TEN, plannedKWh: 1.0 },
        { startsAtMs: ELEVEN, plannedKWh: 1.0 },
      ],
      [
        { startsAtMs: ELEVEN, plannedKWh: 1.0 },
        { startsAtMs: TWELVE, plannedKWh: 1.0 },
      ],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 1.0 },
      { startsAtMs: ELEVEN, plannedKWh: 1.0 },
    ]);
  });

  it('adopts a new future hour once an early committed hour has elapsed (freeze-forever fix)', () => {
    // Regression: commit [TEN, ELEVEN]; later the task extends and the live
    // plan is [ELEVEN, TWELVE]. now is in hour ELEVEN, so TEN has truly
    // elapsed (TEN < currentHourStart) and ELEVEN is the current hour. The
    // elapsed TEN must not gate coverage (otherwise the schedule freezes
    // forever after the first hour passes): live ⊇ the current/future
    // committed hours ([ELEVEN]), so we adopt the expansion. TEN and ELEVEN
    // are preserved as floors and TWELVE is added.
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: TEN, plannedKWh: 1.5 },
        { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      ],
      [
        { startsAtMs: ELEVEN, plannedKWh: 1.5 },
        { startsAtMs: TWELVE, plannedKWh: 1.2 },
      ],
      ELEVEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 1.5 },
      { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      { startsAtMs: TWELVE, plannedKWh: 1.2 },
    ]);
    // The new future hour is present (the freeze-forever bug dropped it).
    expect(merged.some((h) => h.startsAtMs === TWELVE)).toBe(true);
  });

  it('preserves the committed kWh floor on an overlapping hour after an elapse', () => {
    // Same elapsed-hour shape, but the live re-fill for the still-current
    // overlapping hour (ELEVEN) claims LESS than the commitment. The committed
    // kWh must survive as a floor.
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: TEN, plannedKWh: 1.5 },
        { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      ],
      [
        { startsAtMs: ELEVEN, plannedKWh: 0.8 },
        { startsAtMs: TWELVE, plannedKWh: 1.2 },
      ],
      ELEVEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 1.5 },
      { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      { startsAtMs: TWELVE, plannedKWh: 1.2 },
    ]);
  });

  it('freezes when a still-future committed hour is dropped BEFORE the earliest live hour (the P0 case)', () => {
    // The case the old live-earliest-hour partition missed. commit
    // [ELEVEN, TWELVE, THIRTEEN]; the optimizer reprices and emits live
    // [THIRTEEN, ...] — ELEVEN and TWELVE are repriced to 0 kWh and vanish
    // from the live set. now is in hour TEN (before ELEVEN), so ELEVEN and
    // TWELVE are still FUTURE (>= currentHourStart), not elapsed. The old
    // code keyed off the live earliest hour (THIRTEEN), misclassified ELEVEN
    // and TWELVE as "elapsed", found live covered the remaining ([THIRTEEN]),
    // and ADOPTED — dropping committed TWELVE and growing on optimizer thrash.
    // Keying off nowMs, ELEVEN/TWELVE are current/future and missing from
    // live, so this is genuine churn → FREEZE.
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: ELEVEN, plannedKWh: 1.5 },
        { startsAtMs: TWELVE, plannedKWh: 1.5 },
        { startsAtMs: THIRTEEN, plannedKWh: 1.5 },
      ],
      [
        { startsAtMs: THIRTEEN, plannedKWh: 1.5 },
        { startsAtMs: 14 * HOUR_MS, plannedKWh: 1.5 },
      ],
      TEN + SUB_HOUR,
    );
    // Frozen to the full commitment.
    expect(merged).toEqual([
      { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      { startsAtMs: TWELVE, plannedKWh: 1.5 },
      { startsAtMs: THIRTEEN, plannedKWh: 1.5 },
    ]);
    // The dropped future hour is retained and the optimizer-thrash expansion
    // (14:00) is NOT adopted.
    expect(merged.some((h) => h.startsAtMs === TWELVE)).toBe(true);
    expect(merged.some((h) => h.startsAtMs === 14 * HOUR_MS)).toBe(false);
  });

  it('still freezes on genuine future-hour churn (dropped hour after the earliest live hour)', () => {
    // Pure churn: every committed hour is current/future, and live drops the
    // TWELVE future hour. now is in TEN, so nothing has elapsed; the gap is
    // genuine churn, so the commitment must freeze (no shrink).
    const merged = mergeHoursPreservingCommitment(
      [
        { startsAtMs: TEN, plannedKWh: 1.5 },
        { startsAtMs: ELEVEN, plannedKWh: 1.5 },
        { startsAtMs: TWELVE, plannedKWh: 1.5 },
      ],
      [
        { startsAtMs: TEN, plannedKWh: 1.5 },
        { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      ],
      TEN + SUB_HOUR,
    );
    expect(merged).toEqual([
      { startsAtMs: TEN, plannedKWh: 1.5 },
      { startsAtMs: ELEVEN, plannedKWh: 1.5 },
      { startsAtMs: TWELVE, plannedKWh: 1.5 },
    ]);
  });

  it('returns live sorted by startsAtMs when expansion adds out-of-order new hours', () => {
    const merged = mergeHoursPreservingCommitment(
      [{ startsAtMs: ELEVEN, plannedKWh: 0.5 }],
      [
        { startsAtMs: TWELVE, plannedKWh: 0.4 },
        { startsAtMs: ELEVEN, plannedKWh: 0.5 },
        { startsAtMs: TEN, plannedKWh: 0.3 },
      ],
      ELEVEN + SUB_HOUR,
    );
    expect(merged.map((h) => h.startsAtMs)).toEqual([TEN, ELEVEN, TWELVE]);
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
