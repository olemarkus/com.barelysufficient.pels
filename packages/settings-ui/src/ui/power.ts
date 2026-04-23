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
  usageQualityList,
  hourlyPattern,
  hourlyPatternMeta,
} from './dom.ts';
import { SETTINGS_UI_POWER_PATH, type SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import { renderPowerWeekChart, disposePowerWeekChart } from './powerWeekChartEcharts.ts';
import { getApiReadModel, getHomeyTimezone } from './homey.ts';
import { createToggleGroup } from './components.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import { buildDayContext } from '../../../shared-domain/src/dailyBudget/dayContext.ts';
import { initUsageDayViewHandlers, renderUsageDayView, type UsageDayEntry } from './usageDayView.ts';
import { resolveUsageSplit } from './powerUsageSplit.ts';
import {
  renderDailyHistoryChartEcharts,
  renderHourlyPatternChartEcharts,
} from './usageStatsChartsEcharts.ts';
import {
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getMonthStartInTimeZone,
  getStartOfDayInTimeZone,
  getWeekStartInTimeZone,
  getZonedParts,
} from './timezone.ts';

export type PowerTracker = PowerTrackerState;

type PowerUsageEntry = UsageDayEntry;
type HourlyPatternPoint = { hour: number; avg: number };
type DailyHistoryPoint = { date: string; kWh: number };
const DAILY_HISTORY_DAYS = 14;

type HourlyPatternView = 'all' | 'weekday' | 'weekend';
type DailyHistoryRange = '7' | '14';
const MIN_RELIABLE_SAMPLES_PER_HOUR = 2;
const ZERO_KWH_EPSILON = 1e-9;

type PowerStatsSummary = {
  today: number;
  week: number;
  month: number;
  rolling7Avg: number;
  rolling30Avg: number;
  weekdayAvg: number;
  weekendAvg: number;
  reliableCoveragePct: number;
  staleHours: number;
  lastCompleteDayLabel: string;
  controlledSharePct: number;
  hourlyPatternAll: HourlyPatternPoint[];
  hourlyPatternWeekday: HourlyPatternPoint[];
  hourlyPatternWeekend: HourlyPatternPoint[];
  hourlyPatternMeta: string;
  dailyHistory: DailyHistoryPoint[];
  hasPatternData: boolean;
};

const getEmptyPowerStats = (): PowerStatsSummary => ({
  today: 0,
  week: 0,
  month: 0,
  rolling7Avg: 0,
  rolling30Avg: 0,
  weekdayAvg: 0,
  weekendAvg: 0,
  reliableCoveragePct: 0,
  staleHours: 0,
  lastCompleteDayLabel: '--',
  controlledSharePct: 0,
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

const getDerivedHourlyAverages = (buckets: Record<string, number> | undefined, timeZone: string) => {
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

const getHourlyPatternMeta = (buckets: Record<string, number> | undefined, timeZone: string) => {
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

const getWeekdayWeekendAverages = (dailyTotals: Record<string, number>, timeZone: string) => {
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

const getRollingAverage = (dailyTotals: Record<string, number>, todayKey: string, days: number) => {
  const points = Object.entries(dailyTotals)
    .filter(([dateKey]) => dateKey !== todayKey)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, days)
    .map(([, value]) => value);
  if (!points.length) return 0;
  return points.reduce((sum, value) => sum + value, 0) / points.length;
};

const getReliabilityStats = (tracker: PowerTracker) => {
  const bucketEntries = Object.entries(tracker.buckets ?? {});
  if (!bucketEntries.length) {
    return { reliableCoveragePct: 0, staleHours: 0 };
  }
  let trackedStart = Number.POSITIVE_INFINITY;
  let trackedEnd = Number.NEGATIVE_INFINITY;
  const unreliablePeriods = tracker.unreliablePeriods ?? [];
  let reliableCount = 0;
  bucketEntries.forEach(([iso, value]) => {
    const ts = new Date(iso).getTime();
    trackedStart = Math.min(trackedStart, ts);
    trackedEnd = Math.max(trackedEnd, ts + 3600000);
    const sampleCount = tracker.hourlySampleCounts?.[iso];
    const hasRepeatedSamples = typeof sampleCount === 'number'
      && Number.isFinite(sampleCount)
      && sampleCount >= MIN_RELIABLE_SAMPLES_PER_HOUR
      && Math.abs(Number(value) || 0) <= ZERO_KWH_EPSILON;
    const overlapsUnreliablePeriod = unreliablePeriods.some(
      (period) => period.start < ts + 3600000 && period.end > ts,
    );
    const unreliable = overlapsUnreliablePeriod && !hasRepeatedSamples;
    if (!unreliable) reliableCount += 1;
  });
  const staleHours = unreliablePeriods.reduce((sum, period) => {
    const overlapStart = Math.max(period.start, trackedStart);
    const overlapEnd = Math.min(period.end, trackedEnd);
    if (overlapEnd <= overlapStart) return sum;
    return sum + ((overlapEnd - overlapStart) / 3600000);
  }, 0);
  return {
    reliableCoveragePct: (reliableCount / bucketEntries.length) * 100,
    staleHours,
  };
};

const getLastCompleteDayLabel = (dailyTotals: Record<string, number>, todayKey: string, timeZone: string) => {
  const latest = Object.keys(dailyTotals)
    .filter((dateKey) => dateKey !== todayKey)
    .sort((a, b) => b.localeCompare(a))[0];
  if (!latest) return '--';
  return formatDateInTimeZone(new Date(getDateKeyStartMs(latest, timeZone)), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }, timeZone);
};

const getControlledSharePct = (tracker: PowerTracker) => {
  const total = Object.values(tracker.buckets ?? {})
    .reduce((sum, value) => sum + (Number(value) || 0), 0);
  const controlled = Object.values(tracker.controlledBuckets ?? {})
    .reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (total <= 0) return 0;
  return (controlled / total) * 100;
};

const buildHourlyPattern = (
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

const buildDailyHistory = (dailyTotals: Record<string, number>, todayKey: string): DailyHistoryPoint[] => {
  const entries: DailyHistoryPoint[] = [];
  if (!dailyTotals) return entries;
  for (const [dateKey, kWh] of Object.entries(dailyTotals)) {
    if (dateKey === todayKey) continue;
    entries.push({ date: dateKey, kWh });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date)).slice(0, DAILY_HISTORY_DAYS);
};

let powerUsageWeekOffset = 0;
let powerUsageEntries: PowerUsageEntry[] = [];
let powerUsageNavReady = false;
let latestPowerStats: PowerStatsSummary = getEmptyPowerStats();
let latestPowerStatsTimeZone = getHomeyTimezone();
let hourlyPatternView: HourlyPatternView = 'all';
let dailyHistoryRange: DailyHistoryRange = '14';
let usageHistoryToggleReady = false;
let setHourlyPatternToggleActive: (view: HourlyPatternView | null) => void = () => {};
let setDailyHistoryToggleActive: (range: DailyHistoryRange | null) => void = () => {};

const getPowerReadModel = async (): Promise<SettingsUiPowerPayload> => {
  const payload = await getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
  return payload ?? { tracker: null, status: null, heartbeat: null };
};

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


const getHourlyPatternPoints = (stats: PowerStatsSummary): HourlyPatternPoint[] => {
  if (hourlyPatternView === 'weekday') return stats.hourlyPatternWeekday;
  if (hourlyPatternView === 'weekend') return stats.hourlyPatternWeekend;
  return stats.hourlyPatternAll;
};

const getDailyHistoryPoints = (stats: PowerStatsSummary): DailyHistoryPoint[] => (
  stats.dailyHistory.slice(0, Number(dailyHistoryRange))
);

const updateSummaryLabel = (valueEl: HTMLElement | null, labelText: string) => {
  const label = valueEl?.closest('.summary-card')?.querySelector('.summary-label');
  if (label) label.textContent = labelText;
};

const renderPowerSummary = (stats: PowerStatsSummary, timeZone: string) => {
  const now = new Date();
  const todayText = formatDateInTimeZone(now, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
  const weekText = 'recent complete days';
  const monthText = 'completed days on hand';

  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.rolling7Avg.toFixed(1)} kWh/day`;
  if (usageMonth) usageMonth.textContent = `${stats.rolling30Avg.toFixed(1)} kWh/day`;

  updateSummaryLabel(usageToday, `Today (${todayText})`);
  updateSummaryLabel(usageWeek, `7-day avg (${weekText})`);
  updateSummaryLabel(usageMonth, `30-day avg (${monthText})`);
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
    setSummaryValue(
      usageWeekdayAvg,
      stats.hasPatternData,
      `${stats.weekdayAvg.toFixed(1)} kWh/day`,
    );
  }
  if (usageWeekendAvg) {
    setSummaryValue(
      usageWeekendAvg,
      stats.hasPatternData,
      `${stats.weekendAvg.toFixed(1)} kWh/day`,
    );
  }
};

const renderUsageQuality = (stats: PowerStatsSummary) => {
  if (!usageQualityList) return;
  usageQualityList.innerHTML = `
    <div class="usage-context-list__item">
      <strong>Reliable coverage</strong>
      <p>${stats.reliableCoveragePct.toFixed(0)}% of tracked hours look reliable enough to learn from.</p>
    </div>
    <div class="usage-context-list__item">
      <strong>Stale / unreliable hours</strong>
      <p>${stats.staleHours.toFixed(1)} hours are currently flagged as stale or unreliable.</p>
    </div>
    <div class="usage-context-list__item">
      <strong>Last complete day</strong>
      <p>${stats.lastCompleteDayLabel} with about ${
        stats.controlledSharePct.toFixed(0)
      }% controllable-share signal in history.</p>
    </div>
  `;
};

const renderHourlyPattern = (stats: PowerStatsSummary) => {
  if (!hourlyPattern) return;
  setHourlyPatternToggleActive(hourlyPatternView);
  const points = getHourlyPatternPoints(stats);
  if (hourlyPatternMeta) {
    hourlyPatternMeta.textContent = stats.hourlyPatternMeta;
  }
  if (!points.length || !stats.hasPatternData) {
    renderHourlyPatternChartEcharts({
      container: hourlyPattern,
      points: [],
    });
    const message = document.createElement('div');
    message.className = 'hourly-pattern__empty';
    message.textContent = 'Usage patterns will appear after collecting more data';
    hourlyPattern.appendChild(message);
    return;
  }
  const rendered = renderHourlyPatternChartEcharts({
    container: hourlyPattern,
    points,
  });
  if (rendered) return;
  const message = document.createElement('div');
  message.className = 'hourly-pattern__empty';
  message.textContent = 'Usage pattern chart unavailable';
  hourlyPattern.appendChild(message);
};

const renderDailyHistory = (stats: PowerStatsSummary, timeZone: string) => {
  if (!dailyList || !dailyEmpty) return;
  setDailyHistoryToggleActive(dailyHistoryRange);
  const points = getDailyHistoryPoints(stats);
  if (!points.length) {
    renderDailyHistoryChartEcharts({
      container: dailyList,
      points: [],
      timeZone,
    });
    dailyEmpty.textContent = 'No daily totals yet.';
    dailyEmpty.hidden = false;
    return;
  }
  const rendered = renderDailyHistoryChartEcharts({
    container: dailyList,
    points,
    timeZone,
  });
  dailyEmpty.hidden = rendered;
  if (rendered) return;
  dailyEmpty.textContent = 'Daily history chart unavailable';
};

const initUsageHistoryToggles = () => {
  if (usageHistoryToggleReady) return;
  usageHistoryToggleReady = true;

  const patternMount = document.getElementById('hourly-pattern-toggle-mount');
  if (patternMount) {
    const { element, setActive } = createToggleGroup<HourlyPatternView>(
      [
        { value: 'all', label: 'All days' },
        { value: 'weekday', label: 'Weekdays' },
        { value: 'weekend', label: 'Weekend' },
      ],
      'Typical usage view',
      (view) => {
        hourlyPatternView = view;
        renderHourlyPattern(latestPowerStats);
      },
    );
    patternMount.replaceWith(element);
    setHourlyPatternToggleActive = setActive;
    setHourlyPatternToggleActive(hourlyPatternView);
  }

  const historyMount = document.getElementById('daily-history-range-mount');
  if (historyMount) {
    const hint = document.getElementById('daily-history-range-hint');
    const { element, setActive } = createToggleGroup<DailyHistoryRange>(
      [
        { value: '7', label: '7 days' },
        { value: '14', label: '14 days' },
      ],
      'Daily history range',
      (range) => {
        dailyHistoryRange = range;
        if (hint) hint.textContent = `Last ${range} days`;
        renderDailyHistory(latestPowerStats, latestPowerStatsTimeZone);
      },
    );
    historyMount.replaceWith(element);
    setDailyHistoryToggleActive = setActive;
    setDailyHistoryToggleActive(dailyHistoryRange);
  }
};

const renderUsageHistorySections = () => {
  initUsageHistoryToggles();
  renderHourlyPattern(latestPowerStats);
  renderDailyHistory(latestPowerStats, latestPowerStatsTimeZone);
};

export const getPowerStats = async (): Promise<{ stats: PowerStatsSummary; timeZone: string }> => {
  const tracker = (await getPowerReadModel()).tracker as PowerTracker | null;
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
  const derivedDailyTotals = Object.keys(tracker.dailyTotals || {}).length
    ? tracker.dailyTotals as Record<string, number>
    : getDerivedDailyTotals(tracker.buckets, timeZone);
  const derivedHourlyAverages = Object.keys(tracker.hourlyAverages || {}).length
    ? tracker.hourlyAverages as Record<string, { sum: number; count: number }>
    : getDerivedHourlyAverages(tracker.buckets, timeZone);
  const totals = getWeekMonthTotals({ ...tracker, dailyTotals: derivedDailyTotals }, timeContext, today, timeZone);
  const averages = getWeekdayWeekendAverages(derivedDailyTotals, timeZone);
  const hourlyPatternAll = buildHourlyPattern(derivedHourlyAverages);
  const hourlyPatternWeekday = buildHourlyPattern(derivedHourlyAverages, (d) => d >= 1 && d <= 5);
  const hourlyPatternWeekend = buildHourlyPattern(derivedHourlyAverages, (d) => d === 0 || d === 6);
  const hourlyPatternMeta = getHourlyPatternMeta(tracker.buckets, timeZone);
  const dailyHistory = buildDailyHistory(derivedDailyTotals, timeContext.todayKey);
  const rolling7Avg = getRollingAverage(derivedDailyTotals, timeContext.todayKey, 7);
  const rolling30Avg = getRollingAverage(derivedDailyTotals, timeContext.todayKey, 30);
  const reliability = getReliabilityStats(tracker);
  const controlledSharePct = getControlledSharePct(tracker);

  return {
    stats: {
      today,
      week: totals.week,
      month: totals.month,
      rolling7Avg,
      rolling30Avg,
      weekdayAvg: averages.weekdayAvg,
      weekendAvg: averages.weekendAvg,
      reliableCoveragePct: reliability.reliableCoveragePct,
      staleHours: reliability.staleHours,
      lastCompleteDayLabel: getLastCompleteDayLabel(derivedDailyTotals, timeContext.todayKey, timeZone),
      controlledSharePct,
      hourlyPatternAll,
      hourlyPatternWeekday,
      hourlyPatternWeekend,
      hourlyPatternMeta,
      dailyHistory,
      hasPatternData: averages.hasPatternData,
    },
    timeZone,
  };
};

export const getPowerUsage = async (): Promise<PowerUsageEntry[]> => {
  const tracker = (await getPowerReadModel()).tracker as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];

  const unreliablePeriods = tracker.unreliablePeriods || [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      const start = date.getTime();
      const end = start + 3600000;
      const kWh = Number(value) || 0;
      const sampleCount = tracker.hourlySampleCounts?.[iso];
      const hasRepeatedSamples = typeof sampleCount === 'number'
        && Number.isFinite(sampleCount)
        && sampleCount >= MIN_RELIABLE_SAMPLES_PER_HOUR
        && Math.abs(kWh) <= ZERO_KWH_EPSILON;
      const isUnreliable = unreliablePeriods.some((p) => p.start < end && p.end > start) && !hasRepeatedSamples;
      const split = resolveUsageSplit({
        totalKWh: kWh,
        rawControlled: tracker.controlledBuckets?.[iso],
        rawUncontrolled: tracker.uncontrolledBuckets?.[iso],
      });
      return {
        hour: date,
        kWh,
        budgetKWh: tracker.hourlyBudgets?.[iso],
        ...split,
        unreliable: isUnreliable,
      };
    })
    .sort((a, b) => a.hour.getTime() - b.hour.getTime());
};

export { getPowerReadModel };

export const renderPowerStats = async () => {
  const { stats, timeZone } = await getPowerStats();
  latestPowerStats = stats;
  latestPowerStatsTimeZone = timeZone;
  renderPowerSummary(stats, timeZone);
  renderPowerAverages(stats);
  renderUsageQuality(stats);
  renderUsageHistorySections();
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
  const hasPrevData = entries.some((e) => e.hour.getTime() < range.startMs);
  if (powerWeekPrev) powerWeekPrev.disabled = !hasPrevData;

  const filtered = entries.filter((entry) => {
    const ts = entry.hour.getTime();
    return ts >= range.startMs && ts < range.endMs;
  });

  if (!powerList) return;

  if (!filtered.length) {
    disposePowerWeekChart();
    powerList.replaceChildren();
    if (powerEmpty) powerEmpty.hidden = false;
    return;
  }

  const kWhValues = entries.map((e) => e.kWh);
  const globalMinKWh = kWhValues.length > 0 ? Math.min(...kWhValues) : 0;
  const globalMaxKWh = Math.max(0.1, ...kWhValues);
  if (powerEmpty) powerEmpty.hidden = true;
  const rendered = renderPowerWeekChart({
    container: powerList,
    entries: filtered,
    startMs: range.startMs,
    endMs: range.endMs,
    timeZone,
    globalMinKWh,
    globalMaxKWh,
  });
  if (!rendered) {
    powerList.replaceChildren();
    if (powerEmpty) {
      powerEmpty.hidden = false;
      powerEmpty.textContent = 'Hourly detail chart unavailable.';
    }
  }
};
