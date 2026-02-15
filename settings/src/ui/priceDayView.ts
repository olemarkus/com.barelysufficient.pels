import type { CombinedPriceData, PriceEntry } from './priceTypes';
import {
  priceDayTitle,
  priceDayLabel,
  priceDayStatusPill,
  priceDayToggleToday,
  priceDayToggleTomorrow,
  priceDayNowLabel,
  priceDayNow,
  priceDayAvg,
  priceDayRange,
  priceDayChart,
  priceDayBars,
  priceDayLabels,
  priceDayLegend,
  priceDayEmpty,
  priceDayMeta,
} from './dom';
import { getHomeyTimezone } from './homey';
import { renderDayViewChart, type DayViewBar } from './dayViewChart';
import {
  formatDateInTimeZone,
  formatTimeInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from './timezone';
import {
  formatChipPrice,
  formatPriceWithUnit,
  resolvePriceScheme,
  resolvePriceUnit,
  sortEntriesByStart,
  type PriceScheme,
} from './priceRenderUtils';

type PriceDayView = 'today' | 'tomorrow';

type TimedPriceEntry = {
  entry: PriceEntry;
  timestamp: number;
};

type SelectedDay = {
  selectedKey: string;
  entries: TimedPriceEntry[];
  requestedView: PriceDayView;
  title: string;
  label: string;
  isToday: boolean;
  isTomorrow: boolean;
  hasTomorrowData: boolean;
};

const HOUR_MS = 60 * 60 * 1000;
let currentDayView: PriceDayView = 'today';
let latestData: CombinedPriceData | null = null;
let handlersReady = false;

const isCurrentHourEntry = (timestamp: number, nowMs: number) => nowMs >= timestamp && nowMs < timestamp + HOUR_MS;

const setToggleState = () => {
  const options = [
    { view: 'today', element: priceDayToggleToday },
    { view: 'tomorrow', element: priceDayToggleTomorrow },
  ] as const;
  options.forEach(({ view, element }) => {
    if (!element) return;
    const active = currentDayView === view;
    element.classList.toggle('is-active', active);
    element.setAttribute('aria-pressed', String(active));
  });
};

const setStatus = (text: string, tone?: 'ok' | 'warn') => {
  if (!priceDayStatusPill) return;
  priceDayStatusPill.textContent = text;
  priceDayStatusPill.classList.remove('ok', 'warn');
  if (tone) priceDayStatusPill.classList.add(tone);
};

const setSummaryValue = (element: HTMLElement | null, text: string, empty = false) => {
  const target = element;
  if (!target) return;
  target.textContent = text;
  target.classList.toggle('summary-value--empty', empty);
};

const formatValue = (value: number, scheme: PriceScheme, unit: string) => (
  formatPriceWithUnit(formatChipPrice(value, scheme), unit)
);

const resolveSelectedDayTitle = (isToday: boolean, isTomorrow: boolean): string => {
  if (isToday) return 'Today prices';
  if (isTomorrow) return 'Tomorrow prices';
  return 'Selected day prices';
};

const selectDayEntries = (params: {
  entries: TimedPriceEntry[];
  now: Date;
  timeZone: string;
}): SelectedDay => {
  const { entries, now, timeZone } = params;
  const byDate = new Map<string, TimedPriceEntry[]>();
  entries.forEach((timed) => {
    const key = getDateKeyInTimeZone(new Date(timed.timestamp), timeZone);
    const current = byDate.get(key);
    if (current) current.push(timed);
    else byDate.set(key, [timed]);
  });

  const dayKeys = Array.from(byDate.keys()).sort();
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const todayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
  const tomorrowStartUtcMs = getNextLocalDayStartUtcMs(todayStartUtcMs, timeZone);
  const tomorrowKey = getDateKeyInTimeZone(new Date(tomorrowStartUtcMs), timeZone);
  const requestedView = currentDayView;
  const requestedKey = requestedView === 'tomorrow' ? tomorrowKey : todayKey;

  let selectedKey = requestedKey;
  let selectedEntries = byDate.get(requestedKey) ?? [];
  const hasTomorrowData = (byDate.get(tomorrowKey)?.length ?? 0) > 0;
  if (!selectedEntries.length && requestedView === 'tomorrow' && (byDate.get(todayKey)?.length ?? 0) > 0) {
    selectedKey = todayKey;
    selectedEntries = byDate.get(todayKey) ?? [];
  }
  if (!selectedEntries.length && dayKeys.length) {
    if (requestedView === 'today') {
      selectedKey = requestedKey;
      selectedEntries = [];
    } else {
      selectedKey = dayKeys[0];
      selectedEntries = byDate.get(selectedKey) ?? [];
    }
  }

  const isToday = selectedKey === todayKey;
  const isTomorrow = selectedKey === tomorrowKey;
  const dayStart = new Date(getDateKeyStartMs(selectedKey, timeZone));
  const title = resolveSelectedDayTitle(isToday, isTomorrow);
  const label = `${formatDateInTimeZone(dayStart, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone)} · ${timeZone}`;

  return {
    selectedKey,
    entries: selectedEntries,
    requestedView,
    title,
    label,
    isToday,
    isTomorrow,
    hasTomorrowData,
  };
};

const getSegmentClass = (entry: PriceEntry): string => {
  if (entry.isCheap) return 'day-view-bar__segment--cheap';
  if (entry.isExpensive) return 'day-view-bar__segment--expensive';
  return 'day-view-bar__segment--normal';
};

const buildBars = (entries: TimedPriceEntry[], nowMs: number, timeZone: string, scheme: PriceScheme, unit: string): DayViewBar[] => (
  entries.map(({ entry, timestamp }) => {
    const isCurrent = isCurrentHourEntry(timestamp, nowMs);
    const timeLabel = formatTimeInTimeZone(new Date(timestamp), { hour: '2-digit', minute: '2-digit' }, timeZone);
    return {
      label: timeLabel,
      value: entry.total,
      state: isCurrent ? 'current' : undefined,
      className: 'price-day-bar',
      segments: [{ value: entry.total, className: getSegmentClass(entry) }],
      marker: isCurrent ? { value: entry.total, className: 'day-view-marker--now' } : undefined,
      title: `${timeLabel} · ${formatValue(entry.total, scheme, unit)}`,
    };
  })
);

const renderEmptyState = () => {
  if (!priceDayTitle || !priceDayLabel || !priceDayChart || !priceDayEmpty) return;
  if (currentDayView === 'tomorrow') {
    priceDayTitle.textContent = 'Tomorrow prices';
  } else {
    priceDayTitle.textContent = 'Today prices';
  }
  priceDayLabel.textContent = '--';
  if (priceDayMeta) priceDayMeta.textContent = 'Hourly prices in your local day.';
  if (priceDayNowLabel) {
    priceDayNowLabel.textContent = currentDayView === 'tomorrow' ? 'Cheapest' : 'Now';
  }
  setSummaryValue(priceDayNow, '--', true);
  setSummaryValue(priceDayAvg, '--', true);
  setSummaryValue(priceDayRange, '--', true);
  priceDayEmpty.hidden = false;
  priceDayChart.hidden = true;
  if (priceDayLegend) priceDayLegend.hidden = true;
  setStatus('No data');
  setToggleState();
};

const ensureHandlers = () => {
  if (handlersReady) return;
  handlersReady = true;

  priceDayToggleToday?.addEventListener('click', () => {
    if (currentDayView === 'today') return;
    currentDayView = 'today';
    renderPriceDayView(latestData);
  });
  priceDayToggleTomorrow?.addEventListener('click', () => {
    if (currentDayView === 'tomorrow') return;
    currentDayView = 'tomorrow';
    renderPriceDayView(latestData);
  });
};

type PriceDayRenderInput = {
  selected: SelectedDay;
  nowMs: number;
  timeZone: string;
  scheme: PriceScheme;
  unit: string;
};

const buildRenderInput = (data: CombinedPriceData): PriceDayRenderInput | null => {
  const timeZone = getHomeyTimezone();
  const now = new Date();
  const nowMs = now.getTime();
  const scheme = resolvePriceScheme(data);
  const unit = resolvePriceUnit(data, scheme);
  const timedEntries: TimedPriceEntry[] = sortEntriesByStart(data.prices);
  if (!timedEntries.length) return null;
  const selected = selectDayEntries({ entries: timedEntries, now, timeZone });
  if (!selected.entries.length) return null;
  return {
    selected,
    nowMs,
    timeZone,
    scheme,
    unit,
  };
};

const applySelectedDayState = (selected: SelectedDay) => {
  if (!priceDayTitle || !priceDayLabel || !priceDayChart || !priceDayEmpty) return;
  setToggleState();
  priceDayTitle.textContent = selected.title;
  priceDayLabel.textContent = selected.label;
  if (priceDayMeta) {
    priceDayMeta.textContent = `${selected.entries.length} hourly value${selected.entries.length === 1 ? '' : 's'} in local day view.`;
  }
  priceDayEmpty.hidden = true;
  priceDayChart.hidden = false;
  if (priceDayLegend) priceDayLegend.hidden = false;
};

const applySelectedDayStatus = (selected: SelectedDay) => {
  if (selected.requestedView === 'tomorrow' && !selected.hasTomorrowData) {
    setStatus('Tomorrow unavailable', 'warn');
    return;
  }
  if (selected.isToday) {
    setStatus('Live', 'ok');
    return;
  }
  setStatus('Forecast', 'ok');
};

const applyNowSummary = (params: {
  selected: SelectedDay;
  nowMs: number;
  scheme: PriceScheme;
  unit: string;
}) => {
  const { selected, nowMs, scheme, unit } = params;
  if (priceDayNowLabel) {
    priceDayNowLabel.textContent = selected.isToday ? 'Now' : 'Cheapest';
  }
  const current = selected.entries.find((timed) => isCurrentHourEntry(timed.timestamp, nowMs));
  const cheapest = selected.entries.reduce(
    (min, timed) => (timed.entry.total < min.entry.total ? timed : min),
  );
  let nowText = formatValue(cheapest.entry.total, scheme, unit);
  let isEmpty = false;
  if (selected.isToday) {
    if (current) {
      nowText = formatValue(current.entry.total, scheme, unit);
    } else {
      nowText = '--';
      isEmpty = true;
    }
  }
  setSummaryValue(priceDayNow, nowText, isEmpty);
};

const applyRangeSummary = (selected: SelectedDay, scheme: PriceScheme, unit: string) => {
  const totals = selected.entries.map((timed) => timed.entry.total);
  const avg = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  setSummaryValue(priceDayAvg, formatValue(avg, scheme, unit));
  setSummaryValue(priceDayRange, `${formatValue(min, scheme, unit)} - ${formatValue(max, scheme, unit)}`);
};

export const renderPriceDayView = (data: CombinedPriceData | null) => {
  ensureHandlers();
  latestData = data;

  if (!priceDayTitle || !priceDayLabel || !priceDayChart || !priceDayBars || !priceDayLabels || !priceDayEmpty) return;
  if (!data || !Array.isArray(data.prices) || data.prices.length === 0) {
    renderEmptyState();
    return;
  }

  const renderInput = buildRenderInput(data);
  if (!renderInput) {
    renderEmptyState();
    return;
  }
  const {
    selected,
    nowMs,
    timeZone,
    scheme,
    unit,
  } = renderInput;

  applySelectedDayState(selected);
  applySelectedDayStatus(selected);
  applyNowSummary({ selected, nowMs, scheme, unit });
  applyRangeSummary(selected, scheme, unit);

  renderDayViewChart({
    bars: buildBars(selected.entries, nowMs, timeZone, scheme, unit),
    barsEl: priceDayBars,
    labelsEl: priceDayLabels,
  });
};
