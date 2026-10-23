import { getHomeyTimezone } from './homey.ts';

const getDateTimePart = (partsByType: Record<string, string>, type: string): string => partsByType[type] ?? '00';

// Local-clock timestamp in the Homey's timezone, matching the device-detail
// diagnostics formatting so the two advanced sections read consistently.
export const formatActivityTimestamp = (atMs: number): string => {
  if (!Number.isFinite(atMs)) return '';
  const partsByType = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      // `getHomeyTimezone()` can return null; coerce to undefined so the
      // formatter falls back to the runtime default instead of throwing
      // RangeError on a null `timeZone`.
      timeZone: getHomeyTimezone() ?? undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(atMs)).map((part) => [part.type, part.value]),
  );
  const date = [getDateTimePart(partsByType, 'month'), getDateTimePart(partsByType, 'day')].join('-');
  const time = [getDateTimePart(partsByType, 'hour'), getDateTimePart(partsByType, 'minute')].join(':');
  return `${date} ${time}`;
};
