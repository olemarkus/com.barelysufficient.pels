import { describe, expect, it } from 'vitest';
import { formatDayFirstInTimeZone } from '../../packages/shared-domain/src/utils/dateUtils';

// The one day-first ("Fri 15 May") English-pinned Usage-tab date grammar. The
// copy-sweep's own goal — one day-first grammar across every Usage-tab date
// label — stayed only partly met because the week-chart, solar-row, and
// daily-history producers formatted with a default-locale formatter; CI ran
// green through the gap because nothing pinned the grammar. This pins the
// shared helper all six routes now share.
describe('formatDayFirstInTimeZone', () => {
  it('renders day before month, never month-first, regardless of host locale', () => {
    const label = formatDayFirstInTimeZone(
      new Date('2026-05-15T10:00:00.000Z'),
      { weekday: 'short', day: 'numeric', month: 'short' },
      'UTC',
    );
    expect(label).toContain('15 May');
    expect(label).not.toContain('May 15');
    expect(label.indexOf('15')).toBeLessThan(label.indexOf('May'));
  });

  it('formats a bare day–month component day-first', () => {
    expect(
      formatDayFirstInTimeZone(new Date('2026-04-28T10:00:00.000Z'), { day: 'numeric', month: 'short' }, 'UTC'),
    ).toBe('28 Apr');
  });

  it('honours the requested time zone at a day boundary', () => {
    // 2026-06-04T02:00Z is still 3 Jun in America/New_York (UTC-4).
    expect(
      formatDayFirstInTimeZone(
        new Date('2026-06-04T02:00:00.000Z'),
        { day: 'numeric', month: 'short' },
        'America/New_York',
      ),
    ).toBe('3 Jun');
  });
});
