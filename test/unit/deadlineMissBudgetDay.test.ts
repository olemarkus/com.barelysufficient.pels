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

describe('resolveDeadlineMissSuppression — which misses count', () => {
  it('counts a miss whose FINAL plan saw the budget exhausted on that day', () => {
    expect(resolve([missed()]).deadlineMissedToBudget).toBe(true);
  });

  it('does NOT resurrect a stale positive count from originalPlan when finalPlan ran clean', () => {
    // finalPlan present but no exhausted buckets (field omitted when zero);
    // originalPlan carried a positive count from an earlier richer schedule.
    expect(resolve([missed({
      finalPlan: plan({}),
      originalPlan: plan({ dailyBudgetExhaustedBucketCount: 5 }),
    })])).toEqual({});
  });

  it('falls back to originalPlan only when finalPlan is wholly absent (unrevised run)', () => {
    expect(resolve([missed({
      finalPlan: null,
      originalPlan: plan({ dailyBudgetExhaustedBucketCount: 2 }),
    })]).deadlineMissedToBudget).toBe(true);
  });

  it('counts a miss attributed by floorShortfallCause, the signal new entries carry', () => {
    expect(resolve([missed({ finalPlan: plan({ floorShortfallCause: 'budget' }) })])
      .deadlineMissedToBudget).toBe(true);
  });

  it('ignores a miss attributed to a non-budget cause', () => {
    expect(resolve([missed({ finalPlan: plan({ floorShortfallCause: 'time_capacity' }) })]))
      .toEqual({});
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
