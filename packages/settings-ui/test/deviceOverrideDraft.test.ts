import { describe, expect, it } from 'vitest';
import {
  formatActiveOverride, newOverrideDraft, resolveOverrideDraft,
} from '../src/ui/deviceOverrideDraft.ts';

const ZONE = 'Europe/Oslo';
// Monday 16 November 2026, 18:30 in Oslo (UTC+1).
const NOW_MS = Date.UTC(2026, 10, 16, 17, 30);
const HOUR_MS = 60 * 60_000;
const RANGE = { min: 5, max: 35 };

describe('device override draft', () => {
  it('starts from the given temperature, ending in two hours', () => {
    const draft = newOverrideDraft(21.5, NOW_MS, ZONE);

    expect(draft).toEqual({ temperature: '21.5', end: 'two_hours', date: '2026-11-17', at: '08:00' });
    expect(resolveOverrideDraft(draft, RANGE, NOW_MS, ZONE)).toEqual({ ok: true, targetC: 21.5, untilMs: NOW_MS + 2 * HOUR_MS });
  });

  it('ends at the next 08:00 in the Homey time zone', () => {
    const evening = { ...newOverrideDraft(22, NOW_MS, ZONE), end: 'morning' as const };
    expect(resolveOverrideDraft(evening, RANGE, NOW_MS, ZONE)).toEqual({ ok: true, targetC: 22, untilMs: Date.UTC(2026, 10, 17, 7) });

    const earlyMs = Date.UTC(2026, 10, 16, 5);
    expect(resolveOverrideDraft(evening, RANGE, earlyMs, ZONE)).toEqual({ ok: true, targetC: 22, untilMs: Date.UTC(2026, 10, 16, 7) });
  });

  it('ends at a picked date and time', () => {
    const draft = { ...newOverrideDraft(22, NOW_MS, ZONE), end: 'custom' as const, date: '2026-11-18', at: '21:30' };

    expect(resolveOverrideDraft(draft, RANGE, NOW_MS, ZONE)).toEqual({ ok: true, targetC: 22, untilMs: Date.UTC(2026, 10, 18, 20, 30) });
  });

  it.each([
    ['an empty temperature', { temperature: '' }, 'Enter a temperature from 5 to 35 °C.'],
    ['a temperature outside the device range', { temperature: '40' }, 'Enter a temperature from 5 to 35 °C.'],
    ['an end time that has passed', { end: 'custom', date: '2026-11-16', at: '12:00' }, 'Choose an end time in the future.'],
    ['an end time more than seven days ahead', { end: 'custom', date: '2026-11-24', at: '08:00' }, 'Choose an end time within seven days.'],
    ['a missing date', { end: 'custom', date: '' }, 'Choose a date and time that exists in the Homey time zone.'],
  ] as const)('asks the owner to correct %s', (_label, patch, error) => {
    const draft = { ...newOverrideDraft(22, NOW_MS, ZONE), ...patch };

    expect(resolveOverrideDraft(draft, RANGE, NOW_MS, ZONE)).toEqual({ ok: false, error });
  });

  it('names the day only when the override ends on a later day', () => {
    const setting = { type: 'temperature' as const, targetC: 22 };

    expect(formatActiveOverride({ untilMs: NOW_MS + 3 * HOUR_MS, setting }, NOW_MS, ZONE)).toBe('22° until 21:30');
    expect(formatActiveOverride({ untilMs: Date.UTC(2026, 10, 22, 20, 30), setting: { ...setting, targetC: 21.5 } }, NOW_MS, ZONE))
      .toBe('21.5° until Sun 21:30');
  });
});
