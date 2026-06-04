import {
  formatStarvationBadge,
  formatStarvationReason,
  summarizeStarvation,
} from '../../packages/shared-domain/src/planStarvation';

describe('planStarvation', () => {
  it('returns null when starvation is missing or inactive', () => {
    expect(formatStarvationBadge(undefined)).toBeNull();
    expect(formatStarvationBadge({
      isStarved: false,
      accumulatedMs: 0,
      cause: 'capacity',
      startedAtMs: null,
    })).toBeNull();
    expect(formatStarvationReason(undefined)).toBeNull();
  });

  it('formats a capacity-starvation badge and reason', () => {
    const starvation = {
      isStarved: true,
      accumulatedMs: 23 * 60 * 1000,
      cause: 'capacity' as const,
      startedAtMs: Date.UTC(2026, 3, 20, 11, 0, 0),
    };

    expect(formatStarvationBadge(starvation)).toEqual({
      label: 'Low power',
      tone: 'warn',
      tooltip: 'Waiting for available power',
    });
    expect(formatStarvationReason(starvation)).toBe('Waiting for available power');
  });

  it('formats a budget-starvation badge with a softer info tone', () => {
    expect(formatStarvationBadge({
      isStarved: true,
      accumulatedMs: 12 * 60 * 1000,
      cause: 'budget',
      startedAtMs: null,
    })).toEqual({
      label: 'Budget limited',
      tone: 'info',
      tooltip: "Limited to stay within today's budget",
    });
    expect(formatStarvationReason({
      isStarved: true,
      accumulatedMs: 12 * 60 * 1000,
      cause: 'budget',
      startedAtMs: null,
    })).toBe("Limited to stay within today's budget");
  });

  it('summarizes all starved devices in the hero', () => {
    expect(summarizeStarvation([
      { starvation: null },
      {
        starvation: {
          isStarved: true,
          accumulatedMs: 20 * 60 * 1000,
          cause: 'capacity',
          startedAtMs: null,
        },
      },
      {
        starvation: {
          isStarved: true,
          accumulatedMs: 20 * 60 * 1000,
          cause: 'budget',
          startedAtMs: null,
        },
      },
    ])).toBe('2 devices limited');

    expect(summarizeStarvation([
      {
        starvation: {
          isStarved: true,
          accumulatedMs: 20 * 60 * 1000,
          cause: 'capacity',
          startedAtMs: null,
        },
      },
      {
        starvation: {
          isStarved: true,
          accumulatedMs: 10 * 60 * 1000,
          cause: 'capacity',
          startedAtMs: null,
        },
      },
    ])).toBe('2 devices limited');
  });
});
