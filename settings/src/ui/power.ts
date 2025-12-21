import {
  powerList,
  powerEmpty,
  dailyList,
  dailyEmpty,
  usageToday,
  usageWeek,
  usageMonth,
  usageWeekdayAvg,
  usageWeekendAvg,
  hourlyPattern,
} from './dom';
import { getSetting } from './homey';

type PowerTracker = {
  buckets?: Record<string, number>;
  dailyTotals?: Record<string, number>;
  hourlyAverages?: Record<string, { sum: number; count: number }>;
};

type PowerUsageEntry = {
  hour: Date;
  kWh: number;
};

type PowerStatsSummary = {
  today: number;
  week: number;
  month: number;
  weekdayAvg: number;
  weekendAvg: number;
  hourlyPattern: { hour: number; avg: number }[];
  dailyHistory: { date: string; kWh: number }[];
  hasPatternData: boolean;
};

const getEmptyPowerStats = (): PowerStatsSummary => ({
  today: 0,
  week: 0,
  month: 0,
  weekdayAvg: 0,
  weekendAvg: 0,
  hourlyPattern: [],
  dailyHistory: [],
  hasPatternData: false,
});

const getPowerTimeContext = (now: Date) => {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayKey = new Date(todayStart).toISOString().slice(0, 10);
  const dayOfWeek = now.getDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return { todayKey, todayStart, weekStart, monthStart };
};

const getTodayUsage = (tracker: PowerTracker, todayStart: number) => {
  let total = 0;
  if (tracker.buckets) {
    for (const [iso, kWh] of Object.entries(tracker.buckets)) {
      const ts = new Date(iso).getTime();
      if (ts >= todayStart) {
        total += kWh;
      }
    }
  }
  return total;
};

type PeriodTotals = {
  week: number;
  month: number;
};

const sumDailyTotals = (
  dailyTotals: Record<string, number> | undefined,
  timeContext: { todayKey: string; weekStart: Date; monthStart: Date },
): PeriodTotals => {
  const totals = { week: 0, month: 0 };
  if (!dailyTotals) return totals;
  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    const ts = new Date(dateKey).getTime();
    if (dateKey === timeContext.todayKey) continue;
    if (ts >= timeContext.weekStart.getTime()) totals.week += kWh;
    if (ts >= timeContext.monthStart.getTime()) totals.month += kWh;
  }
  return totals;
};

const sumBucketTotalsBeforeToday = (
  buckets: Record<string, number> | undefined,
  timeContext: { todayStart: number; weekStart: Date; monthStart: Date },
): PeriodTotals => {
  const totals = { week: 0, month: 0 };
  if (!buckets) return totals;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const ts = new Date(iso).getTime();
    if (ts >= timeContext.todayStart) continue;
    if (ts >= timeContext.weekStart.getTime()) totals.week += kWh;
    if (ts >= timeContext.monthStart.getTime()) totals.month += kWh;
  }
  return totals;
};

const getWeekMonthTotals = (
  tracker: PowerTracker,
  timeContext: { todayKey: string; todayStart: number; weekStart: Date; monthStart: Date },
  today: number,
) => {
  const dailyTotals = sumDailyTotals(tracker.dailyTotals, timeContext);
  const bucketTotals = sumBucketTotalsBeforeToday(tracker.buckets, timeContext);
  return {
    week: today + dailyTotals.week + bucketTotals.week,
    month: today + dailyTotals.month + bucketTotals.month,
  };
};

const getWeekdayWeekendAverages = (tracker: PowerTracker) => {
  let weekdaySum = 0;
  let weekdayCount = 0;
  let weekendSum = 0;
  let weekendCount = 0;

  if (tracker.dailyTotals) {
    for (const [dateKey, kWh] of Object.entries(tracker.dailyTotals)) {
      const date = new Date(dateKey);
      const day = date.getDay();
      if (day === 0 || day === 6) {
        weekendSum += kWh;
        weekendCount += 1;
      } else {
        weekdaySum += kWh;
        weekdayCount += 1;
      }
    }
  }

  const weekdayAvg = weekdayCount > 0 ? weekdaySum / weekdayCount : 0;
  const weekendAvg = weekendCount > 0 ? weekendSum / weekendCount : 0;
  const hasPatternData = (weekdayCount + weekendCount) > 0;

  return { weekdayAvg, weekendAvg, hasPatternData };
};

const buildHourlyPattern = (tracker: PowerTracker): { hour: number; avg: number }[] => {
  const entries: { hour: number; avg: number }[] = [];
  if (!tracker.hourlyAverages) return entries;
  for (const [hourStr, data] of Object.entries(tracker.hourlyAverages)) {
    const hour = parseInt(hourStr, 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    const avg = data.count > 0 ? data.sum / data.count : 0;
    entries.push({ hour, avg });
  }
  return entries.sort((a, b) => a.hour - b.hour);
};

const buildDailyHistory = (tracker: PowerTracker, todayKey: string): { date: string; kWh: number }[] => {
  const entries: { date: string; kWh: number }[] = [];
  if (!tracker.dailyTotals) return entries;
  for (const [dateKey, kWh] of Object.entries(tracker.dailyTotals)) {
    if (dateKey === todayKey) continue;
    entries.push({ date: dateKey, kWh });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
};

const renderPowerSummary = (stats: PowerStatsSummary) => {
  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.week.toFixed(1)} kWh`;
  if (usageMonth) usageMonth.textContent = `${stats.month.toFixed(1)} kWh`;
};

const setSummaryValue = (element: HTMLElement, hasData: boolean, value: string) => {
  const target = element;
  if (hasData) {
    target.textContent = value;
    target.classList.remove('summary-value--empty');
  } else {
    target.textContent = 'Not enough data';
    target.classList.add('summary-value--empty');
  }
};

const renderPowerAverages = (stats: PowerStatsSummary) => {
  if (usageWeekdayAvg) {
    setSummaryValue(usageWeekdayAvg, stats.hasPatternData, `${stats.weekdayAvg.toFixed(1)} kWh/day`);
  }
  if (usageWeekendAvg) {
    setSummaryValue(usageWeekendAvg, stats.hasPatternData, `${stats.weekendAvg.toFixed(1)} kWh/day`);
  }
};

const renderHourlyPattern = (stats: PowerStatsSummary) => {
  if (!hourlyPattern) return;
  hourlyPattern.innerHTML = '';
  if (!stats.hasPatternData) {
    const message = document.createElement('div');
    message.className = 'hourly-pattern__empty';
    message.textContent = 'Usage patterns will appear after collecting more data';
    hourlyPattern.appendChild(message);
    return;
  }

  const maxAvg = Math.max(...stats.hourlyPattern.map(p => p.avg), 0.1);
  for (const { hour, avg } of stats.hourlyPattern) {
    const bar = document.createElement('div');
    bar.className = 'hourly-pattern__bar';
    bar.style.height = `${(avg / maxAvg) * 100}%`;
    bar.title = `${hour}:00 - ${avg.toFixed(2)} kWh`;

    const label = document.createElement('span');
    label.className = 'hourly-pattern__label';
    label.textContent = hour.toString();

    bar.appendChild(label);
    hourlyPattern.appendChild(bar);
  }
};

const buildDailyHistoryRow = (entry: { date: string; kWh: number }) => {
  const row = document.createElement('div');
  row.className = 'daily-row';

  const dateEl = document.createElement('div');
  dateEl.className = 'daily-row__date';
  const date = new Date(entry.date);
  dateEl.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  const val = document.createElement('div');
  val.className = 'daily-row__value';
  val.textContent = `${entry.kWh.toFixed(1)} kWh`;

  row.append(dateEl, val);
  return row;
};

const renderDailyHistory = (stats: PowerStatsSummary) => {
  if (!dailyList || !dailyEmpty) return;
  dailyList.innerHTML = '';
  if (!stats.dailyHistory.length) {
    dailyEmpty.hidden = false;
    return;
  }
  dailyEmpty.hidden = true;
  stats.dailyHistory.forEach((entry) => {
    dailyList.appendChild(buildDailyHistoryRow(entry));
  });
};

const getPowerStats = async (): Promise<PowerStatsSummary> => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object') {
    return getEmptyPowerStats();
  }

  const now = new Date();
  const timeContext = getPowerTimeContext(now);
  const today = getTodayUsage(tracker, timeContext.todayStart);
  const totals = getWeekMonthTotals(tracker, timeContext, today);
  const averages = getWeekdayWeekendAverages(tracker);
  const hourlyPattern = buildHourlyPattern(tracker);
  const dailyHistory = buildDailyHistory(tracker, timeContext.todayKey);

  return {
    today,
    week: totals.week,
    month: totals.month,
    weekdayAvg: averages.weekdayAvg,
    weekendAvg: averages.weekendAvg,
    hourlyPattern,
    dailyHistory,
    hasPatternData: averages.hasPatternData,
  };
};

export const getPowerUsage = async (): Promise<PowerUsageEntry[]> => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      return {
        hour: date,
        kWh: Number(value) || 0,
      };
    })
    .sort((a, b) => a.hour.getTime() - b.hour.getTime());
};

export const renderPowerStats = async () => {
  const stats = await getPowerStats();
  renderPowerSummary(stats);
  renderPowerAverages(stats);
  renderHourlyPattern(stats);
  renderDailyHistory(stats);
};

export const renderPowerUsage = (entries: PowerUsageEntry[]) => {
  powerList.innerHTML = '';
  if (!entries.length) {
    powerEmpty.hidden = false;
    return;
  }

  powerEmpty.hidden = true;
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.setAttribute('role', 'listitem');

    const hour = document.createElement('div');
    hour.className = 'device-row__name';
    hour.textContent = entry.hour.toLocaleString();

    const val = document.createElement('div');
    val.className = 'device-row__target';
    const chip = document.createElement('span');
    chip.className = 'chip';
    const strong = document.createElement('strong');
    strong.textContent = 'Energy';
    const span = document.createElement('span');
    span.textContent = `${entry.kWh.toFixed(3)} kWh`;
    chip.append(strong, span);
    val.appendChild(chip);

    row.append(hour, val);
    powerList.appendChild(row);
  });
};
