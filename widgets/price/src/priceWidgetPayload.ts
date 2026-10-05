import type {
  PriceTimeline,
  PriceTimelinePeriod,
  PriceTimelineRead,
} from '../../../packages/contracts/src/priceTimeline';
import {
  getDateKeyInTimeZone,
  getZonedParts,
  shiftDateKey,
  getDateKeyStartMs,
} from '../../../packages/shared-domain/src/utils/dateUtils';
import {
  PRICE_WIDGET_DAY_TOMORROW,
  PRICE_WIDGET_EMPTY,
  PRICE_WIDGET_EXPORT_SUBLINE,
  PRICE_WIDGET_LEGEND,
  PRICE_WIDGET_LEVEL_LABEL,
  PRICE_WIDGET_TITLE,
  PRICE_WIDGET_TOMORROW_PENDING,
  formatPriceWidgetLevelAria,
  formatPriceWidgetPrice,
  formatPriceWidgetSubline,
  resolvePriceWidgetAmountUnit,
  resolvePriceWidgetAxisUnit,
} from '../../../packages/shared-domain/src/priceWidgetCopy';
import type {
  PriceWidgetChart,
  PriceWidgetLegendItem,
  PriceWidgetPayload,
  PriceWidgetShade,
  PriceWidgetShow,
  PriceWidgetStep,
  PriceWidgetTick,
  PriceWidgetTimeTick,
} from './priceWidgetTypes';

const MINUTE_MS = 60 * 1000;
const QUARTER_MS = 15 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
/** How much of the past the timeline keeps before now. */
const LOOKBACK_MS = 3 * HOUR_MS;
const TIME_TICK_EVERY_HOURS = 6;
const MAX_Y_INTERVALS = 4;

/** A published period on the time axis. */
type TimedPeriod = PriceTimelinePeriod & { startMs: number; endMs: number };

export const resolvePriceWidgetShow = (value: unknown): PriceWidgetShow => (
  value === 'export' || value === 'both' ? value : 'import'
);

// The price service hands over valid, time-ordered periods; this only puts
// them on the millisecond axis.
const toTimedPeriods = (periods: PriceTimelinePeriod[]): TimedPeriod[] => periods.map((period) => {
  const startMs = Date.parse(period.startsAt);
  return { ...period, startMs, endMs: startMs + period.durationMinutes * MINUTE_MS };
});

const empty = (subtitle: string, title: string = PRICE_WIDGET_TITLE): PriceWidgetPayload => (
  { state: 'empty', title, subtitle }
);

/** A 1/2/5 step that splits the range into at most four intervals. */
const resolveNiceStep = (range: number): number => {
  if (range <= 0 || !Number.isFinite(range)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(range / MAX_Y_INTERVALS));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude)
    .find((candidate) => range / candidate <= MAX_Y_INTERVALS);
  return step ?? 10 * magnitude;
};

const stepDecimals = (step: number): number => {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  return 2;
};

const resolveYAxis = (prices: number[]): Pick<PriceWidgetChart, 'yMin' | 'yMax' | 'yTicks'> => {
  const low = Math.min(0, ...prices);
  const high = Math.max(...prices);
  const step = resolveNiceStep(high - low);
  const yMin = Math.floor(low / step) * step;
  const yMax = Math.max(yMin + step, Math.ceil(high / step) * step);
  const decimals = stepDecimals(step);
  const count = Math.round((yMax - yMin) / step) + 1;
  const yTicks: PriceWidgetTick[] = Array.from({ length: count }, (_, index) => {
    const value = Number((yMin + index * step).toFixed(decimals));
    return { value, label: value.toFixed(decimals) };
  });
  return { yMin, yMax, yTicks };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Every local 00/06/12/18 inside the window, labelled with its hour. Sampled
 * on UTC quarter-hours, because in a half- or quarter-hour time zone (India,
 * Nepal, parts of Australia) a local full hour never falls on a UTC one.
 */
const resolveTimeTicks = (startMs: number, endMs: number, timeZone: string): PriceWidgetTimeTick[] => {
  const firstMs = Math.ceil(startMs / QUARTER_MS) * QUARTER_MS;
  const count = Math.max(0, Math.floor((endMs - firstMs) / QUARTER_MS) + 1);
  return Array.from({ length: count }, (_, index) => firstMs + index * QUARTER_MS).flatMap((atMs) => {
    const { hour, minute } = getZonedParts(new Date(atMs), timeZone);
    return minute === 0 && hour % TIME_TICK_EVERY_HOURS === 0 ? [{ atMs, label: pad2(hour) }] : [];
  });
};

/** The local midnight `days` days after today's. */
const localMidnightMs = (nowMs: number, days: number, timeZone: string): number => getDateKeyStartMs(
  shiftDateKey(getDateKeyInTimeZone(new Date(nowMs), timeZone), days),
  timeZone,
);

/**
 * The start of tomorrow, when the window reaches past it. The series covers
 * today and tomorrow only, so the window never starts before today's midnight
 * and tomorrow's is the one divider it can hold.
 */
const resolveDayDividers = (endMs: number, nowMs: number, timeZone: string): PriceWidgetTimeTick[] => {
  const atMs = localMidnightMs(nowMs, 1, timeZone);
  return atMs < endMs ? [{ atMs, label: PRICE_WIDGET_DAY_TOMORROW }] : [];
};

/** Clip a period to the window start; periods ending before it are dropped. */
const clipToWindow = (periods: TimedPeriod[], windowStartMs: number): TimedPeriod[] => (
  periods
    .filter((period) => period.endMs > windowStartMs)
    .map((period) => ({ ...period, startMs: Math.max(period.startMs, windowStartMs) }))
);

const toImportSteps = (periods: TimedPeriod[]): PriceWidgetStep[] => (
  periods.map((period) => ({ startMs: period.startMs, endMs: period.endMs, price: period.importPrice }))
);

const toExportSteps = (periods: TimedPeriod[]): PriceWidgetStep[] => (
  periods.flatMap((period) => (typeof period.exportPrice === 'number'
    ? [{ startMs: period.startMs, endMs: period.endMs, price: period.exportPrice }]
    : []))
);

/** Consecutive low or high periods merged into one shade each. */
const toShades = (periods: TimedPeriod[]): PriceWidgetShade[] => periods.reduce<PriceWidgetShade[]>(
  (shades, period) => {
    if (period.level === 'normal') return shades;
    const last = shades[shades.length - 1];
    if (last && last.level === period.level && last.endMs === period.startMs) {
      return [...shades.slice(0, -1), { ...last, endMs: period.endMs }];
    }
    return [...shades, { startMs: period.startMs, endMs: period.endMs, level: period.level }];
  },
  [],
);

/**
 * True until the series runs to the end of tomorrow. A source can hand over
 * part of a day, and the average (so the lines) only settles once all of
 * tomorrow is in; measured in local days, so a 23- or 25-hour day counts right.
 */
const isTomorrowPending = (periods: TimedPeriod[], nowMs: number, timeZone: string): boolean => (
  Math.max(...periods.map((period) => period.endMs)) < localMidnightMs(nowMs, 2, timeZone)
);

const buildLegend = (shades: PriceWidgetShade[], show: PriceWidgetShow): PriceWidgetLegendItem[] => [
  ...(show === 'both'
    ? [
      { key: 'import' as const, label: PRICE_WIDGET_LEGEND.import },
      { key: 'export' as const, label: PRICE_WIDGET_LEGEND.export },
    ]
    : []),
  ...(shades.some((shade) => shade.level === 'cheap')
    ? [{ key: 'cheap' as const, label: PRICE_WIDGET_LEVEL_LABEL.cheap }]
    : []),
  ...(shades.some((shade) => shade.level === 'expensive')
    ? [{ key: 'expensive' as const, label: PRICE_WIDGET_LEVEL_LABEL.expensive }]
    : []),
];

const buildExportPayload = (
  timeline: PriceTimeline,
  visible: TimedPeriod[],
  current: TimedPeriod,
  nowMs: number,
  timeZone: string,
): PriceWidgetPayload => {
  const exportSteps = toExportSteps(visible);
  if (typeof current.exportPrice !== 'number') {
    return empty(PRICE_WIDGET_EMPTY.noCurrentExportSubtitle, PRICE_WIDGET_EMPTY.noCurrentExport);
  }
  const amountUnit = resolvePriceWidgetAmountUnit(timeline.priceUnit);
  const windowStartMs = Math.min(...visible.map((period) => period.startMs));
  const windowEndMs = Math.max(...visible.map((period) => period.endMs));
  const priceText = formatPriceWidgetPrice(current.exportPrice, amountUnit);
  return {
    state: 'ready',
    title: PRICE_WIDGET_TITLE,
    priceText,
    level: null,
    subline: PRICE_WIDGET_EXPORT_SUBLINE,
    caption: null,
    chart: {
      windowStartMs,
      windowEndMs,
      nowMs,
      ...resolveYAxis(exportSteps.map((step) => step.price)),
      timeTicks: resolveTimeTicks(windowStartMs, windowEndMs, timeZone),
      dayDividers: resolveDayDividers(windowEndMs, nowMs, timeZone),
      importSteps: [],
      exportSteps,
      shades: [],
      nowPrice: current.exportPrice,
      axisUnit: resolvePriceWidgetAxisUnit(timeline.priceUnit),
    },
    legend: [],
    ariaLabel: `${PRICE_WIDGET_LEGEND.export} price now ${priceText}`,
  };
};

const buildImportPayload = (
  timeline: PriceTimeline,
  periods: TimedPeriod[],
  visible: TimedPeriod[],
  current: TimedPeriod,
  show: 'import' | 'both',
  nowMs: number,
  timeZone: string,
): PriceWidgetPayload => {
  const amountUnit = resolvePriceWidgetAmountUnit(timeline.priceUnit);
  const importSteps = toImportSteps(visible);
  const exportSteps = show === 'both' ? toExportSteps(visible) : [];
  const shades = toShades(visible);
  const windowStartMs = Math.min(...visible.map((period) => period.startMs));
  const windowEndMs = Math.max(...visible.map((period) => period.endMs));
  const importPrices = importSteps.map((step) => step.price);
  const priceText = formatPriceWidgetPrice(current.importPrice, amountUnit);
  const levelLabel = PRICE_WIDGET_LEVEL_LABEL[current.level];
  return {
    state: 'ready',
    title: PRICE_WIDGET_TITLE,
    priceText,
    level: { label: levelLabel, tone: current.level === 'normal' ? null : current.level },
    subline: formatPriceWidgetSubline({
      ...timeline.lines,
      lowest: Math.min(...importPrices),
      highest: Math.max(...importPrices),
      hasCheap: shades.some((shade) => shade.level === 'cheap'),
      hasExpensive: shades.some((shade) => shade.level === 'expensive'),
      amountUnit,
    }),
    caption: isTomorrowPending(periods, nowMs, timeZone) ? PRICE_WIDGET_TOMORROW_PENDING : null,
    chart: {
      windowStartMs,
      windowEndMs,
      nowMs,
      ...resolveYAxis([...importPrices, ...exportSteps.map((step) => step.price)]),
      timeTicks: resolveTimeTicks(windowStartMs, windowEndMs, timeZone),
      dayDividers: resolveDayDividers(windowEndMs, nowMs, timeZone),
      importSteps,
      exportSteps,
      shades,
      nowPrice: current.importPrice,
      axisUnit: resolvePriceWidgetAxisUnit(timeline.priceUnit),
    },
    legend: buildLegend(shades, show),
    ariaLabel: `Price now ${priceText}. ${formatPriceWidgetLevelAria(current.level)}`,
  };
};

/**
 * The price widget's view of the timeline: a rolling window from a few hours
 * before now to the last published price, the current price with its level,
 * and the lines that decided the levels. Every level comes from the runtime's
 * classifier; nothing here re-derives one.
 */
export const buildPriceWidgetPayload = (
  read: PriceTimelineRead,
  requestedShow: PriceWidgetShow,
  nowMs: number,
  timeZone: string,
): PriceWidgetPayload => {
  if (read.state !== 'ready') {
    return read.reason === 'read_failed'
      ? empty(PRICE_WIDGET_EMPTY.readFailedSubtitle, PRICE_WIDGET_EMPTY.readFailed)
      : empty(PRICE_WIDGET_EMPTY.noPricesSubtitle, PRICE_WIDGET_EMPTY.noPrices);
  }
  const periods = toTimedPeriods(read.periods);
  const current = periods.find((period) => period.startMs <= nowMs && nowMs < period.endMs);
  if (!current) return empty(PRICE_WIDGET_EMPTY.noCurrentPriceSubtitle, PRICE_WIDGET_EMPTY.noCurrentPrice);
  const visible = clipToWindow(periods, Math.floor((nowMs - LOOKBACK_MS) / HOUR_MS) * HOUR_MS);
  if (requestedShow === 'export') {
    return read.hasExportPrice
      ? buildExportPayload(read, visible, current, nowMs, timeZone)
      : empty(PRICE_WIDGET_EMPTY.noExportSubtitle, PRICE_WIDGET_EMPTY.noExport);
  }
  // "Both" without an export price set up shows the import price alone.
  const show = requestedShow === 'both' && read.hasExportPrice ? 'both' : 'import';
  return buildImportPayload(read, periods, visible, current, show, nowMs, timeZone);
};
