import {
  powerList,
  powerEmpty,
  powerWeekPrev,
  powerWeekNext,
  powerWeekLabel,
  powerWeekReadout,
  dailyList,
  dailyEmpty,
  dailyHistoryReadout,
  usageToday,
  usageWeek,
  usageMonth,
  usageWeekdayAvg,
  usageWeekendAvg,
  hourlyPattern,
  hourlyPatternMeta,
  hourlyPatternReadout,
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
import { getActiveDailyBudgetKWh, setActiveDailyBudgetChangeListener } from './activeDailyBudget.ts';
import {
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getWeekStartInTimeZone,
  shiftDateKey,
} from './timezone.ts';
import {
  buildDailyHistory,
  buildHourlyPattern,
  getEmptyPowerStats,
  getHourlyPatternMeta,
  getPowerTimeContext,
  getWeekdayWeekendAverages,
  getWeekMonthTotals,
  isLeadingHistoryDayPartial,
  mergeDailyTotals,
  mergeHourlyAverages,
  type DailyHistoryPoint,
  type HourlyPatternPoint,
  type PowerStatsSummary,
} from './powerStats.ts';

export type PowerTracker = PowerTrackerState;

type PowerUsageEntry = UsageDayEntry;

type HourlyPatternView = 'all' | 'weekday' | 'weekend';
const MIN_RELIABLE_SAMPLES_PER_HOUR = 2;
// Daily history shows the last 14 days — the full window the tracker retains
// (week/month totals depend on the same cap); the rendered slice matches it.
const DAILY_HISTORY_DAYS = 14;
const ZERO_KWH_EPSILON = 1e-9;

let powerUsageWeekOffset = 0;
let powerUsageEntries: PowerUsageEntry[] = [];
let powerUsageNavReady = false;
let latestPowerStats: PowerStatsSummary = getEmptyPowerStats();
let latestPowerStatsTimeZone = getHomeyTimezone();
let hourlyPatternView: HourlyPatternView = 'all';
let usageHistoryToggleReady = false;
let powerStatsRendered = false;
let setHourlyPatternToggleActive: (view: HourlyPatternView | null) => void = () => {};

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
  stats.dailyHistory.slice(0, DAILY_HISTORY_DAYS)
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
      readoutHost: hourlyPatternReadout,
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
    readoutHost: hourlyPatternReadout,
  });
  if (rendered) return;
  const message = document.createElement('div');
  message.className = 'hourly-pattern__empty';
  message.textContent = 'Usage pattern chart unavailable';
  hourlyPattern.appendChild(message);
};

const renderDailyHistory = (stats: PowerStatsSummary, timeZone: string) => {
  if (!dailyList || !dailyEmpty) return;
  const points = getDailyHistoryPoints(stats);
  if (!points.length) {
    renderDailyHistoryChartEcharts({
      container: dailyList,
      points: [],
      timeZone,
      readoutHost: dailyHistoryReadout,
    });
    dailyEmpty.textContent = 'No daily totals yet.';
    dailyEmpty.hidden = false;
    return;
  }
  const rendered = renderDailyHistoryChartEcharts({
    container: dailyList,
    points,
    timeZone,
    // Same active-budget payload the Budget hero renders — never the
    // budget-adjust draft, which clamps the stored value into the slider
    // range on read (see `activeDailyBudget.ts`).
    budgetKWh: getActiveDailyBudgetKWh(),
    leadingPartialDay: stats.dailyHistoryLeadingPartial,
    readoutHost: dailyHistoryReadout,
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
};

const renderUsageHistorySections = () => {
  initUsageHistoryToggles();
  renderHourlyPattern(latestPowerStats);
  renderDailyHistory(latestPowerStats, latestPowerStatsTimeZone);
};

// Budget edits while the Usage tab is visible: `dailyBudget.ts` pushes every
// payload refresh into `activeDailyBudget.ts`, and on a value change this
// repaints the daily-history chart from the cached stats so the mark line,
// over-budget bar tinting, and readout budget context track the new budget
// without refetching power stats. No-op until the first `renderPowerStats`
// has populated the cache — boot resolves the budget payload before the
// first stats render, and that render reads the fresh value itself.
setActiveDailyBudgetChangeListener(() => {
  if (!powerStatsRendered) return;
  renderDailyHistory(latestPowerStats, latestPowerStatsTimeZone);
});

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
  const derivedHourlyAverages = mergeHourlyAverages(
    tracker.hourlyAverages as Record<string, { sum: number; count: number }> | null | undefined,
    tracker.buckets,
    timeZone,
  );
  const totals = getWeekMonthTotals(derivedDailyTotals, timeContext, today, timeZone);
  const averages = getWeekdayWeekendAverages(derivedDailyTotals, timeContext.todayKey, timeZone);
  const hourlyPatternAll = buildHourlyPattern(derivedHourlyAverages);
  const hourlyPatternWeekday = buildHourlyPattern(derivedHourlyAverages, (d) => d >= 1 && d <= 5);
  const hourlyPatternWeekend = buildHourlyPattern(derivedHourlyAverages, (d) => d === 0 || d === 6);
  const hourlyPatternMeta = getHourlyPatternMeta(tracker.buckets, timeZone);
  const dailyHistory = buildDailyHistory(derivedDailyTotals, timeContext.todayKey);
  // Producer-resolved: consumers (chart + readout) get a flat flag instead of
  // re-deriving bucket coverage for the window's oldest day.
  const dailyHistoryLeadingPartial = isLeadingHistoryDayPartial({
    history: dailyHistory,
    persistedDailyTotals: tracker.dailyTotals,
    buckets: tracker.buckets,
    timeZone,
  });

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
      dailyHistoryLeadingPartial,
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

// Drops the first-paint loading skeleton on the Usage panel by flipping
// `#usage-panel[data-loading]` to `"false"`. CSS hides the populated
// hero/cards/footer while loading and hides the skeleton afterwards, so the
// panel never shows a half-populated `-- kWh` wall during the bootstrap fetch.
const clearUsagePanelLoadingState = (): void => {
  const panel = document.getElementById('usage-panel');
  if (panel && panel.dataset.loading !== 'false') {
    panel.dataset.loading = 'false';
  }
};

export const renderPowerStats = async () => {
  try {
    const { stats, timeZone } = await getPowerStats();
    latestPowerStats = stats;
    latestPowerStatsTimeZone = timeZone;
    powerStatsRendered = true;
    renderPowerSummary(stats, timeZone);
    renderPowerAverages(stats);
    renderUsageHistorySections();
  } finally {
    // Always drop the first-paint skeleton, even if `getPowerStats` rejected —
    // otherwise the panel sits behind the shimmer forever. The static
    // `-- kWh` placeholders in `index.html` are the graceful no-data state.
    clearUsagePanelLoadingState();
  }
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
    readoutHost: powerWeekReadout,
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
