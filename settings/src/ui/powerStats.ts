import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getZonedParts,
} from './timezone';

export const deriveDailyTotalsFromBuckets = (
  buckets: Record<string, number> | undefined,
  timeZone: string,
): Record<string, number> => {
  const totals: Record<string, number> = {};
  if (!buckets) return totals;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const dateKey = getDateKeyInTimeZone(new Date(iso), timeZone);
    totals[dateKey] = (totals[dateKey] || 0) + kWh;
  }
  return totals;
};

export const mergeDailyTotals = (
  archivedTotals: Record<string, number> | undefined,
  derivedTotals: Record<string, number>,
): Record<string, number> => {
  const merged = new Map<string, number>();
  const accumulate = (dateKey: string, kWh: number) => {
    if (!Number.isFinite(kWh)) return;
    merged.set(dateKey, (merged.get(dateKey) || 0) + kWh);
  };

  Object.entries(archivedTotals || {}).forEach(([dateKey, kWh]) => {
    accumulate(dateKey, kWh);
  });
  Object.entries(derivedTotals).forEach(([dateKey, kWh]) => {
    accumulate(dateKey, kWh);
  });

  return Object.fromEntries(merged);
};

export const deriveHourlyAveragesFromBuckets = (
  buckets: Record<string, number> | undefined,
  timeZone: string,
): Record<string, { sum: number; count: number }> => {
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

export const getHourlyPatternMeta = (buckets: Record<string, number> | undefined, timeZone: string): string => {
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

export const getWeekdayWeekendAverages = (dailyTotals: Record<string, number>, timeZone: string) => {
  let weekdaySum = 0;
  let weekdayCount = 0;
  let weekendSum = 0;
  let weekendCount = 0;

  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
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
): { hour: number; avg: number }[] => {
  const entries: { hour: number; avg: number }[] = [];
  if (!hourlyAverages) return entries;
  const totals = new Map<number, { sum: number; count: number }>();
  for (const [patternKey, data] of Object.entries(hourlyAverages)) {
    const [, hourStr] = patternKey.split('_');
    const hour = Number(hourStr);
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

export const buildDailyHistory = (
  dailyTotals: Record<string, number>,
  todayKey: string,
  timeZone: string,
): { date: string; kWh: number }[] => {
  const entries: { date: string; kWh: number }[] = [];
  if (!dailyTotals) return entries;
  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    if (dateKey === todayKey) continue;
    entries.push({ date: dateKey, kWh });
  }
  return entries
    .sort((a, b) => {
      const aTs = getDateKeyStartMs(a.date, timeZone);
      const bTs = getDateKeyStartMs(b.date, timeZone);
      if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
        return bTs - aTs;
      }
      return b.date.localeCompare(a.date);
    })
    .slice(0, 14);
};
