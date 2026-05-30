import {
  getDateKeyInTimeZone,
  getTimeZoneOffsetMinutes,
  getZonedParts,
  shiftDateKey,
} from '../../utils/dateUtils';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export type DeferredObjectiveDeadlineResolution = {
  deadlineAtMs: number;
  localDateKey: string;
  rollsToNextDay: boolean;
} | {
  deadlineAtMs: null;
  localDateKey: string;
  rollsToNextDay: boolean;
};

export const resolveDeferredObjectiveDeadline = (params: {
  nowMs: number;
  timeZone: string;
  deadlineLocalTime: string;
}): DeferredObjectiveDeadlineResolution => {
  const { nowMs, timeZone, deadlineLocalTime } = params;
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const todayDeadline = resolveLocalDateTimeMs({
    dateKey: todayKey,
    localTime: deadlineLocalTime,
    timeZone,
    earliestAfterMs: nowMs,
  });
  if (typeof todayDeadline === 'number' && todayDeadline > nowMs) {
    return {
      deadlineAtMs: todayDeadline,
      localDateKey: todayKey,
      rollsToNextDay: false,
    };
  }

  const tomorrowKey = shiftDateKey(todayKey, 1);
  return {
    deadlineAtMs: resolveLocalDateTimeMs({
      dateKey: tomorrowKey,
      localTime: deadlineLocalTime,
      timeZone,
    }),
    localDateKey: tomorrowKey,
    rollsToNextDay: true,
  };
};

/**
 * Format an absolute deadline timestamp back to a local HH:mm string in the given timezone.
 * Used as a display helper for log fields and flow-card tokens that historically referenced
 * deadlineLocalTime — the persisted shape is now absolute, but the display string still has
 * value for users.
 */
export const formatDeadlineLocalTime = (deadlineAtMs: number, timeZone: string): string => {
  if (!Number.isFinite(deadlineAtMs)) return '';
  const parts = getZonedParts(new Date(deadlineAtMs), timeZone);
  const hh = String(parts.hour).padStart(2, '0');
  const mm = String(parts.minute).padStart(2, '0');
  return `${hh}:${mm}`;
};

const resolveLocalDateTimeMs = (params: {
  dateKey: string;
  localTime: string;
  timeZone: string;
  earliestAfterMs?: number;
}): number | null => {
  const candidates = resolveAllLocalDateTimeMs(params);
  return candidates.find((candidateMs) => (
    params.earliestAfterMs === undefined
    || candidateMs > params.earliestAfterMs
  )) ?? null;
};

const resolveAllLocalDateTimeMs = (params: {
  dateKey: string;
  localTime: string;
  timeZone: string;
}): number[] => {
  const { dateKey, localTime, timeZone } = params;
  const dateParts = parseDateKey(dateKey);
  const timeParts = parseLocalTime(localTime);
  if (!dateParts || !timeParts) return [];

  const target = {
    ...dateParts,
    ...timeParts,
    second: 0,
  };
  const approximateUtcMs = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    0,
    0,
  );
  return resolveLocalDateTimeCandidates({
    approximateUtcMs,
    target,
    timeZone,
  });
};

const resolveLocalDateTimeCandidates = (params: {
  approximateUtcMs: number;
  target: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
  timeZone: string;
}): number[] => {
  const { approximateUtcMs, target, timeZone } = params;
  const offsets = collectCandidateOffsets(approximateUtcMs, timeZone);
  const candidates = new Set<number>();
  for (const offsetMinutes of offsets) {
    const candidateMs = approximateUtcMs - offsetMinutes * MINUTE_MS;
    if (matchesLocalTarget(candidateMs, target, timeZone)) {
      candidates.add(candidateMs);
    }
  }
  return [...candidates].sort((left, right) => left - right);
};

const collectCandidateOffsets = (approximateUtcMs: number, timeZone: string): Set<number> => {
  const offsets = new Set<number>();
  for (const probeDeltaMs of [-36 * HOUR_MS, -12 * HOUR_MS, 0, 12 * HOUR_MS, 36 * HOUR_MS]) {
    const probeMs = approximateUtcMs + probeDeltaMs;
    const offset = getTimeZoneOffsetMinutes(new Date(probeMs), timeZone);
    offsets.add(offset);
    const candidateMs = approximateUtcMs - offset * MINUTE_MS;
    offsets.add(getTimeZoneOffsetMinutes(new Date(candidateMs), timeZone));
  }
  return offsets;
};

const matchesLocalTarget = (
  candidateMs: number,
  target: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string,
): boolean => {
  const parts = getZonedParts(new Date(candidateMs), timeZone);
  return (
    parts.year === target.year
    && parts.month === target.month
    && parts.day === target.day
    && parts.hour === target.hour
    && parts.minute === target.minute
    && parts.second === target.second
  );
};

const parseDateKey = (dateKey: string): { year: number; month: number; day: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
};

const parseLocalTime = (localTime: string): { hour: number; minute: number } | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(localTime);
  if (!match) return null;
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};
