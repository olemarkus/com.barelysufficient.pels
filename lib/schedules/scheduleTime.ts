import { scheduleInstant } from '../../packages/shared-domain/src/scheduleTime';
export { scheduleInstant };
import { scheduleWeekday } from '../../packages/shared-domain/src/settings/schedules';
import type { Schedule } from '../../packages/contracts/src/schedules';
import {
  getDateKeyInTimeZone,
  shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';

export type ScheduleOccurrence = { key: string; atMs: number };
const MINUTE_MS = 60_000;

const occursOn = (schedule: Schedule, date: string): boolean => schedule.repeat.type === 'once'
  ? schedule.repeat.date === date
  : schedule.repeat.days.includes(scheduleWeekday(date));

const occurrenceOn = (schedule: Schedule, date: string, timeZone: string): ScheduleOccurrence | undefined => {
  if (!occursOn(schedule, date)) return undefined;
  const atMs = scheduleInstant(date, schedule.at, timeZone);
  return atMs === undefined ? undefined : { key: `${date}|${schedule.at}`, atMs };
};

export const nextScheduleOccurrence = (
  schedule: Schedule,
  afterMs: number,
  timeZone: string,
  consumedKey = '',
): ScheduleOccurrence | undefined => {
  const today = getDateKeyInTimeZone(new Date(afterMs), timeZone);
  const dates = schedule.repeat.type === 'once'
    ? [schedule.repeat.date]
    : Array.from({ length: 9 }, (_, index) => shiftDateKey(today, index));
  for (const date of dates) {
    const occurrence = occurrenceOn(schedule, date, timeZone);
    if (occurrence && occurrence.atMs > afterMs && occurrence.key > consumedKey) return occurrence;
  }
  return undefined;
};

export const dueScheduleOccurrence = (
  schedule: Schedule,
  afterMs: number,
  nowMs: number,
  timeZone: string,
  consumedKey = '',
): ScheduleOccurrence | undefined => {
  if (nowMs < afterMs) return undefined;
  const since = Math.max(afterMs, nowMs - 2 * MINUTE_MS);
  const firstDate = getDateKeyInTimeZone(new Date(since), timeZone);
  const lastDate = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const dates = firstDate === lastDate ? [firstDate] : [firstDate, lastDate];
  for (const date of dates) {
    const occurrence = occurrenceOn(schedule, date, timeZone);
    if (occurrence && occurrence.atMs > since && occurrence.atMs <= nowMs && occurrence.key > consumedKey) {
      return occurrence;
    }
  }
  return undefined;
};
