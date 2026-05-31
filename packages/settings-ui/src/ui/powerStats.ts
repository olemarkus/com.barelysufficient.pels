import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getMonthStartInTimeZone,
  getStartOfDayInTimeZone,
  getWeekStartInTimeZone,
  getZonedParts,
} from './timezone.ts';

export type HourlyPatternPoint = { hour: number; avg: number };
export type DailyHistoryPoint = { date: string; kWh: number };

export type PowerStatsSummary = {
  today: number;
  week: number;
  month: number;
  weekdayAvg: number;
  weekendAvg: number;
  hourlyPatternAll: HourlyPatternPoint[];
  hourlyPatternWeekday: HourlyPatternPoint[];
  hourlyPatternWeekend: HourlyPatternPoint[];
  hourlyPatternMeta: string;
  dailyHistory: DailyHistoryPoint[];
  hasPatternData: boolean;
};

const DAILY_HISTORY_DAYS = 14;

export const getEmptyPowerStats = (): PowerStatsSummary => ({
  today: 0,
  week: 0,
  month: 0,
  weekdayAvg: 0,
  weekendAvg: 0,
  hourlyPatternAll: [],
  hourlyPatternWeekday: [],
  hourlyPatternWeekend: [],
  hourlyPatternMeta: 'Average kWh per hour based on historical data.',
  dailyHistory: [],
  hasPatternData: false,
});

const getDerivedDailyTotals = (buckets: Record<string, number> | undefined, timeZone: string) => {
  const totals: Record<string, number> = {};
  if (!buckets) return totals;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const dateKey = getDateKeyInTimeZone(new Date(iso), timeZone);
    totals[dateKey] = (totals[dateKey] || 0) + kWh;
  }
  return totals;
};

// Persisted `dailyTotals` only ever holds days that have aged out of the 30-day
// hourly retention window in `lib/power/tracker.ts` (`aggregateAndPruneHistory`).
// Recent days still live exclusively in `tracker.buckets`, so taking
// `tracker.dailyTotals` as the source of truth makes the Daily-usage chart
// trail today by a full month. Merge both sources additively: same-key sums
// keep boundary days (some hours already aggregated, some still in buckets)
// arithmetically correct because each hourly bucket entry is moved out of
// `buckets` once it is folded into `dailyTotals`.
export const mergeDailyTotals = (
  persisted: Record<string, number> | undefined,
  buckets: Record<string, number> | undefined,
  timeZone: string,
): Record<string, number> => {
  const merged: Record<string, number> = { ...(persisted || {}) };
  const fromBuckets = getDerivedDailyTotals(buckets, timeZone);
  for (const [dateKey, kWh] of Object.entries(fromBuckets)) {
    merged[dateKey] = (merged[dateKey] || 0) + kWh;
  }
  return merged;
};

export const getDerivedHourlyAverages = (buckets: Record<string, number> | undefined, timeZone: string) => {
  const averages: Record<string, { sum: number; count: number }> = {};
  if (!buckets) return averages;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const date = new Date(iso);
    const { year, month, day, hour } = getZonedParts(date, timeZone);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const key = `${weekday}_${hour}`;
    const existing = averages[key] || { sum: 0, count: 0 };
    averages[key] = { sum: existing.sum + kWh, count: existing.count + 1 };
  }
  return averages;
};

// Persisted `hourlyAverages` only ever holds weekday/hour slices for hours that have
// aged out of the 30-day hourly retention window in `lib/power/tracker.ts`
// (`aggregateAndPruneHistory`). The most-recent-30-days of hourly buckets still live
// exclusively in `tracker.buckets`. Reading persisted `hourlyAverages` alone (once it
// is non-empty) therefore drops every recent hour from the typical-day chart. Merge
// both sources additively: each hourly bucket is moved out of `buckets` once folded
// into `hourlyAverages`, so no hour is counted twice (same invariant as
// `mergeDailyTotals`).
export const mergeHourlyAverages = (
  persisted: Record<string, { sum: number; count: number }> | undefined,
  buckets: Record<string, number> | undefined,
  timeZone: string,
): Record<string, { sum: number; count: number }> => {
  const merged: Record<string, { sum: number; count: number }> = {};
  for (const [key, data] of Object.entries(persisted || {})) {
    merged[key] = { sum: data.sum, count: data.count };
  }
  const fromBuckets = getDerivedHourlyAverages(buckets, timeZone);
  for (const [key, data] of Object.entries(fromBuckets)) {
    const existing = merged[key] || { sum: 0, count: 0 };
    merged[key] = { sum: existing.sum + data.sum, count: existing.count + data.count };
  }
  return merged;
};

export const getHourlyPatternMeta = (buckets: Record<string, number> | undefined, timeZone: string) => {
  if (!buckets || Object.keys(buckets).length === 0) {
    return 'Average kWh per hour based on historical data.';
  }
  const times = Object.keys(buckets)
    .map((iso) => new Date(iso).getTime())
    .filter((ts) => Number.isFinite(ts));
  if (!times.length) return 'Average kWh per hour based on historical data.';
  const minTs = Math.min(...times);
  const maxTs = Math.max(...times);
  const days = Math.max(1, Math.round((maxTs - minTs) / (24 * 60 * 60 * 1000)) + 1);
  const start = getDateKeyInTimeZone(new Date(minTs), timeZone);
  const end = getDateKeyInTimeZone(new Date(maxTs), timeZone);
  return `Average kWh per hour based on ${days} days (${start}–${end} ${timeZone}).`;
};

export const getPowerTimeContext = (now: Date, timeZone: string) => {
  const todayStart = getStartOfDayInTimeZone(now, timeZone);
  const todayKey = getDateKeyInTimeZone(new Date(todayStart), timeZone);
  const weekStart = getWeekStartInTimeZone(now, timeZone);
  const monthStart = getMonthStartInTimeZone(now, timeZone);
  return { todayKey, todayStart, weekStart, monthStart };
};

type PeriodTotals = {
  week: number;
  month: number;
};

const sumDailyTotals = (
  dailyTotals: Record<string, number> | undefined,
  timeContext: { todayKey: string; weekStart: number; monthStart: number },
  timeZone: string,
): PeriodTotals => {
  const totals = { week: 0, month: 0 };
  if (!dailyTotals) return totals;
  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    const ts = getDateKeyStartMs(dateKey, timeZone);
    if (dateKey === timeContext.todayKey) continue;
    if (ts >= timeContext.weekStart) totals.week += kWh;
    if (ts >= timeContext.monthStart) totals.month += kWh;
  }
  return totals;
};

// `mergedDailyTotals` already folds bucket-derived recent days into the
// persisted dailyTotals (see `mergeDailyTotals`). Summing buckets again here
// would double-count days that live in both maps once we merge them.
export const getWeekMonthTotals = (
  mergedDailyTotals: Record<string, number>,
  timeContext: { todayKey: string; weekStart: number; monthStart: number },
  today: number,
  timeZone: string,
) => {
  const dailyTotals = sumDailyTotals(mergedDailyTotals, timeContext, timeZone);
  return {
    week: today + dailyTotals.week,
    month: today + dailyTotals.month,
  };
};

export const getWeekdayWeekendAverages = (
  dailyTotals: Record<string, number>,
  todayKey: string,
  timeZone: string,
) => {
  let weekdaySum = 0;
  let weekdayCount = 0;
  let weekendSum = 0;
  let weekendCount = 0;

  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    // Skip today's in-progress total so partial days never drag the average down.
    // Past totals are already finalised; merged bucket-derived recent days are
    // whole days because hourly retention spans the full 30-day window.
    if (dateKey === todayKey) continue;
    const ts = getDateKeyStartMs(dateKey, timeZone);
    const day = new Date(ts).getUTCDay();
    if (day === 0 || day === 6) {
      weekendSum += kWh;
      weekendCount += 1;
    } else {
      weekdaySum += kWh;
      weekdayCount += 1;
    }
  }

  const weekdayAvg = weekdayCount > 0 ? weekdaySum / weekdayCount : 0;
  const weekendAvg = weekendCount > 0 ? weekendSum / weekendCount : 0;
  const hasPatternData = (weekdayCount + weekendCount) > 0;

  return { weekdayAvg, weekendAvg, hasPatternData };
};

export const buildHourlyPattern = (
  hourlyAverages: Record<string, { sum: number; count: number }>,
  includeWeekday?: (weekday: number) => boolean,
): HourlyPatternPoint[] => {
  const entries: HourlyPatternPoint[] = [];
  if (!hourlyAverages) return entries;
  const totals = new Map<number, { sum: number; count: number }>();
  for (const [patternKey, data] of Object.entries(hourlyAverages)) {
    const [weekdayStr, hourStr] = patternKey.split('_');
    const weekday = Number(weekdayStr);
    const hour = Number(hourStr);
    if (includeWeekday && (!Number.isFinite(weekday) || !includeWeekday(weekday))) continue;
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    const existing = totals.get(hour) || { sum: 0, count: 0 };
    totals.set(hour, { sum: existing.sum + data.sum, count: existing.count + data.count });
  }
  for (const [hour, data] of totals.entries()) {
    const avg = data.count > 0 ? data.sum / data.count : 0;
    entries.push({ hour, avg });
  }
  return entries.sort((a, b) => a.hour - b.hour);
};

export const buildDailyHistory = (dailyTotals: Record<string, number>, todayKey: string): DailyHistoryPoint[] => {
  const entries: DailyHistoryPoint[] = [];
  if (!dailyTotals) return entries;
  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    if (dateKey === todayKey) continue;
    entries.push({ date: dateKey, kWh });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date)).slice(0, DAILY_HISTORY_DAYS);
};
