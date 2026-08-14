import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import {
  buildWeatherBudgetAdjustedTokens,
  deadlineMissedToBudgetOnDay,
} from '../../setup/appInit/createWeatherCollector';

// 2026-02-10T12:00Z → local day "2026-02-10" in UTC.
const DEADLINE_MS = Date.UTC(2026, 1, 10, 12, 0, 0);

type Snapshot = {
  dailyBudgetExhaustedBucketCount?: number;
  floorShortfallCause?: string;
};
type Entry = {
  outcome: string;
  deadlineAtMs: number;
  finalPlan: Snapshot | null;
  originalPlan: Snapshot | null;
};

const recorderWith = (entries: Entry[]): DeferredObjectivePlanHistoryRecorder => ({
  getHistorySnapshot: () => ({ version: 5, entries }),
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

  it('censors a miss attributed by floorShortfallCause, the signal new entries carry', () => {
    // The retired `dailyBudgetExhaustedBucketCount` is no longer written, so
    // everything finalized from now on arrives with `floorShortfallCause`
    // instead. Missing this is not a cosmetic history gap: the day stops being
    // censored out of the weather energy-signature fit and a deliberately
    // withheld day biases the auto-applied daily budget.
    const entry = missed({ finalPlan: { floorShortfallCause: 'budget' } });
    expect(deadlineMissedToBudgetOnDay(recorderWith([entry]), '2026-02-10', 'UTC')).toBe(true);
  });

  it('does not censor a miss attributed to a non-budget cause', () => {
    const entry = missed({ finalPlan: { floorShortfallCause: 'time_capacity' } });
    expect(deadlineMissedToBudgetOnDay(recorderWith([entry]), '2026-02-10', 'UTC')).toBe(false);
  });

  it('ignores non-missed outcomes and other days, and a missing recorder', () => {
    expect(deadlineMissedToBudgetOnDay(recorderWith([missed({ outcome: 'met' })]), '2026-02-10', 'UTC')).toBe(false);
    expect(deadlineMissedToBudgetOnDay(recorderWith([missed()]), '2026-02-11', 'UTC')).toBe(false);
    expect(deadlineMissedToBudgetOnDay(undefined, '2026-02-10', 'UTC')).toBe(false);
  });
});

describe('buildWeatherBudgetAdjustedTokens', () => {
  it('rounds the budget to 0.1 kWh and the forecast temp to whole °C', () => {
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: 71.96, forecastMeanTempC: -4.6 }))
      .toEqual({ budget_kwh: 72, forecast_temperature: -5 });
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: 48.25, forecastMeanTempC: 3.2 }))
      .toEqual({ budget_kwh: 48.3, forecast_temperature: 3 });
  });

  it('returns null on a non-finite value (never fire a misleading 0)', () => {
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: Number.NaN, forecastMeanTempC: -4 })).toBeNull();
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: 72, forecastMeanTempC: Number.POSITIVE_INFINITY }))
      .toBeNull();
  });
});
