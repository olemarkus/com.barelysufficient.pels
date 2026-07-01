import {
  usageDayTitle,
  usageDayLabel,
  usageDayStatusPill,
  usageDayTotal,
  usageDayPeak,
  usageDayOverCap,
  usageDayChart,
  usageDayBars,
  usageDayLabels,
  usageDayEmpty,
  usageDayMeta,
  usageDayReadout,
} from './dom.ts';
import { getHomeyTimezone } from './homey.ts';
import { createToggleGroup } from './components.ts';
import type { DayViewBar } from './dayViewChart.ts';
import { buildUsageDayReadout, type ChartReadoutContent } from './chartTooltipFormat.ts';
import { renderUsageDayChartEcharts, type UsageDaySplit } from './usageDayChartEcharts.ts';
import {
  buildLocalDayBuckets,
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getStartOfDayInTimeZone,
} from './timezone.ts';

type UsageDayView = 'today' | 'yesterday';

export type UsageDayEntry = {
  hour: Date;
  kWh: number;
  budgetKWh?: number;
  controlledKWh?: number;
  uncontrolledKWh?: number;
  unreliable?: boolean;
};

type UsageDayBucket = {
  startMs: number;
  label: string;
  measuredKWh: number;
  budgetKWh: number | null;
  controlledKWh: number | null;
  uncontrolledKWh: number | null;
  unreliable: boolean;
  hasMeasurement: boolean;
};

let usageDayView: UsageDayView = 'today';
let usageDayViewHandlersReady = false;
let latestEntries: UsageDayEntry[] = [];
let setUsageDayToggleActive: (view: UsageDayView | null) => void = () => {};

const setUsageDayStatus = (text: string, tone?: 'ok' | 'warn') => {
  if (!usageDayStatusPill) return;
  if (tone === 'warn') {
    usageDayStatusPill.textContent = text;
    usageDayStatusPill.classList.remove('plan-chip--muted', 'plan-chip--ok');
    usageDayStatusPill.classList.add('plan-chip--warn');
    usageDayStatusPill.hidden = false;
  } else {
    usageDayStatusPill.hidden = true;
  }
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

const formatUsageDayTitle = (view: UsageDayView) => (
  view === 'today' ? 'Today so far' : 'Yesterday'
);

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
    const controlledKWh = typeof entry?.controlledKWh === 'number' && Number.isFinite(entry.controlledKWh)
      ? entry.controlledKWh
      : null;
    const uncontrolledKWh = typeof entry?.uncontrolledKWh === 'number' && Number.isFinite(entry.uncontrolledKWh)
      ? entry.uncontrolledKWh
      : null;
    const unreliable = entry?.unreliable === true;
    return {
      startMs,
      label: bucketStartLocalLabels[index] ?? '',
      measuredKWh,
      budgetKWh,
      controlledKWh,
      uncontrolledKWh,
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

// Structured per-bucket content for the tooltip + pinned readout (one
// grammar, identical information on both surfaces). The hour range ends at
// the next bucket's local label so DST-shifted buckets stay honest; the last
// bucket closes the day at 00:00. `inProgress` marks the current hour on the
// Today view — its measurement is still accumulating, so the readout reads
// `Measured … kWh so far`. Exported for unit tests.
export const buildUsageDayBucketReadout = (
  bucket: Pick<UsageDayBucket, 'label' | 'measuredKWh' | 'controlledKWh' | 'uncontrolledKWh' | 'unreliable'>,
  nextLabel: string | undefined,
  inProgress = false,
): ChartReadoutContent => buildUsageDayReadout({
  hourRange: `${bucket.label}–${nextLabel ?? '00:00'}`,
  measuredKWh: bucket.measuredKWh,
  managedKWh: bucket.controlledKWh,
  backgroundKWh: bucket.uncontrolledKWh,
  unreliable: bucket.unreliable,
  inProgress,
});

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
      ? 'Hourly kWh within your local day (updates live). '
        + 'Typical usage below is per-hour average; daily history is one bar per day.'
      : 'Hourly kWh for the previous local day. '
        + 'Typical usage below is per-hour average; daily history is one bar per day.';
  }
};

const renderUsageDayNoData = () => {
  if (!usageDayEmpty || !usageDayChart) return;
  usageDayEmpty.hidden = false;
  usageDayChart.hidden = true;
  // The pinned readout row lives OUTSIDE #usage-day-chart, so hiding the
  // chart alone would leave the previous day's readout visible under the
  // "no data" message when the user switches to an empty day. Clear and hide
  // it here; the next data render re-shows it (`renderUsageDayChartEcharts`
  // unhides the host and re-renders the selection on every chart render).
  if (usageDayReadout) {
    usageDayReadout.replaceChildren();
    usageDayReadout.hidden = true;
  }
  setUsageDayStatus('No data');
  setUsageDaySummaryValue(usageDayTotal, '-- kWh', true);
  setUsageDaySummaryValue(usageDayPeak, '-- kWh', true);
  setUsageDaySummaryValue(usageDayOverCap, '--', true);
};

const renderUsageDayHasData = (buckets: UsageDayBucket[]) => {
  if (!usageDayEmpty || !usageDayChart) return;
  usageDayEmpty.hidden = true;
  usageDayChart.hidden = false;

  const totalKWh = buckets.reduce((sum, bucket) => sum + bucket.measuredKWh, 0);
  const peakBucket = buckets.reduce((max, bucket) => (
    bucket.measuredKWh > max.measuredKWh ? bucket : max
  ), buckets[0]);
  const warnHours = buckets.filter((bucket) => bucket.unreliable).length;

  setUsageDaySummaryValue(usageDayTotal, `${totalKWh.toFixed(1)} kWh`);
  setUsageDaySummaryValue(usageDayPeak, `${peakBucket.label} · ${peakBucket.measuredKWh.toFixed(2)} kWh`);
  setUsageDaySummaryValue(usageDayOverCap, warnHours.toString());

  if (warnHours > 0) {
    setUsageDayStatus(`Warnings (${warnHours}h)`, 'warn');
  } else if (usageDayView === 'today') {
    setUsageDayStatus('Live', 'ok');
  } else {
    setUsageDayStatus('Stable', 'ok');
  }
};

const getUsageDayBars = (buckets: UsageDayBucket[], currentBucketIndex: number): DayViewBar[] => (
  buckets.map((bucket, index) => {
    const warn = bucket.unreliable;
    let state: 'past' | 'current' | undefined;
    if (currentBucketIndex >= 0) {
      if (index < currentBucketIndex) state = 'past';
      if (index === currentBucketIndex) state = 'current';
    }
    return {
      label: bucket.label,
      value: bucket.measuredKWh,
      state,
      className: warn ? 'usage-day-bar is-warn' : 'usage-day-bar',
    };
  })
);

// Per-hour managed/background split feeding the chart's stacked bars. Both
// halves must exist (the shared resolver returns them as a pair); hours
// without a split render as a single Measured-toned bar. The same bucket
// values feed the readout via `buildUsageDayBucketReadout`, so the stack and
// the tapped-hour numbers reconcile by construction.
const getUsageDaySplits = (buckets: UsageDayBucket[]): Array<UsageDaySplit | null> => (
  buckets.map((bucket) => (
    bucket.controlledKWh !== null && bucket.uncontrolledKWh !== null
      ? { managedKWh: bucket.controlledKWh, backgroundKWh: bucket.uncontrolledKWh }
      : null
  ))
);

// Default readout selection: the current hour on the Today view (the most
// informative point while the day is in progress), the peak hour otherwise.
const getDefaultReadoutIndex = (buckets: UsageDayBucket[], currentBucketIndex: number): number => {
  if (currentBucketIndex >= 0) return currentBucketIndex;
  let peak = 0;
  for (let index = 1; index < buckets.length; index += 1) {
    if (buckets[index].measuredKWh > buckets[peak].measuredKWh) peak = index;
  }
  return peak;
};

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
    setUsageDayToggleActive(usageDayView);
    return;
  }

  renderUsageDayHasData(buckets);

  const bars = getUsageDayBars(buckets, currentBucketIndex);
  const labels = buckets.map((bucket) => bucket.label);
  const readouts = buckets.map((bucket, index) => (
    buildUsageDayBucketReadout(bucket, buckets[index + 1]?.label, index === currentBucketIndex)
  ));
  const renderedWithEcharts = renderUsageDayChartEcharts({
    bars,
    splits: getUsageDaySplits(buckets),
    labels,
    readouts,
    readoutHost: usageDayReadout,
    defaultReadoutIndex: getDefaultReadoutIndex(buckets, currentBucketIndex),
    currentBucketIndex,
    enabled: true,
    barsEl: usageDayBars,
    labelsEl: usageDayLabels,
  });
  if (!renderedWithEcharts) {
    usageDayBars.replaceChildren();
    usageDayLabels.replaceChildren();
    usageDayLabels.hidden = true;
  }
  setUsageDayToggleActive(usageDayView);
};

const setUsageDayView = (view: UsageDayView) => {
  if (usageDayView === view) return;
  usageDayView = view;
  renderUsageDayView(latestEntries);
};

export const initUsageDayViewHandlers = () => {
  if (usageDayViewHandlersReady) return;
  usageDayViewHandlersReady = true;
  const toggleMount = document.getElementById('usage-day-toggle-mount');
  if (toggleMount) {
    const { element, setActive } = createToggleGroup(
      [
        { value: 'yesterday' as const, label: 'Yesterday' },
        { value: 'today' as const, label: 'Today' },
      ],
      'Usage day view',
      setUsageDayView,
    );
    toggleMount.replaceWith(element);
    setUsageDayToggleActive = setActive;
  }
  setUsageDayToggleActive(usageDayView);
};
