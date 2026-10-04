import type {
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { resolveDeadlineMissSuppression } from '../../lib/weather/deadlineMissBudgetDay';
import { partialDouble } from '../helpers/partialDouble';

// 2026-02-10T12:00Z → local day "2026-02-10" in UTC.
const DEADLINE_MS = Date.UTC(2026, 1, 10, 12, 0, 0);
const DAY = '2026-02-10';

const plan = (
  partial: Partial<DeferredObjectivePlanHistoryRevisionSnapshot>,
): DeferredObjectivePlanHistoryRevisionSnapshot => partialDouble<
  DeferredObjectivePlanHistoryRevisionSnapshot
>({ energyNeededKWh: 4, ...partial });

const missed = (
  partial: Partial<DeferredObjectivePlanHistoryRecord> = {},
): DeferredObjectivePlanHistoryRecord => partialDouble<DeferredObjectivePlanHistoryRecord>({
  outcome: 'missed',
  deliveryExplanation: {
    kind: 'recorded',
    primary: { kind: 'blocked', cause: 'budget_limited' },
    contributors: [],
    intervals: [],
  },
  deadlineAtMs: DEADLINE_MS,
  finalPlan: plan({ dailyBudgetExhaustedBucketCount: 3 }),
  originalPlan: null,
  initialEnergyExpectedKWh: 10,
  deliveredKWh: 8,
  ...partial,
});

const resolve = (
  entries: DeferredObjectivePlanHistoryRecord[],
  dateKey = DAY,
): ReturnType<typeof resolveDeadlineMissSuppression> => (
  resolveDeadlineMissSuppression(entries, dateKey, 'UTC')
);

const MINUTE_MS = 60_000;
/** A `control_pending` interval of `minutes` ending `endsBeforeDeadlineMin` before the deadline. */
const settle = (minutes: number, endsBeforeDeadlineMin: number) => ({
  fromMs: DEADLINE_MS - (endsBeforeDeadlineMin + minutes) * MINUTE_MS,
  toMs: DEADLINE_MS - endsBeforeDeadlineMin * MINUTE_MS,
  cause: 'control_pending' as const,
});

describe('resolveDeadlineMissSuppression — which misses count', () => {
  it('counts recorded budget-only delivery blockers without any plan snapshot', () => {
    expect(resolve([missed({ finalPlan: null, originalPlan: null })]))
      .toEqual({ deadlineMissedToBudget: true, deadlineMissDeniedKwh: 2 });
  });

  it('uses recorded budget evidence even when the final plan projected no budget shortfall', () => {
    expect(resolve([missed({
      finalPlan: plan({ floorShortfallCause: 'time_capacity' }),
      originalPlan: plan({ dailyBudgetExhaustedBucketCount: 5 }),
    })]).deadlineMissedToBudget).toBe(true);
  });

  it('does not turn legacy budget-shaped snapshots into proved damage', () => {
    for (const finalPlan of [
      plan({ dailyBudgetExhaustedBucketCount: 3 }),
      plan({ floorShortfallCause: 'budget' }),
      null,
    ]) {
      expect(resolve([missed({
        deliveryExplanation: { kind: 'legacy_unrecorded' },
        finalPlan,
        originalPlan: plan({ floorShortfallCause: 'budget' }),
      })])).toEqual({});
    }
  });

  it('ignores a permitted delivery miss despite budget-shaped snapshots', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [],
      },
      finalPlan: plan({ floorShortfallCause: 'budget' }),
    })])).toEqual({});
  });

  it('excludes a device cutoff even when budget was an earlier contributor', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'device_not_accepting' },
        contributors: ['budget_limited'],
        intervals: [],
      },
    })])).toEqual({});
  });

  it('excludes primary budget control when any other delivery blocker contributed', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['capacity_limited'],
        intervals: [],
      },
    })])).toEqual({});
  });

  it('accepts repeated budget contributors as budget-only evidence', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['budget_limited'],
        intervals: [],
      },
    })]).deadlineMissDeniedKwh).toBe(2);
  });

  it('counts a budget-held run that passed through control settling ticks', () => {
    // The realistic shape: a run held by the budget also crosses restore
    // cooldowns, meter settling and throttled restores, each of which records
    // `control_pending` for a tick. Those are PELS settling its own decision,
    // not a competing cause, so they must not hide the budget miss.
    for (const contributors of [
      ['control_pending'],
      ['control_pending', 'budget_limited'],
      ['budget_limited', 'control_pending'],
    ] as const) {
      expect(resolve([missed({
        deliveryExplanation: {
          kind: 'recorded',
          primary: { kind: 'blocked', cause: 'budget_limited' },
          contributors: [...contributors],
          intervals: [
            { fromMs: DEADLINE_MS - 7_200_000, toMs: DEADLINE_MS - 7_170_000, cause: 'control_pending' },
            { fromMs: DEADLINE_MS - 7_170_000, toMs: DEADLINE_MS, cause: 'budget_limited' },
          ],
        },
      })])).toEqual({ deadlineMissedToBudget: true, deadlineMissDeniedKwh: 2 });
    }
  });

  it('still counts a run with several short settles inside the total bound', () => {
    // Three restore-cooldown-sized settles (5 + 4 + 5 = 14 min) across the run.
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(5, 300), settle(4, 200), settle(5, 100)],
      },
    })])).toEqual({ deadlineMissedToBudget: true, deadlineMissDeniedKwh: 2 });
  });

  it('excludes a run held by a long-lived control_pending, such as a stuck command', () => {
    // A command that never converged for 3 h is a competing cause, not a settle.
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(180, 30)],
      },
    })])).toEqual({});
    // One interval just past the settle bound is enough, even beside short ones.
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(1, 300), settle(6, 100)],
      },
    })])).toEqual({});
  });

  it('excludes a run whose short settles add up to more than the total bound', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(5, 400), settle(5, 300), settle(5, 200), settle(1, 100)],
      },
    })])).toEqual({});
  });

  it('excludes a control_pending contributor with no recorded interval: it cannot be shown short', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [{ fromMs: DEADLINE_MS - 3_600_000, toMs: DEADLINE_MS, cause: 'budget_limited' }],
      },
    })])).toEqual({});
  });

  it('excludes a run whose interval list is full: an evicted stretch could have been long', () => {
    // The recorder keeps the newest 120 intervals; a full window cannot prove every settle was short.
    const intervals = Array.from({ length: 120 }, (_, index) => (index % 2 === 0
      ? { fromMs: DEADLINE_MS - (120 - index) * 60_000, toMs: DEADLINE_MS - (119 - index) * 60_000, cause: 'budget_limited' as const }
      : { fromMs: DEADLINE_MS - (120 - index) * 60_000, toMs: DEADLINE_MS - (120 - index) * 60_000 + 1_000, cause: 'control_pending' as const }));
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals,
      },
    })])).toEqual({});
  });

  it('excludes a run whose intervals record a competing cause its contributor list lacks', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['budget_limited'],
        intervals: [{ fromMs: DEADLINE_MS - 3_600_000, toMs: DEADLINE_MS - 600_000, cause: 'capacity_limited' }],
      },
    })])).toEqual({});
  });

  it('still excludes a run whose settling ticks sit beside a real competing cause', () => {
    const others = ['capacity_limited', 'priority_limited', 'control_failed', 'observation_unavailable'] as const;
    for (const other of others) {
      expect(resolve([missed({
        deliveryExplanation: {
          kind: 'recorded',
          primary: { kind: 'blocked', cause: 'budget_limited' },
          contributors: ['control_pending', 'budget_limited', other],
          intervals: [settle(1, 60)],
        },
      })])).toEqual({});
    }
  });

  it('keeps a run that crossed the upgrade out, even when its recorded tail is budget-only', () => {
    // `legacy_unrecorded` marks an unrecorded stretch whose cause is unknown;
    // no recorded cause cannot establish budget alone.
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['legacy_unrecorded', 'control_pending', 'budget_limited'],
        intervals: [settle(1, 60)],
      },
    })])).toEqual({});
  });

  it('does not let settling ticks stand in for a budget primary', () => {
    expect(resolve([missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'control_pending' },
        contributors: ['budget_limited'],
        intervals: [],
      },
    })])).toEqual({});
  });

  it('ignores non-missed outcomes, other days, and an empty history', () => {
    expect(resolve([missed({ outcome: 'met' })])).toEqual({});
    expect(resolve([missed()], '2026-02-11')).toEqual({});
    expect(resolve([])).toEqual({});
  });
});

describe('resolveDeadlineMissSuppression — what the miss cost', () => {
  it('prices the miss as committed energy less what the run actually delivered', () => {
    expect(resolve([missed({ initialEnergyExpectedKWh: 10, deliveredKWh: 8 })])
      .deadlineMissDeniedKwh).toBe(2);
  });

  it('does NOT price it from the revision snapshot, which shrinks as the run delivers', () => {
    // The final revision's remainder is frozen at the last revision write (at
    // most hourly, only on drift), so reading it would price a nearly-complete
    // run at almost its whole requirement. Committed 10, delivered 9.5 → 0.5,
    // even though the snapshot still claims 6 outstanding.
    const entry = missed({
      initialEnergyExpectedKWh: 10,
      deliveredKWh: 9.5,
      finalPlan: plan({ floorShortfallCause: 'budget', energyNeededKWh: 6, energyExpectedKWh: 6 }),
    });
    expect(resolve([entry]).deadlineMissDeniedKwh).toBeCloseTo(0.5, 5);
  });

  it('treats a run that delivered nothing as owing its whole commitment', () => {
    expect(resolve([missed({ initialEnergyExpectedKWh: 7, deliveredKWh: 0 })])
      .deadlineMissDeniedKwh).toBe(7);
  });

  it('stamps no magnitude when a run over-delivered and still missed', () => {
    // Clamped at zero, and a zero is never stamped: the loop reads this field as
    // evidence to grow on, so a 0 would assert the budget denied nothing.
    expect(resolve([missed({ initialEnergyExpectedKWh: 5, deliveredKWh: 6 })]))
      .toEqual({ deadlineMissedToBudget: true });
  });

  it('declines to price a run whose profile never resolved, recording the miss alone', () => {
    // The contract is explicit: decline the delivered-vs-committed comparison on
    // absence rather than substituting another quantity. The miss is still
    // recorded for the fit; the loop simply gets no energy evidence.
    expect(resolve([missed({ initialEnergyExpectedKWh: undefined, deliveredKWh: 3 })]))
      .toEqual({ deadlineMissedToBudget: true });
  });

  it('declines just as firmly when the DELIVERY total is missing', () => {
    // Absent delivery is not zero delivery. Reading it as none would charge a
    // task that may have received nearly all its energy the whole commitment —
    // up to a full single-day step of pressure on a budget PELS then writes.
    expect(resolve([missed({ initialEnergyExpectedKWh: 9, deliveredKWh: undefined })]))
      .toEqual({ deadlineMissedToBudget: true });
  });

  it('still prices the day from the misses it CAN price', () => {
    const priceable = missed({ initialEnergyExpectedKWh: 6, deliveredKWh: 2 });
    const unpriceable = missed({ initialEnergyExpectedKWh: undefined, deliveredKWh: undefined });
    expect(resolve([priceable, unpriceable]))
      .toEqual({ deadlineMissedToBudget: true, deadlineMissDeniedKwh: 4 });
  });

  it('sums across several budget-bound misses on the same day', () => {
    const one = missed({ initialEnergyExpectedKWh: 4, deliveredKWh: 1 });
    const two = missed({ initialEnergyExpectedKWh: 6, deliveredKWh: 4 });
    expect(resolve([one, two]).deadlineMissDeniedKwh).toBe(5);
  });
});

describe('resolveDeadlineMissSuppression — local-day attribution', () => {
  // Europe/Oslo 2026-10-25 is the 25-hour day: clocks go back at 01:00 UTC, so
  // the local day runs 2026-10-24T22:00Z → 2026-10-25T23:00Z. A miss must be
  // attributed to the day its deadline fell in LOCALLY, or the evidence lands on
  // a day the weather rollup has already closed.
  const resolveOslo = (deadlineAtMs: number, dateKey: string): number | undefined => (
    resolveDeadlineMissSuppression(
      [missed({ deadlineAtMs, initialEnergyExpectedKWh: 5, deliveredKWh: 3 })],
      dateKey,
      'Europe/Oslo',
    ).deadlineMissDeniedKwh
  );

  it('keeps a late-evening deadline on the long day itself', () => {
    // 22:30Z is 23:30 local (UTC+1 after the change) — still 2026-10-25.
    expect(resolveOslo(Date.UTC(2026, 9, 25, 22, 30), '2026-10-25')).toBe(2);
    expect(resolveOslo(Date.UTC(2026, 9, 25, 22, 30), '2026-10-26')).toBeUndefined();
  });

  it('rolls to the next day one hour later, at the true local midnight', () => {
    expect(resolveOslo(Date.UTC(2026, 9, 25, 23, 30), '2026-10-26')).toBe(2);
    expect(resolveOslo(Date.UTC(2026, 9, 25, 23, 30), '2026-10-25')).toBeUndefined();
  });

  it('puts both passes of the repeated 02:30 hour on the same local day', () => {
    // 00:30Z is 02:30 CEST, 01:30Z is 02:30 CET — the hour the clock repeats.
    expect(resolveOslo(Date.UTC(2026, 9, 25, 0, 30), '2026-10-25')).toBe(2);
    expect(resolveOslo(Date.UTC(2026, 9, 25, 1, 30), '2026-10-25')).toBe(2);
  });
});
