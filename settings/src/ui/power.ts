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
import { getHomeyTimezone, getSetting } from './homey';
import { createUsageBar } from './components';
import type { PowerTrackerState } from '../../../lib/core/powerTracker';
import { buildDayContext } from '../../../lib/dailyBudget/dailyBudgetState';
import { initUsageDayViewHandlers, renderUsageDayView, type UsageDayEntry } from './usageDayView';
import { createPowerRow } from './powerUsageRows';
import { resolveUsageSplit } from './powerUsageSplit';
import type { CombinedPriceData } from './priceTypes';
import { buildPriceByHour } from './powerPrice';
import {
  buildDailyHistory,
  buildHourlyPattern,
  deriveDailyTotalsFromBuckets,
  deriveHourlyAveragesFromBuckets,
  getHourlyPatternMeta,
  getWeekdayWeekendAverages,
  mergeDailyTotals,
} from './powerStats';
import {
  formatDateInTimeZone,
  formatTimeInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getMonthStartInTimeZone,
  getStartOfDayInTimeZone,
  getWeekStartInTimeZone,
} from './timezone';

export type PowerTracker = PowerTrackerState;

type PowerUsageEntry = UsageDayEntry;

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

const getPowerTimeContext = (now: Date, timeZone: string) => {
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

const sumBucketTotalsBeforeToday = (
  buckets: Record<string, number> | undefined,
  timeContext: { todayStart: number; weekStart: number; monthStart: number },
): PeriodTotals => {
  const totals = { week: 0, month: 0 };
  if (!buckets) return totals;
  for (const [iso, kWh] of Object.entries(buckets)) {
    const ts = new Date(iso).getTime();
    if (ts >= timeContext.todayStart) continue;
    if (ts >= timeContext.weekStart) totals.week += kWh;
    if (ts >= timeContext.monthStart) totals.month += kWh;
  }
  return totals;
};

const getWeekMonthTotals = (
  tracker: PowerTracker,
  timeContext: { todayKey: string; todayStart: number; weekStart: number; monthStart: number },
  today: number,
  timeZone: string,
) => {
  const dailyTotals = sumDailyTotals(tracker.dailyTotals, timeContext, timeZone);
  const bucketTotals = sumBucketTotalsBeforeToday(tracker.buckets, timeContext);
  return {
    week: today + dailyTotals.week + bucketTotals.week,
    month: today + dailyTotals.month + bucketTotals.month,
  };
};


let powerUsageWeekOffset = 0;
let powerUsageEntries: PowerUsageEntry[] = [];
let powerUsageNavReady = false;

const getTimeZoneWeekRange = (now: Date, weekOffset: number, timeZone: string) => {
  const weekStart = getWeekStartInTimeZone(now, timeZone);
  const startMs = weekStart + weekOffset * 7 * 24 * 60 * 60 * 1000;
  const endMs = startMs + 7 * 24 * 60 * 60 * 1000;
  return { startMs, endMs };
};

const formatWeekLabel = (startMs: number, endMs: number, timeZone: string) => {
  const start = new Date(startMs);
  const end = new Date(endMs - 1);
  const startText = formatDateInTimeZone(start, { month: 'short', day: 'numeric' }, timeZone);
  const endText = formatDateInTimeZone(end, { month: 'short', day: 'numeric' }, timeZone);
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

const renderPowerSummary = (stats: PowerStatsSummary, timeZone: string) => {
  const now = new Date();
  const todayText = formatDateInTimeZone(now, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
  const weekRange = getTimeZoneWeekRange(now, 0, timeZone);
  const weekText = formatWeekLabel(weekRange.startMs, weekRange.endMs, timeZone);
  const monthText = formatDateInTimeZone(now, { month: 'short', year: 'numeric' }, timeZone);

  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.week.toFixed(1)} kWh`;
  if (usageMonth) usageMonth.textContent = `${stats.month.toFixed(1)} kWh`;

  updateSummaryLabel(usageToday, `Today (${todayText})`);
  updateSummaryLabel(usageWeek, `This week (${weekText})`);
  updateSummaryLabel(usageMonth, `This month (${monthText})`);
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

const renderHourlyPattern = (stats: PowerStatsSummary, timeZone: string) => {
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
    label.textContent = `${formatTimeInTimeZone(start, { hour: '2-digit', minute: '2-digit' }, timeZone)}–${formatTimeInTimeZone(end, { hour: '2-digit', minute: '2-digit' }, timeZone)}`;

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

const buildDailyHistoryRow = (entry: { date: string; kWh: number }, maxKWh: number, timeZone: string) => {
  const row = document.createElement('li');
  row.className = 'usage-row usage-row--daily';

  const dateEl = document.createElement('div');
  dateEl.className = 'usage-row__label';
  const date = new Date(getDateKeyStartMs(entry.date, timeZone));
  dateEl.textContent = formatDateInTimeZone(date, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);

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

const renderDailyHistory = (stats: PowerStatsSummary, timeZone: string) => {
  if (!dailyList || !dailyEmpty) return;
  dailyList.innerHTML = '';
  if (!stats.dailyHistory.length) {
    dailyEmpty.hidden = false;
    return;
  }
  dailyEmpty.hidden = true;
  const maxKWh = Math.max(...stats.dailyHistory.map((entry) => entry.kWh), 0.1);
  stats.dailyHistory.forEach((entry) => {
    dailyList.appendChild(buildDailyHistoryRow(entry, maxKWh, timeZone));
  });
};

export const getPowerStats = async (): Promise<{ stats: PowerStatsSummary; timeZone: string }> => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object') {
    return { stats: getEmptyPowerStats(), timeZone: getHomeyTimezone() };
  }

  const now = new Date();
  const timeZone = getHomeyTimezone();
  const timeContext = getPowerTimeContext(now, timeZone);
  const dayContext = buildDayContext({
    nowMs: now.getTime(),
    timeZone,
    powerTracker: tracker,
  });
  const today = dayContext.usedNowKWh;
  const derivedBucketDailyTotals = deriveDailyTotalsFromBuckets(tracker.buckets, timeZone);
  const derivedDailyTotals = mergeDailyTotals(tracker.dailyTotals, derivedBucketDailyTotals);
  const derivedHourlyAverages = Object.keys(tracker.hourlyAverages || {}).length
    ? tracker.hourlyAverages as Record<string, { sum: number; count: number }>
    : deriveHourlyAveragesFromBuckets(tracker.buckets, timeZone);
  const totals = getWeekMonthTotals({ ...tracker, dailyTotals: derivedDailyTotals }, timeContext, today, timeZone);
  const averages = getWeekdayWeekendAverages(derivedDailyTotals, timeZone);
  const hourlyPattern = buildHourlyPattern(derivedHourlyAverages);
  const hourlyPatternMeta = getHourlyPatternMeta(tracker.buckets, timeZone);
  const dailyHistory = buildDailyHistory(derivedDailyTotals, timeContext.todayKey, timeZone);

  return {
    stats: {
      today,
      week: totals.week,
      month: totals.month,
      weekdayAvg: averages.weekdayAvg,
      weekendAvg: averages.weekendAvg,
      hourlyPattern,
      hourlyPatternMeta,
      dailyHistory,
      hasPatternData: averages.hasPatternData,
    },
    timeZone,
  };
};

export const getPowerUsage = async (): Promise<PowerUsageEntry[]> => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];
  const combinedPrices = await getSetting('combined_prices') as CombinedPriceData | null;
  const { byHour: pricesByHour, unit: priceUnit } = buildPriceByHour(combinedPrices);

  const unreliablePeriods = tracker.unreliablePeriods || [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      const start = date.getTime();
      const end = start + 3600000;
      const isUnreliable = unreliablePeriods.some((p) => p.start < end && p.end > start);
      const kWh = Number(value) || 0;
      const split = resolveUsageSplit({
        totalKWh: kWh,
        rawControlled: tracker.controlledBuckets?.[iso],
        rawUncontrolled: tracker.uncontrolledBuckets?.[iso],
      });
      const price = pricesByHour.get(start);
      return {
        hour: date,
        kWh,
        budgetKWh: tracker.hourlyBudgets?.[iso],
        ...split,
        priceTotal: price?.total,
        priceIsCheap: price?.isCheap,
        priceIsExpensive: price?.isExpensive,
        priceUnit,
        unreliable: isUnreliable,
      };
    })
    .sort((a, b) => a.hour.getTime() - b.hour.getTime());
};

export const renderPowerStats = async () => {
  const { stats, timeZone } = await getPowerStats();
  renderPowerSummary(stats, timeZone);
  renderPowerAverages(stats);
  renderHourlyPattern(stats, timeZone);
  renderDailyHistory(stats, timeZone);
};

export const renderPowerUsage = (entries: PowerUsageEntry[]) => {
  powerUsageEntries = entries;
  initUsageDayViewHandlers();
  renderUsageDayView(entries);
  ensurePowerUsageNav();
  const now = new Date(Date.now());
  const timeZone = getHomeyTimezone();
  const range = getTimeZoneWeekRange(now, powerUsageWeekOffset, timeZone);
  if (powerWeekLabel) powerWeekLabel.textContent = formatWeekLabel(range.startMs, range.endMs, timeZone);
  if (powerWeekNext) powerWeekNext.disabled = powerUsageWeekOffset >= 0;
  if (powerWeekPrev) powerWeekPrev.disabled = false;

  const filtered = entries.filter((entry) => {
    const ts = entry.hour.getTime();
    return ts >= range.startMs && ts < range.endMs;
  });
  const grouped = filtered.reduce((acc, entry) => {
    const dateKey = getDateKeyInTimeZone(entry.hour, timeZone);
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
      const header = document.createElement('li');
      header.className = 'list__header power-day-header';
      const headerLabel = document.createElement('span');
      headerLabel.className = 'pill';
      const headerDate = new Date(getDateKeyStartMs(dateKey, timeZone));
      headerLabel.textContent = formatDateInTimeZone(headerDate, {
        weekday: 'short', month: 'short', day: 'numeric',
      }, timeZone);
      header.appendChild(headerLabel);
      fragment.appendChild(header);

      dayEntries
        .sort((a, b) => a.hour.getTime() - b.hour.getTime())
        .forEach((entry) => {
          fragment.appendChild(createPowerRow(entry, timeZone));
        });
    });
  powerList.appendChild(fragment);
};
