import { isDailyBudgetState } from '../lib/dailyBudget/dailyBudgetManagerTypes';

describe('daily budget manager state guard', () => {
  it('accepts a minimal valid state', () => {
    expect(isDailyBudgetState({})).toBe(true);
  });

  it('rejects plannedKWh containing non-finite values', () => {
    const state = {
      plannedKWh: [1, Number.NaN, 3],
    };
    expect(isDailyBudgetState(state)).toBe(false);
  });

  it('rejects profile weights containing non-finite values', () => {
    const state = {
      profile: {
        weights: [Number.NaN, ...Array.from({ length: 23 }, () => 0)],
        sampleCount: 1,
      },
    };
    expect(isDailyBudgetState(state)).toBe(false);
  });

  it('rejects non-finite profile sample counts', () => {
    const state = {
      profile: {
        weights: Array.from({ length: 24 }, () => 0),
        sampleCount: Number.NaN,
      },
    };
    expect(isDailyBudgetState(state)).toBe(false);
  });

  it('rejects invalid date fields', () => {
    expect(isDailyBudgetState({ dateKey: 123 })).toBe(false);
    expect(isDailyBudgetState({ dayStartUtcMs: Number.NaN })).toBe(false);
  });

  it('validates uncontrolled reserve profile arrays', () => {
    expect(isDailyBudgetState({
      profileObservedP50UncontrolledKWh: Array.from({ length: 24 }, () => 1),
      profileObservedP75UncontrolledKWh: Array.from({ length: 24 }, () => 2),
      profileObservedP90UncontrolledKWh: Array.from({ length: 24 }, () => 3),
      profileObservedUncontrolledSampleCounts: Array.from({ length: 24 }, () => 30),
    })).toBe(true);
    expect(isDailyBudgetState({
      profileObservedP50UncontrolledKWh: [1, 2],
    })).toBe(false);
  });
});
