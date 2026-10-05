import {
  PRICE_WIDGET_EMPTY,
  PRICE_WIDGET_EXPORT_SUBLINE,
  PRICE_WIDGET_LEGEND,
  PRICE_WIDGET_LEVEL_LABEL,
  PRICE_WIDGET_TITLE,
  PRICE_WIDGET_TOMORROW_PENDING,
  formatPriceWidgetLevelAria,
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

const quarterPrice = (quarter: number): number => {
  const hour = Math.floor(quarter / 4);
  const fraction = (quarter % 4) / 4;
  return Number((HOURLY[hour] + (HOURLY[hour + 1] - HOURLY[hour]) * fraction).toFixed(2));
};

const levelOf = (price: number): 'cheap' | 'normal' | 'expensive' => {
  if (price <= CHEAP_AT_OR_BELOW) return 'cheap';
  if (price >= EXPENSIVE_FROM) return 'expensive';
  return 'normal';
};

const buildSteps = (toPrice: (price: number) => number): PriceWidgetStep[] => (
  Array.from({ length: 96 }, (_, quarter) => ({
    startMs: DAY_START_MS + quarter * QUARTER_MS,
    endMs: DAY_START_MS + (quarter + 1) * QUARTER_MS,
    price: toPrice(quarterPrice(quarter)),
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
      chart: { ...baseChart, importSteps: [], exportSteps, shades: [], nowPrice: currentExport },
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
    subline: `High from ${EXPENSIVE_FROM} øre · low up to ${CHEAP_AT_OR_BELOW} øre`,
    caption: PRICE_WIDGET_TOMORROW_PENDING,
    chart: {
      ...baseChart,
      importSteps,
      exportSteps: show === 'both' ? exportSteps : [],
      shades,
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

export const resolvePriceWidgetPreviewPayload = (
  state: string | null,
  show: PriceWidgetShow,
): PriceWidgetPayload => {
  if (state === 'empty') {
    return { state: 'empty', title: PRICE_WIDGET_EMPTY.noPrices, subtitle: PRICE_WIDGET_EMPTY.noPricesSubtitle };
  }
  return readyPayload(show);
};
