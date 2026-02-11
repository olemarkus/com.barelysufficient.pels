import {
  usageDayTitle,
  usageDayLabel,
  usageDayStatusPill,
  usageDayToggleYesterday,
  usageDayToggleToday,
  usageDayTotal,
  usageDayPeak,
  usageDayOverCap,
  usageDayChart,
  usageDayBars,
  usageDayLabels,
  usageDayLegend,
  usageDayEmpty,
  usageDayMeta,
} from './dom';
import { getHomeyTimezone } from './homey';
import { renderDayViewChart, type DayViewBar } from './dayViewChart';
import {
  buildLocalDayBuckets,
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getStartOfDayInTimeZone,
} from './timezone';

type UsageDayView = 'today' | 'yesterday';

export type UsageDayEntry = {
  hour: Date;
  kWh: number;
  budgetKWh?: number;
  unreliable?: boolean;
};

type UsageDayBucket = {
  startMs: number;
  label: string;
  measuredKWh: number;
  budgetKWh: number | null;
  unreliable: boolean;
  hasMeasurement: boolean;
};

let usageDayView: UsageDayView = 'today';
let usageDayViewHandlersReady = false;
let latestEntries: UsageDayEntry[] = [];

const setUsageDayToggleState = () => {
  const options = [
    { view: 'today', element: usageDayToggleToday },
    { view: 'yesterday', element: usageDayToggleYesterday },
  ] as const;
  options.forEach(({ view, element }) => {
    if (!element) return;
    const active = usageDayView === view;
    element.classList.toggle('is-active', active);
    element.setAttribute('aria-pressed', String(active));
  });
};

const setUsageDayStatus = (text: string, tone?: 'ok' | 'warn') => {
  if (!usageDayStatusPill) return;
  usageDayStatusPill.textContent = text;
  usageDayStatusPill.classList.remove('ok', 'warn');
  if (tone) usageDayStatusPill.classList.add(tone);
};

const setUsageDaySummaryValue = (element: HTMLElement | null, text: string, empty = false) => {
  const target = element;
  if (!target) return;
  target.textContent = text;
  target.classList.toggle('summary-value--empty', empty);
};

const getUsageDayDateKey = (view: UsageDayView, now: Date, timeZone: string) => {
  if (view === 'today') return getDateKeyInTimeZone(now, timeZone);
  const todayStart = getStartOfDayInTimeZone(now, timeZone);
  return getDateKeyInTimeZone(new Date(todayStart - 60 * 1000), timeZone);
};

const formatUsageDayTitle = (view: UsageDayView) => (view === 'today' ? 'Today usage' : 'Yesterday usage');

const buildUsageDayBuckets = (
  entries: UsageDayEntry[],
  dateKey: string,
  timeZone: string,
): { buckets: UsageDayBucket[]; nextDayStartUtcMs: number } => {
  const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const entriesByStart = new Map<number, UsageDayEntry>();
  entries.forEach((entry) => {
    entriesByStart.set(entry.hour.getTime(), entry);
  });

  const buckets = bucketStartUtcMs.map((startMs, index) => {
    const entry = entriesByStart.get(startMs);
    const measuredKWh = entry?.kWh ?? 0;
    const budgetKWh = typeof entry?.budgetKWh === 'number' && entry.budgetKWh > 0 ? entry.budgetKWh : null;
    const unreliable = entry?.unreliable === true;
    return {
      startMs,
      label: bucketStartLocalLabels[index] ?? '',
      measuredKWh,
      budgetKWh,
      unreliable,
      hasMeasurement: Boolean(entry),
    };
  });
  return { buckets, nextDayStartUtcMs };
};

const getCurrentUsageDayBucketIndex = (buckets: UsageDayBucket[], nextDayStartUtcMs: number): number => {
  if (usageDayView !== 'today') return -1;
  const nowMs = Date.now();
  for (let index = 0; index < buckets.length; index += 1) {
    const bucketStart = buckets[index].startMs;
    const nextStart = buckets[index + 1]?.startMs ?? nextDayStartUtcMs;
    if (nowMs >= bucketStart && nowMs < nextStart) {
      return index;
    }
  }
  return -1;
};

const buildUsageDayBarTitle = (bucket: UsageDayBucket) => {
  const lines = [`${bucket.label}`, `Measured ${bucket.measuredKWh.toFixed(2)} kWh`];
  if (bucket.budgetKWh !== null) {
    lines.push(`Budget ${bucket.budgetKWh.toFixed(2)} kWh`);
    if (bucket.measuredKWh > bucket.budgetKWh + 0.001) {
      lines.push(`Over cap by ${(bucket.measuredKWh - bucket.budgetKWh).toFixed(2)} kWh`);
    }
  }
  if (bucket.unreliable) lines.push('Unreliable data');
  return lines.join(' · ');
};

const renderUsageDayHeader = (dateKey: string, timeZone: string) => {
  if (!usageDayTitle || !usageDayLabel) return;
  usageDayTitle.textContent = formatUsageDayTitle(usageDayView);
  const dayStart = new Date(getDateKeyStartMs(dateKey, timeZone));
  usageDayLabel.textContent = `${formatDateInTimeZone(dayStart, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }, timeZone)} · ${timeZone}`;
  if (usageDayMeta) {
    usageDayMeta.textContent = usageDayView === 'today'
      ? 'Hourly kWh within your local day (updates live).'
      : 'Hourly kWh for the previous local day.';
  }
};

const renderUsageDayNoData = () => {
  if (!usageDayEmpty || !usageDayChart) return;
  usageDayEmpty.hidden = false;
  usageDayChart.hidden = true;
  if (usageDayLegend) usageDayLegend.hidden = true;
  setUsageDayStatus('No data');
  setUsageDaySummaryValue(usageDayTotal, '-- kWh', true);
  setUsageDaySummaryValue(usageDayPeak, '-- kWh', true);
  setUsageDaySummaryValue(usageDayOverCap, '--', true);
};

const renderUsageDayHasData = (buckets: UsageDayBucket[]) => {
  if (!usageDayEmpty || !usageDayChart) return;
  usageDayEmpty.hidden = true;
  usageDayChart.hidden = false;
  if (usageDayLegend) usageDayLegend.hidden = false;

  const totalKWh = buckets.reduce((sum, bucket) => sum + bucket.measuredKWh, 0);
  const peakBucket = buckets.reduce((max, bucket) => (
    bucket.measuredKWh > max.measuredKWh ? bucket : max
  ), buckets[0]);
  const overCapHours = buckets.filter((bucket) => (
    bucket.budgetKWh !== null && bucket.measuredKWh > bucket.budgetKWh + 0.001
  )).length;
  const warnHours = buckets.filter((bucket) => (
    bucket.unreliable || (bucket.budgetKWh !== null && bucket.measuredKWh > bucket.budgetKWh + 0.001)
  )).length;

  setUsageDaySummaryValue(usageDayTotal, `${totalKWh.toFixed(1)} kWh`);
  setUsageDaySummaryValue(usageDayPeak, `${peakBucket.label} · ${peakBucket.measuredKWh.toFixed(2)} kWh`);
  setUsageDaySummaryValue(usageDayOverCap, overCapHours.toString());

  if (warnHours > 0) {
    setUsageDayStatus(`Attention (${warnHours}h)`, 'warn');
  } else if (usageDayView === 'today') {
    setUsageDayStatus('Live', 'ok');
  } else {
    setUsageDayStatus('Stable', 'ok');
  }
};

const getUsageDayBars = (buckets: UsageDayBucket[], currentBucketIndex: number): DayViewBar[] => (
  buckets.map((bucket, index) => {
    const isOverCap = bucket.budgetKWh !== null && bucket.measuredKWh > bucket.budgetKWh + 0.001;
    const warn = bucket.unreliable || isOverCap;
    let state: 'past' | 'current' | undefined;
    if (currentBucketIndex >= 0) {
      if (index < currentBucketIndex) state = 'past';
      if (index === currentBucketIndex) state = 'current';
    }
    return {
      label: bucket.label,
      value: bucket.measuredKWh,
      title: buildUsageDayBarTitle(bucket),
      state,
      className: warn ? 'usage-day-bar is-warn' : 'usage-day-bar',
      segments: [{ value: bucket.measuredKWh, className: 'day-view-bar__segment--measured' }],
      marker: bucket.budgetKWh !== null
        ? {
          value: bucket.budgetKWh,
          className: 'day-view-marker--budget',
        }
        : undefined,
    };
  })
);

export const renderUsageDayView = (entries: UsageDayEntry[]) => {
  latestEntries = entries;
  if (!usageDayTitle || !usageDayLabel || !usageDayChart || !usageDayBars || !usageDayLabels || !usageDayEmpty) return;

  const timeZone = getHomeyTimezone();
  const now = new Date();
  const dateKey = getUsageDayDateKey(usageDayView, now, timeZone);
  const { buckets, nextDayStartUtcMs } = buildUsageDayBuckets(entries, dateKey, timeZone);
  const currentBucketIndex = getCurrentUsageDayBucketIndex(buckets, nextDayStartUtcMs);
  renderUsageDayHeader(dateKey, timeZone);

  const hasData = buckets.some((bucket) => bucket.hasMeasurement);
  if (!hasData) {
    renderUsageDayNoData();
    setUsageDayToggleState();
    return;
  }

  renderUsageDayHasData(buckets);

  renderDayViewChart({
    bars: getUsageDayBars(buckets, currentBucketIndex),
    barsEl: usageDayBars,
    labelsEl: usageDayLabels,
  });
  setUsageDayToggleState();
};

const setUsageDayView = (view: UsageDayView) => {
  if (usageDayView === view) return;
  usageDayView = view;
  renderUsageDayView(latestEntries);
};

export const initUsageDayViewHandlers = () => {
  if (usageDayViewHandlersReady) return;
  usageDayViewHandlersReady = true;
  usageDayToggleToday?.addEventListener('click', () => setUsageDayView('today'));
  usageDayToggleYesterday?.addEventListener('click', () => setUsageDayView('yesterday'));
  setUsageDayToggleState();
};
