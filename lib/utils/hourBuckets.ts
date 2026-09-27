import { getTimeZoneOffsetMinutes, getZonedParts } from '../../packages/shared-domain/src/utils/dateUtils';

// Hour boundaries only the runtime draws: the power tracker's UTC hour buckets
// and the price module's local hour starts. Built on the shared date helpers,
// but kept out of shared-domain, which holds what the settings UI reads too.

export function truncateToUtcHour(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0,
  );
}

export function getHourBucketKey(nowMs: number = Date.now()): string {
  const hourStart = truncateToUtcHour(nowMs);
  return new Date(hourStart).toISOString();
}

export function getHourStartInTimeZone(date: Date, timeZone: string): number {
  const { year, month, day, hour } = getZonedParts(date, timeZone);
  const utcHour = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  // Use the offset at the actual instant so repeated fall-back hours resolve to the active occurrence.
  const offsetMinutes = getTimeZoneOffsetMinutes(date, timeZone);
  return utcHour - offsetMinutes * 60 * 1000;
}
