import { describe, expect, it } from 'vitest';
import { formatTypicalDayLine } from '../packages/shared-domain/src/usageVoice.ts';

describe('formatTypicalDayLine', () => {
  it('names the day-of-week so the comparison reads as story, not table', () => {
    // Sunday = 0
    expect(formatTypicalDayLine(0, 14.2)).toBe('Your typical Sunday runs 14.2 kWh.');
    // Monday = 1
    expect(formatTypicalDayLine(1, 13.8)).toBe('Your typical Monday runs 13.8 kWh.');
    // Saturday = 6
    expect(formatTypicalDayLine(6, 16.5)).toBe('Your typical Saturday runs 16.5 kWh.');
  });

  it('formats non-finite kWh as -- so we never emit "NaN kWh"', () => {
    expect(formatTypicalDayLine(2, Number.NaN)).toBe('Your typical Tuesday runs -- kWh.');
  });

  it('falls back to "day" for out-of-range weekday indices', () => {
    expect(formatTypicalDayLine(99, 10)).toBe('Your typical day runs 10.0 kWh.');
  });
});
