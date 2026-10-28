import { describe, expect, it } from 'vitest';
import type { Schedule } from '../../packages/contracts/src/schedules';
import { dueScheduleOccurrence, nextScheduleOccurrence, scheduleInstant } from '../../lib/schedules/scheduleTime';
import { parseSchedule, scheduleConflict, isScheduleDate } from '../../packages/shared-domain/src/settings/schedules';

const weekly = (at = '02:30'): Schedule => ({
  id: 'night', name: 'Night mode', enabled: true, at,
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] },
  condition: { type: 'any' }, action: { type: 'mode', mode: 'Night' },
});

describe('schedule local occurrences', () => {
  it('skips a nonexistent minute rather than moving it to another time', () => {
    expect(scheduleInstant('2026-03-29', '02:30', 'Europe/Oslo')).toBeUndefined();
    expect(nextScheduleOccurrence(weekly(), Date.parse('2026-03-28T23:00:00Z'), 'Europe/Oslo')?.atMs)
      .toBe(Date.parse('2026-03-30T00:30:00Z'));
  });

  it('uses only the first occurrence of a repeated minute', () => {
    const first = Date.parse('2026-10-25T00:30:00Z');
    expect(scheduleInstant('2026-10-25', '02:30', 'Europe/Oslo')).toBe(first);
    expect(dueScheduleOccurrence(weekly(), first - 15_000, first + 15_000, 'Europe/Oslo')?.atMs).toBe(first);
    expect(dueScheduleOccurrence(weekly(), first + 3_600_000 - 15_000, first + 3_600_000, 'Europe/Oslo'))
      .toBeUndefined();
    expect(nextScheduleOccurrence(weekly(), first, 'Europe/Oslo', '2026-10-25|02:30')?.atMs)
      .toBe(Date.parse('2026-10-26T01:30:00Z'));
  });

  it('finds midnight across a local calendar boundary and skips old outages', () => {
    const midnight = Date.parse('2026-10-27T23:00:00Z');
    expect(dueScheduleOccurrence(weekly('00:00'), midnight - 10_000, midnight + 10_000, 'Europe/Oslo')?.atMs)
      .toBe(midnight);
    expect(dueScheduleOccurrence(weekly('00:00'), midnight - 600_000, midnight + 180_000, 'Europe/Oslo'))
      .toBeUndefined();
  });

  it('does not invent invalid dates or accept non-finite targets and malformed permissions', () => {
    expect(isScheduleDate('2026-02-30')).toBe(false);
    expect(isScheduleDate('2028-02-29')).toBe(true);
    const task = { deviceId: 'car', kind: 'ev_soc', target: Infinity, readyByLocalTime: '07:00' };
    expect(() => parseSchedule({ ...weekly(), action: { type: 'task', task } })).toThrow();
    expect(() => parseSchedule({ ...weekly(), action: { type: 'task', task: { ...task, target: 80,
      exemptFromBudget: 'false' } } })).toThrow();
  });

  it('detects weekly and one-off collisions, while separate task devices can share a time', () => {
    const first = weekly('22:00');
    const second: Schedule = { ...first, id: 'other', repeat: { type: 'once', date: '2026-10-28' } };
    expect(scheduleConflict(second, [first])).toBe(true);
    expect(scheduleConflict({ ...second, enabled: false }, [first])).toBe(false);
    const task: Schedule = { ...first, action: { type: 'task', task: {
      deviceId: 'car', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00',
    } } };
    expect(scheduleConflict({ ...task, id: 'other', action: { type: 'task', task: {
      deviceId: 'second-car',
      kind: 'ev_soc', target: 80, readyByLocalTime: '07:00',
    } } }, [task])).toBe(false);
  });
});
