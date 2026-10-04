import type {
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { isBudgetOnlyMiss } from '../../lib/objectives/deferredObjectives/budgetOnlyMiss';
import { MAX_DELIVERY_INTERVALS } from '../../lib/objectives/deferredObjectives/deliveryEvidence';
import { partialDouble } from '../helpers/partialDouble';

const DEADLINE_MS = Date.UTC(2026, 1, 10, 12, 0, 0);

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
  finalizedAtMs: DEADLINE_MS,
  finalPlan: plan({ dailyBudgetExhaustedBucketCount: 3 }),
  originalPlan: null,
  initialEnergyExpectedKWh: 10,
  deliveredKWh: 8,
  ...partial,
});

const MINUTE_MS = 60_000;
/** A `control_pending` interval of `minutes` ending `endsBeforeDeadlineMin` before the deadline. */
const settle = (minutes: number, endsBeforeDeadlineMin: number) => ({
  fromMs: DEADLINE_MS - (endsBeforeDeadlineMin + minutes) * MINUTE_MS,
  toMs: DEADLINE_MS - endsBeforeDeadlineMin * MINUTE_MS,
  cause: 'control_pending' as const,
});

describe('isBudgetOnlyMiss', () => {
  it('counts recorded budget-only delivery blockers without any plan snapshot', () => {
    expect(isBudgetOnlyMiss(missed({ finalPlan: null, originalPlan: null }))).toBe(true);
  });

  it('uses recorded budget evidence even when the final plan projected no budget shortfall', () => {
    expect(isBudgetOnlyMiss(missed({
      finalPlan: plan({ floorShortfallCause: 'time_capacity' }),
      originalPlan: plan({ dailyBudgetExhaustedBucketCount: 5 }),
    }))).toBe(true);
  });

  it('does not turn legacy budget-shaped snapshots into proved damage', () => {
    for (const finalPlan of [
      plan({ dailyBudgetExhaustedBucketCount: 3 }),
      plan({ floorShortfallCause: 'budget' }),
      null,
    ]) {
      expect(isBudgetOnlyMiss(missed({
        deliveryExplanation: { kind: 'legacy_unrecorded' },
        finalPlan,
        originalPlan: plan({ floorShortfallCause: 'budget' }),
      }))).toBe(false);
    }
  });

  it('ignores a permitted delivery miss despite budget-shaped snapshots', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [],
      },
      finalPlan: plan({ floorShortfallCause: 'budget' }),
    }))).toBe(false);
  });

  it('excludes a device cutoff even when budget was an earlier contributor', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'device_not_accepting' },
        contributors: ['budget_limited'],
        intervals: [],
      },
    }))).toBe(false);
  });

  it('excludes primary budget control when any other delivery blocker contributed', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['capacity_limited'],
        intervals: [],
      },
    }))).toBe(false);
  });

  it('accepts repeated budget contributors as budget-only evidence', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['budget_limited'],
        intervals: [],
      },
    }))).toBe(true);
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
      expect(isBudgetOnlyMiss(missed({
        deliveryExplanation: {
          kind: 'recorded',
          primary: { kind: 'blocked', cause: 'budget_limited' },
          contributors: [...contributors],
          intervals: [
            { fromMs: DEADLINE_MS - 7_200_000, toMs: DEADLINE_MS - 7_170_000, cause: 'control_pending' },
            { fromMs: DEADLINE_MS - 7_170_000, toMs: DEADLINE_MS, cause: 'budget_limited' },
          ],
        },
      }))).toBe(true);
    }
  });

  it('still counts a run with several short settles inside the total bound', () => {
    // Three restore-cooldown-sized settles (5 + 4 + 5 = 14 min) across the run.
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(5, 300), settle(4, 200), settle(5, 100)],
      },
    }))).toBe(true);
  });

  it('excludes a run held by a long-lived control_pending, such as a stuck command', () => {
    // A command that never converged for 3 h is a competing cause, not a settle.
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(180, 30)],
      },
    }))).toBe(false);
    // One interval just past the settle bound is enough, even beside short ones.
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(1, 300), settle(6, 100)],
      },
    }))).toBe(false);
  });

  it('excludes a run whose short settles add up to more than the total bound', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [settle(5, 400), settle(5, 300), settle(5, 200), settle(1, 100)],
      },
    }))).toBe(false);
  });

  it('excludes a control_pending contributor with no recorded interval: it cannot be shown short', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: [{ fromMs: DEADLINE_MS - 3_600_000, toMs: DEADLINE_MS, cause: 'budget_limited' }],
      },
    }))).toBe(false);
  });

  it('excludes a run whose interval list is full: an evicted stretch could have been long', () => {
    // The recorder keeps only the newest MAX_DELIVERY_INTERVALS intervals; a
    // full window cannot prove every settle was short.
    const n = MAX_DELIVERY_INTERVALS;
    const intervals = Array.from({ length: n }, (_, index) => (index % 2 === 0
      ? { fromMs: DEADLINE_MS - (n - index) * 60_000, toMs: DEADLINE_MS - (n - 1 - index) * 60_000, cause: 'budget_limited' as const }
      : { fromMs: DEADLINE_MS - (n - index) * 60_000, toMs: DEADLINE_MS - (n - index) * 60_000 + 1_000, cause: 'control_pending' as const }));
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals,
      },
    }))).toBe(false);
    // One interval short of full, the same short settles qualify: the window
    // bound, not the settles, is what ruled the full list out.
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['control_pending', 'budget_limited'],
        intervals: intervals.slice(1),
      },
    }))).toBe(true);
  });

  it('excludes a run whose intervals record a competing cause its contributor list lacks', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['budget_limited'],
        intervals: [{ fromMs: DEADLINE_MS - 3_600_000, toMs: DEADLINE_MS - 600_000, cause: 'capacity_limited' }],
      },
    }))).toBe(false);
  });

  it('still excludes a run whose settling ticks sit beside a real competing cause', () => {
    const others = ['capacity_limited', 'priority_limited', 'control_failed', 'observation_unavailable'] as const;
    for (const other of others) {
      expect(isBudgetOnlyMiss(missed({
        deliveryExplanation: {
          kind: 'recorded',
          primary: { kind: 'blocked', cause: 'budget_limited' },
          contributors: ['control_pending', 'budget_limited', other],
          intervals: [settle(1, 60)],
        },
      }))).toBe(false);
    }
  });

  it('keeps a run that crossed the upgrade out, even when its recorded tail is budget-only', () => {
    // `legacy_unrecorded` marks an unrecorded stretch whose cause is unknown;
    // no recorded cause cannot establish budget alone.
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'budget_limited' },
        contributors: ['legacy_unrecorded', 'control_pending', 'budget_limited'],
        intervals: [settle(1, 60)],
      },
    }))).toBe(false);
  });

  it('does not let settling ticks stand in for a budget primary', () => {
    expect(isBudgetOnlyMiss(missed({
      deliveryExplanation: {
        kind: 'recorded',
        primary: { kind: 'blocked', cause: 'control_pending' },
        contributors: ['budget_limited'],
        intervals: [],
      },
    }))).toBe(false);
  });

  it('is never true for a run that did not miss', () => {
    for (const outcome of ['met', 'abandoned'] as const) {
      expect(isBudgetOnlyMiss(missed({ outcome }))).toBe(false);
    }
  });
});
