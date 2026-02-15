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
  usageDayLegendPrice,
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
type UsageDayBarState = 'past' | 'current' | undefined;
type PriceTone = 'Cheap' | 'Normal' | 'Expensive';

export type UsageDayEntry = {
  hour: Date;
  kWh: number;
  budgetKWh?: number;
  controlledKWh?: number;
  uncontrolledKWh?: number;
  priceTotal?: number;
  priceIsCheap?: boolean;
  priceIsExpensive?: boolean;
  priceUnit?: string;
  unreliable?: boolean;
};

type UsageDayBucket = {
  startMs: number;
  label: string;
  measuredKWh: number;
  budgetKWh: number | null;
  controlledKWh: number | null;
  uncontrolledKWh: number | null;
  priceTotal: number | null;
  priceIsCheap: boolean;
  priceIsExpensive: boolean;
  priceUnit: string | null;
  unreliable: boolean;
  hasMeasurement: boolean;
};

let usageDayView: UsageDayView = 'today';
let usageDayViewHandlersReady = false;
let latestEntries: UsageDayEntry[] = [];
const OVER_CAP_EPSILON = 0.001;

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

const getFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const getPositiveFiniteNumber = (value: unknown): number | null => {
  const parsed = getFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const getNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

type UsageDayBucketValues = Omit<UsageDayBucket, 'startMs' | 'label'>;

const buildUsageDayBucketValues = (entry: UsageDayEntry | undefined): UsageDayBucketValues => ({
  measuredKWh: getFiniteNumber(entry?.kWh) ?? 0,
  budgetKWh: getPositiveFiniteNumber(entry?.budgetKWh),
  controlledKWh: getFiniteNumber(entry?.controlledKWh),
  uncontrolledKWh: getFiniteNumber(entry?.uncontrolledKWh),
  priceTotal: getFiniteNumber(entry?.priceTotal),
  priceIsCheap: entry?.priceIsCheap === true,
  priceIsExpensive: entry?.priceIsExpensive === true,
  priceUnit: getNonEmptyString(entry?.priceUnit),
  unreliable: entry?.unreliable === true,
  hasMeasurement: Boolean(entry),
});

const isUsageDayOverCap = (bucket: Pick<UsageDayBucket, 'budgetKWh' | 'measuredKWh'>): boolean => (
  bucket.budgetKWh !== null && bucket.measuredKWh > bucket.budgetKWh + OVER_CAP_EPSILON
);

const getPriceTone = (bucket: Pick<UsageDayBucket, 'priceIsCheap' | 'priceIsExpensive'>): PriceTone => {
  if (bucket.priceIsCheap) return 'Cheap';
  if (bucket.priceIsExpensive) return 'Expensive';
  return 'Normal';
};

const getPriceMarkerToneClass = (bucket: Pick<UsageDayBucket, 'priceIsCheap' | 'priceIsExpensive'>): string => {
  if (bucket.priceIsCheap) return 'day-view-marker--price-cheap';
  if (bucket.priceIsExpensive) return 'day-view-marker--price-expensive';
  return 'day-view-marker--price-normal';
};

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
    const values = buildUsageDayBucketValues(entry);
    return {
      startMs,
      label: bucketStartLocalLabels[index] ?? '',
      ...values,
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
  if (bucket.controlledKWh !== null && bucket.uncontrolledKWh !== null) {
    lines.push(`Controlled ${bucket.controlledKWh.toFixed(2)} kWh`);
    lines.push(`Uncontrolled ${bucket.uncontrolledKWh.toFixed(2)} kWh`);
  }
  if (bucket.priceTotal !== null) {
    const priceTone = getPriceTone(bucket);
    const unitSuffix = bucket.priceUnit ? ` ${bucket.priceUnit}` : '';
    lines.push(`Price ${bucket.priceTotal.toFixed(1)}${unitSuffix} (${priceTone})`);
  }
  if (bucket.budgetKWh !== null) {
    lines.push(`Budget ${bucket.budgetKWh.toFixed(2)} kWh`);
    if (isUsageDayOverCap(bucket)) {
      lines.push(`Over cap by ${(bucket.measuredKWh - bucket.budgetKWh).toFixed(2)} kWh`);
    }
  }
  if (bucket.unreliable) lines.push('Unreliable data');
  return lines.join(' · ');
};

const getUsageDayMetaText = (view: UsageDayView, hasPriceOverlay: boolean): string => {
  if (hasPriceOverlay) {
    if (view === 'today') {
      return 'Hourly kWh with relative price overlay in your local day (updates live).';
    }
    return 'Hourly kWh with relative price overlay for the previous local day.';
  }
  if (view === 'today') {
    return 'Hourly kWh within your local day (updates live).';
  }
  return 'Hourly kWh for the previous local day.';
};

const renderUsageDayHeader = (dateKey: string, timeZone: string, hasPriceOverlay: boolean) => {
  if (!usageDayTitle || !usageDayLabel) return;
  usageDayTitle.textContent = formatUsageDayTitle(usageDayView);
  const dayStart = new Date(getDateKeyStartMs(dateKey, timeZone));
  usageDayLabel.textContent = `${formatDateInTimeZone(dayStart, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }, timeZone)} · ${timeZone}`;
  if (usageDayMeta) {
    usageDayMeta.textContent = getUsageDayMetaText(usageDayView, hasPriceOverlay);
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
  const overCapHours = buckets.filter((bucket) => isUsageDayOverCap(bucket)).length;
  const warnHours = buckets.filter((bucket) => (
    bucket.unreliable || isUsageDayOverCap(bucket)
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

const getUsageOverlayMax = (buckets: UsageDayBucket[]): number => (
  buckets.reduce((max, bucket) => (
    Math.max(max, bucket.measuredKWh, bucket.budgetKWh ?? 0)
  ), 0)
);

type UsageDayPriceRange = {
  min: number;
  max: number;
};

const getUsageDayPriceRange = (buckets: UsageDayBucket[]): UsageDayPriceRange | null => {
  const priceValues = buckets
    .map((bucket) => bucket.priceTotal)
    .filter((value): value is number => value !== null);
  if (!priceValues.length) return null;
  return {
    min: Math.min(...priceValues),
    max: Math.max(...priceValues),
  };
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const getUsageDayPriceMarkerValue = (
  bucket: UsageDayBucket,
  usageOverlayMax: number,
  priceRange: UsageDayPriceRange | null,
): number | null => {
  if (bucket.priceTotal === null || usageOverlayMax <= 0 || priceRange === null) return null;
  const span = priceRange.max - priceRange.min;
  if (span <= OVER_CAP_EPSILON) {
    return usageOverlayMax * 0.5;
  }
  const normalized = clamp((bucket.priceTotal - priceRange.min) / span, 0, 1);
  return usageOverlayMax * normalized;
};

const getUsageDayBarState = (index: number, currentBucketIndex: number): UsageDayBarState => {
  if (currentBucketIndex < 0) return undefined;
  if (index < currentBucketIndex) return 'past';
  if (index === currentBucketIndex) return 'current';
  return undefined;
};

const getUsageDayBars = (buckets: UsageDayBucket[], currentBucketIndex: number): DayViewBar[] => {
  const usageOverlayMax = getUsageOverlayMax(buckets);
  const priceRange = getUsageDayPriceRange(buckets);

  return buckets.map((bucket, index) => {
    const warn = bucket.unreliable || isUsageDayOverCap(bucket);
    const markerValue = getUsageDayPriceMarkerValue(bucket, usageOverlayMax, priceRange);
    const marker = markerValue === null
      ? undefined
      : {
        value: markerValue,
        className: `day-view-marker--price ${getPriceMarkerToneClass(bucket)}`,
      };

    return {
      label: bucket.label,
      value: bucket.measuredKWh,
      title: buildUsageDayBarTitle(bucket),
      state: getUsageDayBarState(index, currentBucketIndex),
      className: warn ? 'usage-day-bar is-warn' : 'usage-day-bar',
      segments: [{ value: bucket.measuredKWh, className: 'day-view-bar__segment--measured' }],
      marker,
    };
  });
};

export const renderUsageDayView = (entries: UsageDayEntry[]) => {
  latestEntries = entries;
  if (!usageDayTitle || !usageDayLabel || !usageDayChart || !usageDayBars || !usageDayLabels || !usageDayEmpty) return;

  const timeZone = getHomeyTimezone();
  const now = new Date();
  const dateKey = getUsageDayDateKey(usageDayView, now, timeZone);
  const { buckets, nextDayStartUtcMs } = buildUsageDayBuckets(entries, dateKey, timeZone);
  const currentBucketIndex = getCurrentUsageDayBucketIndex(buckets, nextDayStartUtcMs);
  const hasPriceOverlay = buckets.some((bucket) => bucket.priceTotal !== null);
  renderUsageDayHeader(dateKey, timeZone, hasPriceOverlay);
  if (usageDayLegendPrice) {
    usageDayLegendPrice.hidden = !hasPriceOverlay;
  }

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
