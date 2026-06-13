import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import { deadlineMissedToBudgetOnDay } from '../../setup/appInit/createWeatherCollector';

// 2026-02-10T12:00Z → local day "2026-02-10" in UTC.
const DEADLINE_MS = Date.UTC(2026, 1, 10, 12, 0, 0);

type Entry = {
  outcome: string;
  deadlineAtMs: number;
  finalPlan: { dailyBudgetExhaustedBucketCount?: number } | null;
  originalPlan: { dailyBudgetExhaustedBucketCount?: number } | null;
};

const recorderWith = (entries: Entry[]): DeferredObjectivePlanHistoryRecorder => ({
  getHistorySnapshot: () => ({ version: 4, entries }),
} as unknown as DeferredObjectivePlanHistoryRecorder);

const missed = (overrides: Partial<Entry> = {}): Entry => ({
  outcome: 'missed',
  deadlineAtMs: DEADLINE_MS,
  finalPlan: { dailyBudgetExhaustedBucketCount: 3 },
  originalPlan: null,
  ...overrides,
});

describe('deadlineMissedToBudgetOnDay', () => {
  it('is true for a missed task whose FINAL plan saw the budget exhausted on that day', () => {
    expect(deadlineMissedToBudgetOnDay(recorderWith([missed()]), '2026-02-10', 'UTC')).toBe(true);
  });

  it('does NOT resurrect a stale positive count from originalPlan when finalPlan ran clean', () => {
    // finalPlan present but no exhausted buckets (field omitted when zero);
    // originalPlan carried a positive count from an earlier richer schedule.
    const entry = missed({
      finalPlan: {},
      originalPlan: { dailyBudgetExhaustedBucketCount: 5 },
    });
    expect(deadlineMissedToBudgetOnDay(recorderWith([entry]), '2026-02-10', 'UTC')).toBe(false);
  });

  it('falls back to originalPlan only when finalPlan is wholly absent (unrevised run)', () => {
    const entry = missed({ finalPlan: null, originalPlan: { dailyBudgetExhaustedBucketCount: 2 } });
    expect(deadlineMissedToBudgetOnDay(recorderWith([entry]), '2026-02-10', 'UTC')).toBe(true);
  });

  it('ignores non-missed outcomes and other days, and a missing recorder', () => {
    expect(deadlineMissedToBudgetOnDay(recorderWith([missed({ outcome: 'met' })]), '2026-02-10', 'UTC')).toBe(false);
    expect(deadlineMissedToBudgetOnDay(recorderWith([missed()]), '2026-02-11', 'UTC')).toBe(false);
    expect(deadlineMissedToBudgetOnDay(undefined, '2026-02-10', 'UTC')).toBe(false);
  });
});
