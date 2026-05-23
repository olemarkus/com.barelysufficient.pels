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
} from './dom.ts';
import { renderUsageHero } from './usageHero.ts';
import { SETTINGS_UI_POWER_PATH, type SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import {
  disposePowerWeekChart,
  renderPowerWeekChart,
  resolvePowerWeekChartValueRange,
} from './powerWeekChartEcharts.ts';
import { getApiReadModel, getHomeyTimezone } from './homey.ts';
import { createToggleGroup } from './components.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import { buildDayContext } from '../../../shared-domain/src/dailyBudget/dayContext.ts';
import {
  formatPowerUsageEmptyAwaitingSamples,
  formatPowerUsageEmptyForWeek,
} from '../../../shared-domain/src/powerUsageStrings.ts';
import { initUsageDayViewHandlers, renderUsageDayView, type UsageDayEntry } from './usageDayView.ts';
import { resolveUsageSplit } from './powerUsageSplit.ts';
import {
  renderDailyHistoryChartEcharts,
  renderHourlyPatternChartEcharts,
} from './usageStatsChartsEcharts.ts';
import { getBudgetAdjustView } from './budgetAdjustController.ts';
import {
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getMonthStartInTimeZone,
  getStartOfDayInTimeZone,
  getWeekStartInTimeZone,
  getZonedParts,
  shiftDateKey,
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
  weekdayAvg: number;
  weekendAvg: number;
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
const mergeDailyTotals = (
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

// `mergedDailyTotals` already folds bucket-derived recent days into the
// persisted dailyTotals (see `mergeDailyTotals`). Summing buckets again here
// would double-count days that live in both maps once we merge them.
const getWeekMonthTotals = (
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

const getWeekdayWeekendAverages = (
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
  const currentWeekStartKey = getDateKeyInTimeZone(new Date(weekStart), timeZone);
  const startKey = shiftDateKey(currentWeekStartKey, weekOffset * 7);
  const endKey = shiftDateKey(startKey, 7);
  const startMs = getDateKeyStartMs(startKey, timeZone);
  const endMs = getDateKeyStartMs(endKey, timeZone);
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

const renderPowerSummary = (stats: PowerStatsSummary, timeZone: string) => {
  const now = new Date();
  const todayText = formatDateInTimeZone(now, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);

  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.week.toFixed(1)} kWh`;
  if (usageMonth) usageMonth.textContent = `${stats.month.toFixed(1)} kWh`;

  renderUsageHero(stats, timeZone, todayText);
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

// Show only the metric matching the active Weekdays / Weekend segment so the
// stat strip reflects the chart (TODO 585 — fixed v2.7.0). With the two
// averages often within 0.1 kWh, leaving both visible made the segmented
// control feel purposeless. The `data-pattern-metric` attribute values
// ('weekday' / 'weekend') match the corresponding `HourlyPatternView` strings.
const syncPatternAverageVisibility = () => {
  const metrics = document.querySelectorAll<HTMLElement>('[data-pattern-metric]');
  for (const metric of metrics) {
    const matchesSegment = metric.dataset.patternMetric === hourlyPatternView;
    metric.hidden = hourlyPatternView !== 'all' && !matchesSegment;
  }
};

const renderHourlyPattern = (stats: PowerStatsSummary) => {
  if (!hourlyPattern) return;
  setHourlyPatternToggleActive(hourlyPatternView);
  syncPatternAverageVisibility();
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

// Resolve the configured daily-budget kWh for the history chart's overlay.
// Returns null when the budget is disabled, missing, or non-finite — callers
// pass the value through to the chart which suppresses the overlay on null.
const resolveDailyBudgetKWhForChart = (): number | null => {
  const view = getBudgetAdjustView();
  if (!view.active?.enabled) return null;
  const value = view.active?.dailyBudgetKWh;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
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
    budgetKWh: resolveDailyBudgetKWhForChart(),
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
  const derivedDailyTotals = mergeDailyTotals(tracker.dailyTotals, tracker.buckets, timeZone);
  const derivedHourlyAverages = Object.keys(tracker.hourlyAverages || {}).length
    ? tracker.hourlyAverages as Record<string, { sum: number; count: number }>
    : getDerivedHourlyAverages(tracker.buckets, timeZone);
  const totals = getWeekMonthTotals(derivedDailyTotals, timeContext, today, timeZone);
  const averages = getWeekdayWeekendAverages(derivedDailyTotals, timeContext.todayKey, timeZone);
  const hourlyPatternAll = buildHourlyPattern(derivedHourlyAverages);
  const hourlyPatternWeekday = buildHourlyPattern(derivedHourlyAverages, (d) => d >= 1 && d <= 5);
  const hourlyPatternWeekend = buildHourlyPattern(derivedHourlyAverages, (d) => d === 0 || d === 6);
  const hourlyPatternMeta = getHourlyPatternMeta(tracker.buckets, timeZone);
  const dailyHistory = buildDailyHistory(derivedDailyTotals, timeContext.todayKey);

  return {
    stats: {
      today,
      week: totals.week,
      month: totals.month,
      weekdayAvg: averages.weekdayAvg,
      weekendAvg: averages.weekendAvg,
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
    disposePowerWeekChart(powerList);
    powerList.replaceChildren();
    if (powerEmpty) {
      powerEmpty.textContent = entries.length
        ? formatPowerUsageEmptyForWeek()
        : formatPowerUsageEmptyAwaitingSamples();
      powerEmpty.hidden = false;
    }
    return;
  }

  const globalRange = resolvePowerWeekChartValueRange(entries, timeZone);
  if (powerEmpty) powerEmpty.hidden = true;
  const rendered = renderPowerWeekChart({
    container: powerList,
    entries: filtered,
    startMs: range.startMs,
    endMs: range.endMs,
    timeZone,
    globalMinKWh: globalRange.minKWh,
    globalMaxKWh: globalRange.maxKWh,
  });
  if (!rendered) {
    powerList.replaceChildren();
    if (powerEmpty) {
      powerEmpty.hidden = false;
      powerEmpty.textContent = 'Hourly detail chart unavailable.';
    }
  }
};
