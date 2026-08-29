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
import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import {
  disposePowerWeekChart,
  renderPowerWeekChart,
  resolvePowerWeekChartValueRange,
} from './powerWeekChartEcharts.ts';
import { getApiReadModel, getHomeyTimezone } from './homey.ts';
import { getHomeScope } from './homeScope.ts';
import { readUsagePower } from './usagePowerRead.ts';
import { createToggleGroup } from './components.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import { buildDayContext } from '../../../shared-domain/src/dailyBudget/dayContext.ts';
import {
  HOME_SCOPE_USAGE_UNAVAILABLE_BODY,
  HOME_SCOPE_USAGE_UNAVAILABLE_HEADLINE,
} from '../../../shared-domain/src/homeScopeCopy.ts';
import {
  formatPowerUsageEmptyAwaitingSamples,
  formatPowerUsageEmptyForMeterArea,
  formatPowerUsageEmptyForWeek,
} from '../../../shared-domain/src/powerUsageStrings.ts';
import { initUsageDayViewHandlers, renderUsageDayView, type UsageDayEntry } from './usageDayView.ts';
import { resolveUsageSplit } from './powerUsageSplit.ts';
import {
  renderDailyHistoryChartEcharts,
  renderHourlyPatternChartEcharts,
} from './usageStatsChartsEcharts.ts';
import { getActiveDailyBudgetKWh, setActiveDailyBudgetChangeListener } from './activeDailyBudget.ts';
import { renderSolarUsageSection } from './solarUsageSection.ts';
import {
  formatDayFirstInTimeZone,
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

type PowerUsageEntry = UsageDayEntry;
type UsagePowerRead = Awaited<ReturnType<typeof readUsagePower>>;
type ServedUsagePowerRead = Extract<UsagePowerRead, { state: 'served' }>;

type HourlyPatternView = 'all' | 'weekday' | 'weekend';
const MIN_RELIABLE_SAMPLES_PER_HOUR = 2;
// Daily history shows the last 14 days — the full window the tracker retains
// (week/month totals depend on the same cap); the rendered slice matches it.
const DAILY_HISTORY_DAYS = 14;
const ZERO_KWH_EPSILON = 1e-9;

const normalizeUsageKWh = (value: unknown): number => Math.max(0, Number(value) || 0);

const normalizeUsageBuckets = (
  buckets: Record<string, number> | null | undefined,
): Record<string, number> | undefined => {
  if (!buckets) return undefined;
  const normalized: Record<string, number> = {};
  for (const [iso, value] of Object.entries(buckets)) {
    normalized[iso] = normalizeUsageKWh(value);
  }
  return normalized;
};

const normalizeUsageHourlyAverages = (
  averages: Record<string, { sum: number; count: number }> | null | undefined,
): Record<string, { sum: number; count: number }> | undefined => {
  if (!averages) return undefined;
  const normalized: Record<string, { sum: number; count: number }> = {};
  for (const [key, value] of Object.entries(averages)) {
    normalized[key] = { ...value, sum: normalizeUsageKWh(value.sum) };
  }
  return normalized;
};

let powerUsageWeekOffset = 0;
let powerUsageEntries: PowerUsageEntry[] = [];
let powerUsageNavReady = false;
let latestPowerStats: PowerStatsSummary = getEmptyPowerStats();
let latestPowerStatsTimeZone = getHomeyTimezone();
let hourlyPatternView: HourlyPatternView = 'all';
let usageHistoryToggleReady = false;
let powerStatsRendered = false;
let setHourlyPatternToggleActive: (view: HourlyPatternView | null) => void = () => {};

// Whole-home only, deliberately: this reader flattens the payload, so it must
// never be handed a scoped read (an `unavailable` one would be
// indistinguishable from a measured idle). Its remaining consumer is the
// stale-data banner (`capacity.ts`), which is Main's surface. The Usage
// surface reads through `readUsagePower`, which follows the selected home and
// keeps the scope discriminated.
const getPowerReadModel = async (): Promise<SettingsUiPowerPayload> => {
  const payload = await getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
  return payload ?? { tracker: null, status: { state: 'unavailable', reason: 'read_failed' }, heartbeat: null };
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

// Day-first date labels ("15 May" / "Fri 15 May") via the shared
// `formatDayFirstInTimeZone` grammar — one grammar with the smart-task and
// day-card surfaces, English-pinned so CI (en-US default) never flips to
// month-first "May 15".
const formatWeekLabel = (startMs: number, endMs: number, timeZone: string) => {
  const start = new Date(startMs);
  const end = new Date(endMs - 1);
  const startText = formatDayFirstInTimeZone(start, { month: 'short', day: 'numeric' }, timeZone);
  const endText = formatDayFirstInTimeZone(end, { month: 'short', day: 'numeric' }, timeZone);
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

const renderPowerSummary = (
  stats: PowerStatsSummary,
  timeZone: string,
  solarSelfUsedKWh: number | null,
) => {
  const now = new Date();
  const todayText = formatDayFirstInTimeZone(now, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);

  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.week.toFixed(1)} kWh`;
  if (usageMonth) usageMonth.textContent = `${stats.month.toFixed(1)} kWh`;

  renderUsageHero(stats, timeZone, todayText, solarSelfUsedKWh);
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
    // range on read (see `activeDailyBudget.ts`). Main scope only: the daily
    // budget is a MAIN-home constraint (the service binds Main's tracker), so
    // overlaying it — and the readout's within/over-budget context — on a
    // meter area's history would claim the area is held to a budget it isn't.
    budgetKWh: getHomeScope().selectedHomeId === MAIN_HOME_ID ? getActiveDailyBudgetKWh() : undefined,
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
  const read = await readUsagePower();
  // An unavailable scoped read has NO stats — the empty summary here is only
  // a safe return shape for callers; `renderPowerStats` (the render owner)
  // discriminates the same read itself and never paints these as figures.
  return computePowerStats(read.state === 'served' ? read.payload.tracker : null);
};

const computePowerStats = (
  tracker: PowerTrackerState | null,
): { stats: PowerStatsSummary; timeZone: string } => {
  if (!tracker || typeof tracker !== 'object') {
    return { stats: getEmptyPowerStats(), timeZone: getHomeyTimezone() };
  }

  const now = new Date();
  const timeZone = getHomeyTimezone();
  const timeContext = getPowerTimeContext(now, timeZone);
  const usageBuckets = normalizeUsageBuckets(tracker.buckets);
  const usageDailyTotals = normalizeUsageBuckets(tracker.dailyTotals);
  const usageHourlyAverages = normalizeUsageHourlyAverages(
    tracker.hourlyAverages,
  );
  const dayContext = buildDayContext({
    nowMs: now.getTime(),
    timeZone,
    powerTracker: { ...tracker, buckets: usageBuckets },
  });
  const today = dayContext.usedNowKWh;
  const derivedDailyTotals = mergeDailyTotals(usageDailyTotals, usageBuckets, timeZone);
  const derivedHourlyAverages = mergeHourlyAverages(usageHourlyAverages, usageBuckets, timeZone);
  const totals = getWeekMonthTotals(derivedDailyTotals, timeContext, today, timeZone);
  const averages = getWeekdayWeekendAverages(derivedDailyTotals, timeContext.todayKey, timeZone);
  const hourlyPatternAll = buildHourlyPattern(derivedHourlyAverages);
  const hourlyPatternWeekday = buildHourlyPattern(derivedHourlyAverages, (d) => d >= 1 && d <= 5);
  const hourlyPatternWeekend = buildHourlyPattern(derivedHourlyAverages, (d) => d === 0 || d === 6);
  const hourlyPatternMeta = getHourlyPatternMeta(usageBuckets, timeZone);
  const dailyHistory = buildDailyHistory(derivedDailyTotals, timeContext.todayKey);
  // Producer-resolved: consumers (chart + readout) get a flat flag instead of
  // re-deriving bucket coverage for the window's oldest day.
  const dailyHistoryLeadingPartial = isLeadingHistoryDayPartial({
    history: dailyHistory,
    persistedDailyTotals: usageDailyTotals,
    buckets: usageBuckets,
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

export const getPowerUsageFromRead = (read: ServedUsagePowerRead): PowerUsageEntry[] => {
  const tracker = read.payload.tracker;
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];

  const unreliablePeriods = tracker.unreliablePeriods || [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      const start = date.getTime();
      const end = start + 3600000;
      const kWh = normalizeUsageKWh(value);
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

export const getPowerUsage = async (): Promise<PowerUsageEntry[]> => {
  const read = await readUsagePower();
  return read.state === 'served' ? getPowerUsageFromRead(read) : [];
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

/**
 * Put the Usage panel back into that same pending state, for a scope change:
 * the scope chip renames the panel SYNCHRONOUSLY while the newly picked home's
 * figures are still a read away, so without this the new home's name sits over
 * the previous home's hero, charts and solar card until it lands. Reusing the
 * first-paint skeleton contract (rather than a second "changing scope" visual)
 * keeps one honest pending state for "these numbers aren't resolved yet".
 *
 * Deliberately not gated on the panel being visible: an off-panel scope pick
 * leaves figures that a later tab open would otherwise flash before its own
 * refresh resolves, and the Usage activation hook always runs `refreshPowerData`
 * — so the state a hidden panel is left in is always cleared by the run that
 * repaints it.
 */
export const markUsagePanelPendingForScopeChange = (): void => {
  const panel = document.getElementById('usage-panel');
  if (panel) panel.dataset.loading = 'true';
};

// The panel-level honest state for a scoped read the runtime cannot serve
// (multi-home). `data-scope-read="unavailable"` hides the data sections via
// CSS — mirroring the `data-loading` skeleton contract — and the notice card
// becomes the only content, so zeros never masquerade as an area's history.
// Copy is populated here (not baked into the markup) so the words come from
// the shared-domain module the runtime shares.
const applyUsageScopeReadState = (state: 'served' | 'unavailable'): void => {
  const panel = document.getElementById('usage-panel');
  if (panel) panel.dataset.scopeRead = state;
  const notice = document.getElementById('usage-scope-unavailable');
  if (!notice) return;
  const headline = document.getElementById('usage-scope-unavailable-headline');
  if (headline) headline.textContent = HOME_SCOPE_USAGE_UNAVAILABLE_HEADLINE;
  const body = document.getElementById('usage-scope-unavailable-body');
  if (body) body.textContent = HOME_SCOPE_USAGE_UNAVAILABLE_BODY;
  notice.hidden = state !== 'unavailable';
};

/**
 * @param isCurrentRun Staleness gate owned by the caller's refresh pass
 * (`refreshPowerData`'s run generation): checked after every await, before the
 * paints that follow it, so a read that settles late — superseded by a newer
 * refresh, typically a scope pick mid-flight — is dropped instead of painting
 * a stale home's figures over the newer run's. Every production caller routes
 * through `refreshPowerData` (boot and the stats reset included), so the
 * always-current default is a test-only convenience.
 */
export const renderPowerStatsFromRead = async (
  read: UsagePowerRead,
  isCurrentRun: () => boolean = () => true,
) => {
  try {
    // ONE discriminated read drives this render pass: the honest-state flip,
    // the stats, and the solar card all resolve from the same payload.
    if (!isCurrentRun()) return;
    applyUsageScopeReadState(read.state);
    if (read.state === 'unavailable') return;
    const { stats, timeZone } = computePowerStats(read.payload.tracker);
    latestPowerStats = stats;
    latestPowerStatsTimeZone = timeZone;
    powerStatsRendered = true;
    // Solar card rides the same payload. Rendered FIRST so the hero summary
    // can carry the "+ … of your own solar" reconciliation line the section
    // resolves; the gate + degradation tiers live in the section itself. The
    // per-payload solar flag is scoped-safe: it never feeds the HOME-level
    // solar gates the devices reader owns.
    // The gate is handed IN because the section awaits its own prices read: a
    // check here would come back too late to stop it painting the card.
    const { todaySelfUsedKWh } = await renderSolarUsageSection({
      tracker: read.payload.tracker,
      timeZone,
      hasManagedSolarDevice: read.payload.hasManagedSolarDevice === true,
      isCurrentRun,
    });
    if (!isCurrentRun()) return;
    renderPowerSummary(stats, timeZone, todaySelfUsedKWh);
    renderPowerAverages(stats);
    renderUsageHistorySections();
  } finally {
    // Drop the skeleton, even if the read rejected — otherwise the panel sits
    // behind the shimmer forever. The static `-- kWh` placeholders in
    // `index.html` are the graceful no-data state.
    //
    // Only the CURRENT run may reveal the panel: after a scope change the
    // pending state belongs to the newly picked home's run, and a superseded
    // run reaching this point would lift the shimmer off the PREVIOUS home's
    // figures under the new home's name. The current run always gets here
    // (`finally` runs on the throwing path too), so nothing strands the panel.
    if (isCurrentRun()) clearUsagePanelLoadingState();
  }
};

export const renderPowerStats = async (isCurrentRun: () => boolean = () => true) => (
  renderPowerStatsFromRead(await readUsagePower(), isCurrentRun)
);

// Empty state for the selected week's hourly-detail chart (split out to keep
// `renderPowerUsage` within the cognitive-complexity lint budget). The
// awaiting-samples remedy (the Report power usage Flow action) is the MAIN
// home's setup path; a meter area with nothing recorded yet gets the plain
// fact instead.
const renderPowerWeekEmptyState = (hasAnyEntries: boolean): void => {
  if (!powerEmpty) return;
  const awaitingSamples = getHomeScope().selectedHomeId === MAIN_HOME_ID
    ? formatPowerUsageEmptyAwaitingSamples()
    : formatPowerUsageEmptyForMeterArea();
  powerEmpty.textContent = hasAnyEntries ? formatPowerUsageEmptyForWeek() : awaitingSamples;
  powerEmpty.hidden = false;
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
    renderPowerWeekEmptyState(entries.length > 0);
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
