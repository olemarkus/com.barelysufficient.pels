import {
  powerList,
  powerEmpty,
  powerWeekPrev,
  powerWeekNext,
  powerWeekLabel,
  dailyList,
  dailyEmpty,
  usageToday,
  usageWeek,
  usageMonth,
  usageWeekdayAvg,
  usageWeekendAvg,
  hourlyPattern,
  hourlyPatternMeta,
} from './dom';
import { getSetting } from './homey';
import { createUsageBar } from './components';

export type PowerTracker = {
  buckets?: Record<string, number>;
  hourlyBudgets?: Record<string, number>;
  dailyTotals?: Record<string, number>;
  hourlyAverages?: Record<string, { sum: number; count: number }>;
  unreliablePeriods?: Array<{ start: number; end: number }>;
};

type PowerUsageEntry = {
  hour: Date;
  kWh: number;
  budgetKWh?: number;
  unreliable?: boolean;
};

type PowerStatsSummary = {
  today: number;
  week: number;
  month: number;
  weekdayAvg: number;
  weekendAvg: number;
  hourlyPattern: { hour: number; avg: number }[];
  hourlyPatternMeta: string;
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
  hourlyPatternMeta: 'Average kWh per hour based on historical data.',
  dailyHistory: [],
  hasPatternData: false,
});

const getDerivedDailyTotals = (buckets: Record<string, number> | undefined) => {
  const totals: Record<string, number> = {};
  if (!buckets) return totals;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const dateKey = iso.slice(0, 10);
    totals[dateKey] = (totals[dateKey] || 0) + kWh;
  }
  return totals;
};

const getDerivedHourlyAverages = (buckets: Record<string, number> | undefined) => {
  const averages: Record<string, { sum: number; count: number }> = {};
  if (!buckets) return averages;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const date = new Date(iso);
    const key = `${date.getUTCDay()}_${date.getUTCHours()}`;
    const existing = averages[key] || { sum: 0, count: 0 };
    averages[key] = { sum: existing.sum + kWh, count: existing.count + 1 };
  }
  return averages;
};

const getHourlyPatternMeta = (buckets: Record<string, number> | undefined) => {
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
  const start = new Date(minTs).toISOString().slice(0, 10);
  const end = new Date(maxTs).toISOString().slice(0, 10);
  return `Average kWh per hour based on ${days} days (${start}–${end} UTC).`;
};

const getPowerTimeContext = (now: Date) => {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayKey = new Date(todayStart).toISOString().slice(0, 10);
  const dayOfWeek = now.getUTCDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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

const getWeekdayWeekendAverages = (dailyTotals: Record<string, number>) => {
  let weekdaySum = 0;
  let weekdayCount = 0;
  let weekendSum = 0;
  let weekendCount = 0;

  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    const date = new Date(dateKey);
    const day = date.getUTCDay();
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

const buildHourlyPattern = (hourlyAverages: Record<string, { sum: number; count: number }>): { hour: number; avg: number }[] => {
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

const buildDailyHistory = (dailyTotals: Record<string, number>, todayKey: string): { date: string; kWh: number }[] => {
  const entries: { date: string; kWh: number }[] = [];
  if (!dailyTotals) return entries;
  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    if (dateKey === todayKey) continue;
    entries.push({ date: dateKey, kWh });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
};

let powerUsageWeekOffset = 0;
let powerUsageEntries: PowerUsageEntry[] = [];
let powerUsageNavReady = false;

const getUtcWeekRange = (now: Date, weekOffset: number) => {
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const mondayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday);
  const startMs = mondayStart + weekOffset * 7 * 24 * 60 * 60 * 1000;
  const endMs = startMs + 7 * 24 * 60 * 60 * 1000;
  return { startMs, endMs };
};

const formatUtcDate = (date: Date, options: Intl.DateTimeFormatOptions) => (
  date.toLocaleDateString([], { timeZone: 'UTC', ...options })
);

const formatWeekLabel = (startMs: number, endMs: number) => {
  const start = new Date(startMs);
  const end = new Date(endMs - 1);
  const startText = formatUtcDate(start, { month: 'short', day: 'numeric' });
  const endText = formatUtcDate(end, { month: 'short', day: 'numeric' });
  return `${startText}–${endText}`;
};

const ensurePowerUsageNav = () => {
  if (powerUsageNavReady || !powerWeekPrev || !powerWeekNext || !powerWeekLabel) return;
  powerUsageNavReady = true;
  powerWeekPrev.addEventListener('click', () => {
    powerUsageWeekOffset -= 1;
    renderPowerUsage(powerUsageEntries);
  });
  powerWeekNext.addEventListener('click', () => {
    if (powerUsageWeekOffset >= 0) return;
    powerUsageWeekOffset += 1;
    renderPowerUsage(powerUsageEntries);
  });
};

const updateSummaryLabel = (valueEl: HTMLElement | null, labelText: string) => {
  const label = valueEl?.closest('.summary-card')?.querySelector('.summary-label');
  if (label) label.textContent = labelText;
};

const renderPowerSummary = (stats: PowerStatsSummary) => {
  const now = new Date();
  const todayText = formatUtcDate(now, { weekday: 'short', month: 'short', day: 'numeric' });
  const weekRange = getUtcWeekRange(now, 0);
  const weekText = `${formatWeekLabel(weekRange.startMs, weekRange.endMs)} UTC`;
  const monthText = formatUtcDate(now, { month: 'short', year: 'numeric' });

  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.week.toFixed(1)} kWh`;
  if (usageMonth) usageMonth.textContent = `${stats.month.toFixed(1)} kWh`;

  updateSummaryLabel(usageToday, `Today (${todayText} UTC)`);
  updateSummaryLabel(usageWeek, `This week (${weekText})`);
  updateSummaryLabel(usageMonth, `This month (${monthText} UTC)`);
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
  if (hourlyPatternMeta) hourlyPatternMeta.textContent = stats.hourlyPatternMeta;
  if (!stats.hasPatternData) {
    const message = document.createElement('div');
    message.className = 'hourly-pattern__empty';
    message.textContent = 'Usage patterns will appear after collecting more data';
    hourlyPattern.appendChild(message);
    return;
  }

  const maxAvg = Math.max(...stats.hourlyPattern.map(p => p.avg), 0.1);
  stats.hourlyPattern.forEach(({ hour, avg }) => {
    const row = document.createElement('div');
    row.className = 'usage-row usage-row--pattern';

    const start = new Date(Date.UTC(2000, 0, 1, hour, 0, 0));
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const label = document.createElement('div');
    label.className = 'usage-row__label';
    label.textContent = `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    const bar = createUsageBar({
      value: avg,
      max: maxAvg,
      minFillPct: 4,
      className: 'usage-row__bar usage-bar--lg',
      fillClassName: 'usage-bar__fill--accent',
      labelText: `${avg.toFixed(2)} kWh`,
      title: `${hour}:00 - ${avg.toFixed(2)} kWh`,
    });

    const value = document.createElement('div');
    value.className = 'usage-row__value';
    value.textContent = `${avg.toFixed(2)} kWh`;
    row.append(label, bar, value);
    hourlyPattern.appendChild(row);
  });
};

const buildDailyHistoryRow = (entry: { date: string; kWh: number }, maxKWh: number) => {
  const row = document.createElement('div');
  row.className = 'usage-row usage-row--daily';

  const dateEl = document.createElement('div');
  dateEl.className = 'usage-row__label';
  const date = new Date(entry.date);
  dateEl.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  const bar = createUsageBar({
    value: entry.kWh,
    max: maxKWh,
    minFillPct: 4,
    className: 'usage-row__bar usage-bar--lg',
    fillClassName: 'usage-bar__fill--accent',
    labelText: `${entry.kWh.toFixed(1)} kWh`,
  });

  const val = document.createElement('div');
  val.className = 'usage-row__value';
  val.textContent = `${entry.kWh.toFixed(1)} kWh`;

  row.append(dateEl, bar, val);
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
  const maxKWh = Math.max(...stats.dailyHistory.map((entry) => entry.kWh), 0.1);
  stats.dailyHistory.forEach((entry) => {
    dailyList.appendChild(buildDailyHistoryRow(entry, maxKWh));
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
  const derivedDailyTotals = Object.keys(tracker.dailyTotals || {}).length
    ? tracker.dailyTotals as Record<string, number>
    : getDerivedDailyTotals(tracker.buckets);
  const derivedHourlyAverages = Object.keys(tracker.hourlyAverages || {}).length
    ? tracker.hourlyAverages as Record<string, { sum: number; count: number }>
    : getDerivedHourlyAverages(tracker.buckets);
  const totals = getWeekMonthTotals({ ...tracker, dailyTotals: derivedDailyTotals }, timeContext, today);
  const averages = getWeekdayWeekendAverages(derivedDailyTotals);
  const hourlyPattern = buildHourlyPattern(derivedHourlyAverages);
  const hourlyPatternMeta = getHourlyPatternMeta(tracker.buckets);
  const dailyHistory = buildDailyHistory(derivedDailyTotals, timeContext.todayKey);

  return {
    today,
    week: totals.week,
    month: totals.month,
    weekdayAvg: averages.weekdayAvg,
    weekendAvg: averages.weekendAvg,
    hourlyPattern,
    hourlyPatternMeta,
    dailyHistory,
    hasPatternData: averages.hasPatternData,
  };
};

export const getPowerUsage = async (): Promise<PowerUsageEntry[]> => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];

  const unreliablePeriods = tracker.unreliablePeriods || [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      const start = date.getTime();
      const end = start + 3600000;
      const isUnreliable = unreliablePeriods.some((p) => p.start < end && p.end > start);
      return {
        hour: date,
        kWh: Number(value) || 0,
        budgetKWh: tracker.hourlyBudgets?.[iso],
        unreliable: isUnreliable,
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
  powerUsageEntries = entries;
  ensurePowerUsageNav();
  const now = new Date(Date.now());
  const range = getUtcWeekRange(now, powerUsageWeekOffset);
  if (powerWeekLabel) powerWeekLabel.textContent = formatWeekLabel(range.startMs, range.endMs);
  if (powerWeekNext) powerWeekNext.disabled = powerUsageWeekOffset >= 0;
  if (powerWeekPrev) powerWeekPrev.disabled = false;

  const filtered = entries.filter((entry) => {
    const ts = entry.hour.getTime();
    return ts >= range.startMs && ts < range.endMs;
  });
  const grouped = filtered.reduce((acc, entry) => {
    const dateKey = entry.hour.toISOString().slice(0, 10);
    if (!acc.has(dateKey)) acc.set(dateKey, []);
    acc.get(dateKey)?.push(entry);
    return acc;
  }, new Map<string, PowerUsageEntry[]>());
  powerList.innerHTML = '';
  if (!filtered.length) {
    powerEmpty.hidden = false;
    return;
  }

  powerEmpty.hidden = true;
  const fragment = document.createDocumentFragment();
  Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([dateKey, dayEntries]) => {
      const header = document.createElement('div');
      header.className = 'list__header power-day-header';
      const headerLabel = document.createElement('span');
      headerLabel.className = 'pill';
      headerLabel.textContent = new Date(dateKey).toLocaleDateString([], {
        weekday: 'short', month: 'short', day: 'numeric',
      });
      header.appendChild(headerLabel);
      fragment.appendChild(header);

      dayEntries
        .sort((a, b) => a.hour.getTime() - b.hour.getTime())
        .forEach((entry) => {
          fragment.appendChild(createPowerRow(entry));
        });
    });
  powerList.appendChild(fragment);
};

const createTimeLabel = (date: Date): string => {
  const start = date;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const createPowerMeter = (kWh: number, budget: number | null): HTMLElement => (
  createUsageBar({
    value: kWh,
    max: budget ?? kWh,
    minFillPct: 4,
    className: 'power-meter usage-bar--lg',
    fillClassName: budget && kWh > budget
      ? 'usage-bar__fill--accent power-meter__fill--alert'
      : 'usage-bar__fill--accent',
    labelClassName: 'power-meter__label',
    labelText: budget !== null
      ? `${kWh.toFixed(2)} / ${budget.toFixed(2)} kWh`
      : `${kWh.toFixed(2)} kWh`,
    title: budget !== null
      ? `${kWh > budget ? 'Over' : 'Under'} cap: ${kWh.toFixed(2)} / ${budget.toFixed(2)} kWh`
      : `Energy ${kWh.toFixed(2)} kWh`,
  })
);

const createPowerRow = (entry: PowerUsageEntry): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'usage-row usage-row--detail';
  row.setAttribute('role', 'listitem');

  const label = document.createElement('div');
  label.className = 'usage-row__label';
  label.textContent = createTimeLabel(entry.hour);

  const budget = typeof entry.budgetKWh === 'number' && entry.budgetKWh > 0 ? entry.budgetKWh : null;
  const meter = createPowerMeter(entry.kWh, budget);
  meter.classList.add('usage-row__bar');

  const value = document.createElement('div');
  value.className = 'usage-row__value';
  value.textContent = `${entry.kWh.toFixed(2)} kWh`;

  if (entry.unreliable) {
    row.classList.add('usage-row--warn');
    row.title = 'Unreliable data';
  }

  row.append(label, meter, value);
  return row;
};
