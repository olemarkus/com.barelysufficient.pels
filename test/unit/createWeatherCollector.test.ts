import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import {
  buildWeatherBudgetAdjustedTokens,
  deadlineMissedToBudgetOnDay,
  readHubCoordinates,
} from '../../setup/appInit/createWeatherCollector';

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

describe('readHubCoordinates', () => {
  it('returns finite coords from a well-formed geolocation manager', () => {
    const geo = { getLatitude: () => 59.91, getLongitude: () => 10.75 };
    expect(readHubCoordinates(geo)).toEqual({ latitude: 59.91, longitude: 10.75 });
  });

  it('returns undefined when the manager is absent or not an object', () => {
    expect(readHubCoordinates(undefined)).toBeUndefined();
    expect(readHubCoordinates(null)).toBeUndefined();
    expect(readHubCoordinates(42)).toBeUndefined();
  });

  it('returns undefined when the getter methods are missing (no throw)', () => {
    expect(readHubCoordinates({})).toBeUndefined();
    expect(readHubCoordinates({ getLatitude: () => 59.91 })).toBeUndefined();
  });

  it('returns undefined when the coords are non-finite (NaN / non-number)', () => {
    expect(readHubCoordinates({ getLatitude: () => Number.NaN, getLongitude: () => 10.75 })).toBeUndefined();
    expect(readHubCoordinates({ getLatitude: () => 59.91, getLongitude: () => '10.75' })).toBeUndefined();
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
