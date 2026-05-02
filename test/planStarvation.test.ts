import {
  formatStarvationBadge,
  formatStarvationReason,
  summarizeStarvation,
} from '../packages/shared-domain/src/planStarvation';

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
      label: 'Starved 23m',
      tone: 'warn',
      tooltip: 'Below target for 23 min while waiting for room to reopen',
    });
    expect(formatStarvationReason(starvation)).toBe('Waiting for room to reopen — 23 min below target');
  });

  it('maps budget/manual/external starvation to softer tones', () => {
    expect(formatStarvationBadge({
      isStarved: true,
      accumulatedMs: 12 * 60 * 1000,
      cause: 'budget',
      startedAtMs: null,
    })?.tone).toBe('info');
    expect(formatStarvationBadge({
      isStarved: true,
      accumulatedMs: 12 * 60 * 1000,
      cause: 'manual',
      startedAtMs: null,
    })?.tone).toBe('muted');
    expect(formatStarvationReason({
      isStarved: true,
      accumulatedMs: 12 * 60 * 1000,
      cause: 'external',
      startedAtMs: null,
    })).toBe('External recovery is still pending — 12 min below target');
  });

  it('summarizes only capacity-caused starvation in the hero', () => {
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
    ])).toBe('1 device below target');

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
    ])).toBe('2 devices below target');
  });
});
