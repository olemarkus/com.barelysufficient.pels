import { getTimeZoneOffsetMinutes, getZonedParts, getDateKeyInTimeZone } from './utils/dateUtils';

const MINUTE_MS = 60_000;

/** A gap has no occurrence; a repeated local minute has only its first occurrence. */
export const scheduleInstant = (date: string, at: string, timeZone: string): number | undefined => {
  const approximate = Date.parse(`${date}T${at}:00Z`);
  const offsets = new Set([-36, -12, 0, 12, 36].map((hours) => (
    getTimeZoneOffsetMinutes(new Date(approximate + hours * 3_600_000), timeZone)
  )));
  const candidates: number[] = [];
  for (const offset of offsets) {
    const instant = approximate - offset * MINUTE_MS;
    const parts = getZonedParts(new Date(instant), timeZone);
    const clock = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    if (getDateKeyInTimeZone(new Date(instant), timeZone) === date && clock === at) candidates.push(instant);
  }
  return candidates.sort((a, b) => a - b)[0];
};
