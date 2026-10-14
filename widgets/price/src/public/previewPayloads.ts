import {
  PRICE_WIDGET_DAY_TOMORROW,
  PRICE_WIDGET_EMPTY,
  PRICE_WIDGET_EXPORT_SUBLINE,
  PRICE_WIDGET_LEGEND,
  PRICE_WIDGET_LEVEL_LABEL,
  PRICE_WIDGET_TITLE,
  PRICE_WIDGET_TOMORROW_PENDING,
  formatPriceWidgetLevelAria,
  formatPriceWidgetSubline,
} from '../../../../packages/shared-domain/src/priceWidgetCopy';
import type {
  PriceWidgetPayload,
  PriceWidgetShade,
  PriceWidgetShow,
  PriceWidgetStep,
} from '../priceWidgetTypes';

// Design-preview payloads (`?preview=1`, and the no-Homey harness): an example
// day of 15-minute prices in øre/kWh, viewed at 08:45. Hand-built here because
// the browser bundle may not import the node payload builder.

const QUARTER_MS = 15 * 60 * 1000;
const HOUR_MS = 4 * QUARTER_MS;
const DAY_START_MS = Date.UTC(2026, 9, 4, 22, 0, 0); // 00:00 in Amsterdam
const NOW_MS = DAY_START_MS + 8.75 * HOUR_MS;
const WINDOW_START_MS = DAY_START_MS + 5 * HOUR_MS;
const CHEAP_AT_OR_BELOW = 24.6;
const EXPENSIVE_FROM = 40.9;

// Hourly anchor prices; quarters interpolate between them.
const HOURLY = [33.6, 33.2, 32.6, 32.1, 31.7, 31.9, 33.4, 37.2, 43.8, 39.2, 34.6, 30.8,
  27.2, 20.6, 15.4, 18.8, 23.1, 30.6, 37.6, 42.4, 44.6, 39.4, 36.6, 33.6, 31.2];

// A Norgespris day and a half (`?state=flat`): the fixed electricity price
// leaves only the grid tariff to move the price, 73.84 øre at night and 87.84
// by day, around an 83.17 average. At 10 % and a 10 øre minimum difference the
// lines are 73.17 and 93.17, so no period reaches either: the longest subline
// the widget writes, plus the "Tomorrow" divider, since part of tomorrow is
// published.
const NIGHT = 73.84;
const DAY = 87.84;
const FLAT_HOURLY = Array.from({ length: 37 }, (_, hour) => {
  const local = hour % 24;
  return local < 6 || local >= 22 ? NIGHT : DAY;
});
const FLAT_QUARTERS = (FLAT_HOURLY.length - 1) * 4;
const FLAT_CHEAP_AT_OR_BELOW = 73.17;
const FLAT_EXPENSIVE_FROM = 93.17;

const quarterPrice = (quarter: number, hourly: readonly number[] = HOURLY): number => {
  const hour = Math.floor(quarter / 4);
  const fraction = (quarter % 4) / 4;
  return Number((hourly[hour] + (hourly[hour + 1] - hourly[hour]) * fraction).toFixed(2));
};

// A grid tariff steps on the hour rather than drifting between hours.
const steppedQuarterPrice = (quarter: number, hourly: readonly number[]): number => hourly[Math.floor(quarter / 4)];

const levelOf = (price: number): 'cheap' | 'normal' | 'expensive' => {
  if (price <= CHEAP_AT_OR_BELOW) return 'cheap';
  if (price >= EXPENSIVE_FROM) return 'expensive';
  return 'normal';
};

const buildSteps = (
  toPrice: (price: number) => number,
  hourly: readonly number[] = HOURLY,
  priceOf: (quarter: number, hourly: readonly number[]) => number = quarterPrice,
): PriceWidgetStep[] => (
  Array.from({ length: (hourly.length - 1) * 4 }, (_, quarter) => ({
    startMs: DAY_START_MS + quarter * QUARTER_MS,
    endMs: DAY_START_MS + (quarter + 1) * QUARTER_MS,
    price: toPrice(priceOf(quarter, hourly)),
  })).filter((step) => step.endMs > WINDOW_START_MS)
);

const buildShades = (steps: PriceWidgetStep[]): PriceWidgetShade[] => steps.reduce<PriceWidgetShade[]>(
  (shades, step) => {
    const level = levelOf(step.price);
    if (level === 'normal') return shades;
    const last = shades[shades.length - 1];
    if (last && last.level === level && last.endMs === step.startMs) {
      return [...shades.slice(0, -1), { ...last, endMs: step.endMs }];
    }
    return [...shades, { startMs: step.startMs, endMs: step.endMs, level }];
  },
  [],
);

const importSteps = buildSteps((price) => price);
const lowest = (steps: PriceWidgetStep[]): number => Math.min(...steps.map((step) => step.price));
const highest = (steps: PriceWidgetStep[]): number => Math.max(...steps.map((step) => step.price));
const exportSteps = buildSteps((price) => Number(((price - 14.6) / 1.21).toFixed(2)));

const baseChart = {
  windowStartMs: WINDOW_START_MS,
  windowEndMs: DAY_START_MS + 24 * HOUR_MS,
  nowMs: NOW_MS,
  yMin: 0,
  yMax: 60,
  yTicks: [0, 20, 40, 60].map((value) => ({ value, label: String(value) })),
  timeTicks: [6, 12, 18, 24].map((hour) => ({
    atMs: DAY_START_MS + hour * HOUR_MS,
    label: String(hour % 24).padStart(2, '0'),
  })),
  dayDividers: [],
  axisUnit: 'øre/kWh',
};

const currentImport = importSteps.find((step) => step.startMs <= NOW_MS && NOW_MS < step.endMs)?.price ?? 0;
const currentExport = exportSteps.find((step) => step.startMs <= NOW_MS && NOW_MS < step.endMs)?.price ?? 0;

const readyPayload = (show: PriceWidgetShow): PriceWidgetPayload => {
  if (show === 'export') {
    return {
      state: 'ready',
      title: PRICE_WIDGET_TITLE,
      priceText: `${currentExport.toFixed(2)} øre`,
      level: null,
      subline: PRICE_WIDGET_EXPORT_SUBLINE,
      caption: null,
      chart: { ...baseChart, importSteps: [], exportSteps, shades: [], levelLines: [], nowPrice: currentExport },
      legend: [],
      ariaLabel: `Export price now ${currentExport.toFixed(2)} øre`,
    };
  }
  const shades = buildShades(importSteps);
  const level = levelOf(currentImport);
  return {
    state: 'ready',
    title: PRICE_WIDGET_TITLE,
    priceText: `${currentImport.toFixed(2)} øre`,
    level: { label: PRICE_WIDGET_LEVEL_LABEL[level], tone: level === 'normal' ? null : level },
    subline: formatPriceWidgetSubline({
      cheapAtOrBelow: CHEAP_AT_OR_BELOW,
      expensiveFrom: EXPENSIVE_FROM,
      lowest: lowest(importSteps),
      highest: highest(importSteps),
      hasCheap: shades.some((shade) => shade.level === 'cheap'),
      hasExpensive: shades.some((shade) => shade.level === 'expensive'),
      amountUnit: 'øre',
    }),
    caption: PRICE_WIDGET_TOMORROW_PENDING,
    chart: {
      ...baseChart,
      importSteps,
      exportSteps: show === 'both' ? exportSteps : [],
      shades,
      levelLines: [
        { level: 'cheap', price: CHEAP_AT_OR_BELOW },
        { level: 'expensive', price: EXPENSIVE_FROM },
      ],
      nowPrice: currentImport,
    },
    legend: [
      ...(show === 'both'
        ? [
          { key: 'import' as const, label: PRICE_WIDGET_LEGEND.import },
          { key: 'export' as const, label: PRICE_WIDGET_LEGEND.export },
        ]
        : []),
      { key: 'cheap', label: PRICE_WIDGET_LEVEL_LABEL.cheap },
      { key: 'expensive', label: PRICE_WIDGET_LEVEL_LABEL.expensive },
    ],
    ariaLabel: `Price now ${currentImport.toFixed(2)} øre. ${formatPriceWidgetLevelAria(level)}`,
  };
};

const priceAt = (steps: PriceWidgetStep[]): number => (
  steps.find((step) => step.startMs <= NOW_MS && NOW_MS < step.endMs)?.price ?? 0
);

const flatPayload = (show: PriceWidgetShow): PriceWidgetPayload => {
  const flatImport = buildSteps((price) => price, FLAT_HOURLY, steppedQuarterPrice);
  const flatExport = buildSteps(
    (price) => Number(((price - 14.6) / 1.21).toFixed(2)),
    FLAT_HOURLY,
    steppedQuarterPrice,
  );
  const current = priceAt(flatImport);
  return {
    state: 'ready',
    title: PRICE_WIDGET_TITLE,
    priceText: `${current.toFixed(2)} øre`,
    level: { label: PRICE_WIDGET_LEVEL_LABEL.normal, tone: null },
    subline: formatPriceWidgetSubline({
      cheapAtOrBelow: FLAT_CHEAP_AT_OR_BELOW,
      expensiveFrom: FLAT_EXPENSIVE_FROM,
      lowest: lowest(flatImport),
      highest: highest(flatImport),
      hasCheap: false,
      hasExpensive: false,
      amountUnit: 'øre',
    }),
    caption: PRICE_WIDGET_TOMORROW_PENDING,
    chart: {
      ...baseChart,
      windowEndMs: DAY_START_MS + FLAT_QUARTERS * QUARTER_MS,
      timeTicks: [6, 12, 18, 24, 30].map((hour) => ({
        atMs: DAY_START_MS + hour * HOUR_MS,
        label: String(hour % 24).padStart(2, '0'),
      })),
      dayDividers: [{ atMs: DAY_START_MS + 24 * HOUR_MS, label: PRICE_WIDGET_DAY_TOMORROW }],
      // What the payload builder writes for this series: zero to above the
      // expensive line, in steps of 50.
      yMin: 0,
      yMax: 100,
      yTicks: [0, 50, 100].map((value) => ({ value, label: String(value) })),
      importSteps: flatImport,
      exportSteps: show === 'both' ? flatExport : [],
      shades: [],
      levelLines: [
        { level: 'cheap', price: FLAT_CHEAP_AT_OR_BELOW },
        { level: 'expensive', price: FLAT_EXPENSIVE_FROM },
      ],
      nowPrice: current,
    },
    legend: show === 'both'
      ? [
        { key: 'import', label: PRICE_WIDGET_LEGEND.import },
        { key: 'export', label: PRICE_WIDGET_LEGEND.export },
      ]
      : [],
    ariaLabel: `Price now ${current.toFixed(2)} øre. ${formatPriceWidgetLevelAria('normal')}`,
  };
};

export const resolvePriceWidgetPreviewPayload = (
  state: string | null,
  show: PriceWidgetShow,
): PriceWidgetPayload => {
  if (state === 'empty') {
    return { state: 'empty', title: PRICE_WIDGET_EMPTY.noPrices, subtitle: PRICE_WIDGET_EMPTY.noPricesSubtitle };
  }
  if (state === 'flat' && show !== 'export') return flatPayload(show);
  return readyPayload(show);
};
