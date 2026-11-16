import { describe, expect, it } from 'vitest';
import {
  changeOverrideDraft, formatActiveOverride, formatOverrideEndLine, formatOverrideSmartTaskCreateNote,
  newOverrideDraft, resolveOverrideDraft, resolveOverrideSmartTaskBoxNote, resolveOverrideSmartTaskNote,
} from '../src/ui/deviceOverrideDraft.ts';

const ZONE = 'Europe/Oslo';
// Monday 16 November 2026, 18:30 in Oslo (UTC+1).
const NOW_MS = Date.UTC(2026, 10, 16, 17, 30);
const HOUR_MS = 60 * 60_000;
const RANGE = { min: 5, max: 35 };

describe('device override draft', () => {
  it('starts from the given temperature, ending in two hours during the day', () => {
    const noonMs = Date.UTC(2026, 10, 16, 11);
    const draft = newOverrideDraft(21.5, noonMs, ZONE);

    expect(draft).toEqual({ temperature: '21.5', end: 'two_hours', date: '2026-11-17', at: '08:00' });
    expect(resolveOverrideDraft(draft, RANGE, noonMs, ZONE)).toEqual({ ok: true, targetC: 21.5, untilMs: noonMs + 2 * HOUR_MS });
  });

  it('ends in the morning when started from mid-afternoon', () => {
    expect(newOverrideDraft(21.5, NOW_MS, ZONE).end).toBe('morning');
    expect(newOverrideDraft(21.5, Date.UTC(2026, 10, 16, 13, 59), ZONE).end).toBe('two_hours');
  });

  it('opens a change on the override\'s own temperature and end time', () => {
    const untilMs = Date.UTC(2026, 10, 18, 20, 30);
    const draft = changeOverrideDraft({ untilMs, setting: { type: 'temperature', targetC: 22 } }, ZONE);

    expect(draft).toEqual({ temperature: '22', end: 'custom', date: '2026-11-18', at: '21:30' });
    expect(resolveOverrideDraft(draft, RANGE, NOW_MS, ZONE)).toEqual({ ok: true, targetC: 22, untilMs });
  });

  it('spells out the end the draft resolves to', () => {
    expect(formatOverrideEndLine(NOW_MS + 2 * HOUR_MS, NOW_MS, ZONE)).toBe('Ends today 20:30');
    expect(formatOverrideEndLine(Date.UTC(2026, 10, 17, 7), NOW_MS, ZONE)).toBe('Ends tomorrow 08:00');
    expect(formatOverrideEndLine(Date.UTC(2026, 10, 22, 17), NOW_MS, ZONE)).toBe('Ends Sun 18:00');
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
    const draft = { ...newOverrideDraft(22, NOW_MS, ZONE), end: 'two_hours' as const, ...patch };

    expect(resolveOverrideDraft(draft, RANGE, NOW_MS, ZONE)).toEqual({ ok: false, error });
  });

  it('names the day only when the override ends on a later day', () => {
    const setting = { type: 'temperature' as const, targetC: 22 };

    expect(formatActiveOverride({ untilMs: NOW_MS + 3 * HOUR_MS, setting }, NOW_MS, ZONE)).toBe('22° until 21:30');
    expect(formatActiveOverride({ untilMs: Date.UTC(2026, 10, 22, 20, 30), setting: { ...setting, targetC: 21.5 } }, NOW_MS, ZONE))
      .toBe('21.5° until Sun 21:30');
  });

  it('says the open Smart task waits, or ends when its ready-by time comes first', () => {
    const untilMs = NOW_MS + 3 * HOUR_MS;

    expect(resolveOverrideSmartTaskNote(untilMs, untilMs + HOUR_MS))
      .toBe('The Smart task on this device waits until the override ends.');
    expect(resolveOverrideSmartTaskNote(untilMs, untilMs - HOUR_MS))
      .toBe('The Smart task on this device ends without running: its ready-by time comes first.');
    expect(resolveOverrideSmartTaskNote(null, untilMs))
      .toBe('The Smart task on this device waits until the override ends.');
  });

  it('tells a new Smart task when the device\'s override ends', () => {
    expect(formatOverrideSmartTaskCreateNote(NOW_MS + 3 * HOUR_MS, NOW_MS, ZONE))
      .toBe('This device has an override until 21:30. '
        + 'A Smart task waits until it ends; one that must be ready before then ends without running.');
  });

  it('tells the Smart task box whether its task waits or ends', () => {
    const untilMs = NOW_MS + 3 * HOUR_MS;
    expect(resolveOverrideSmartTaskBoxNote(untilMs, untilMs + HOUR_MS)).toBe('Waiting for the override to end');
    expect(resolveOverrideSmartTaskBoxNote(untilMs, untilMs - HOUR_MS))
      .toBe('Ends without running: the override lasts past its ready-by time');
  });
});
