import {
  formatStarvationBadge,
  formatStarvationReason,
} from '../../packages/shared-domain/src/planStarvation';

describe('planStarvation', () => {
  it('returns null when starvation is missing or inactive', () => {
    expect(formatStarvationBadge(undefined)).toBeNull();
    expect(formatStarvationBadge({
      isStarved: false,
      accumulatedMs: 0,
    })).toBeNull();
    expect(formatStarvationReason(undefined)).toBeNull();
  });

  // One starved state, one badge. The `Budget limited` / `Low power` pair it
  // replaced keyed off a bucket that was overwritten on every accumulation tick,
  // so a device holding steady could swap badge and tone between two cycles
  // without anything about it changing.
  it('formats one badge and reason for every held-back device', () => {
    const starvation = {
      isStarved: true,
      accumulatedMs: 23 * 60 * 1000,
    };

    expect(formatStarvationBadge(starvation)).toEqual({
      label: 'Held back',
      tone: 'warn',
      tooltip: 'Waiting for available power',
    });
    expect(formatStarvationReason(starvation)).toBe('Waiting for available power');
  });

  it('names no ceiling in the badge — the hero states that once', () => {
    const badge = formatStarvationBadge({
      isStarved: true,
      accumulatedMs: 12 * 60 * 1000,
    });
    expect(badge).not.toBeNull();
    expect(`${badge!.label} ${badge!.tooltip}`.toLowerCase()).not.toMatch(/budget|hard cap/);
  });
});
