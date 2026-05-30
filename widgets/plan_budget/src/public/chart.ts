import {
  PLAN_PRICE_WIDGET_AXIS,
  PLAN_PRICE_WIDGET_LEGEND,
  PLAN_PRICE_WIDGET_PRICE_MISSING,
  PLAN_PRICE_WIDGET_TITLE,
  formatPlanPriceSummary,
  type PlanPriceWidgetHalf,
} from '../../../../packages/shared-domain/src/planPriceWidgetCopy';
import type {
  PlanPriceWidgetEmptyPayload,
  PlanPriceWidgetPayload,
  PlanPriceWidgetReadyPayload,
} from '../planPriceWidgetTypes';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWPORT = { width: 480, height: 360 };
const PANEL = { x: 12, y: 12, width: 456, height: 296, radius: 12 };
const PLOT = { left: 52, right: 416, top: 26, bottom: 252 };
const LEGEND_Y = 334;
const X_LABEL_Y = 284;
const AXIS_TITLE_Y = 20;
const GRID_LINES = 4;
const BAR_RADIUS = 3;
const DOT_RADIUS = 4;
const WIDGET_TITLE = PLAN_PRICE_WIDGET_TITLE;
const DEFAULT_EMPTY_SUBTITLE = 'No plan data available';

// The day splits at noon: morning = local hours 00–11, afternoon = 12–23.
// Splitting by each bucket's LOCAL hour (not its array index) keeps the halves
// correct on DST days, where buildLocalDayBuckets emits 23 or 25 buckets and a
// raw index would land hours under the wrong tab.
const HALF_SPLIT_HOUR = 12;

// A bucket's local hour, parsed from its hour label (`startLocalLabels` sliced
// to the leading hour, e.g. `"14:00"` → `14`). Returns null when the label can't
// be parsed, so callers fall back to the array index rather than mis-bucketing.
// Exported so the initial-tab pick (widgetApp) shares one parse with the split.
export const parseBucketLocalHour = (label: string | undefined): number | null => {
  if (typeof label !== 'string') return null;
  const match = /^\s*(\d{1,2})/.exec(label);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  return Number.isFinite(hour) ? hour : null;
};

type SvgAttributeValue = number | string | null | undefined;
type SvgAttributes = Record<string, SvgAttributeValue>;
type Point = { x: number; y: number };
type PriceBounds = { min: number; max: number };
// A bucket index in the visible half, paired with its index in the full-day
// arrays. `dayIndex` is needed for now/current lookups that are day-absolute.
type VisibleBucket = { localIndex: number; dayIndex: number };
type PlotMetrics = {
  barWidth: number;
  buckets: VisibleBucket[];
  maxPlan: number;
  plotHeight: number;
  plotWidth: number;
  priceBounds: PriceBounds;
  priceSpan: number;
  stepWidth: number;
};
type ChartGroups = {
  chartGroup: SVGGElement;
  labelsGroup: SVGGElement;
  legendGroup: SVGGElement;
  panelGroup: SVGGElement;
  plotGroup: SVGGElement;
};

const createSvg = <TagName extends keyof SVGElementTagNameMap>(
  chartDocument: Document,
  tagName: TagName,
  attributes: SvgAttributes = {},
  textContent = '',
): SVGElementTagNameMap[TagName] => {
  const node = chartDocument.createElementNS(SVG_NS, tagName);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  if (textContent) {
    node.textContent = textContent;
  }
  return node;
};

const clearNode = (node: Node): void => {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
};

const formatPlanTick = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
};

const formatPriceTick = (value: number): string => String(Math.round(value));

const resolvePriceBounds = (payload: PlanPriceWidgetReadyPayload): PriceBounds => {
  if (!payload.hasPriceData) return { min: 0, max: 1 };
  if (Math.abs(payload.priceMax - payload.priceMin) < 0.001) {
    return {
      min: payload.priceMin - 1,
      max: payload.priceMax + 1,
    };
  }
  return {
    min: payload.priceMin,
    max: payload.priceMax,
  };
};

// Buckets belonging to the requested half, decided by each bucket's LOCAL hour
// (< 12 → morning, >= 12 → afternoon). This stays correct on DST days, where the
// day has 23 or 25 buckets and the local hour — not the array index — is what
// the `00–12` / `12–24` tab labels promise. When a bucket's hour can't be parsed
// we fall back to its index so no bar is dropped or duplicated.
const resolveVisibleBuckets = (
  payload: PlanPriceWidgetReadyPayload,
  half: PlanPriceWidgetHalf,
): VisibleBucket[] => {
  const buckets: VisibleBucket[] = [];
  payload.plannedKwh.forEach((_value, dayIndex) => {
    const localHour = parseBucketLocalHour(payload.bucketLabels[dayIndex]) ?? dayIndex;
    const inMorning = localHour < HALF_SPLIT_HOUR;
    if ((half === 'morning') === inMorning) {
      buckets.push({ localIndex: buckets.length, dayIndex });
    }
  });
  return buckets;
};

const resolvePlotMetrics = (
  payload: PlanPriceWidgetReadyPayload,
  half: PlanPriceWidgetHalf,
): PlotMetrics => {
  const plotWidth = PLOT.right - PLOT.left;
  const plotHeight = PLOT.bottom - PLOT.top;
  const buckets = resolveVisibleBuckets(payload, half);
  // Scale the y-axis to the whole day's peak so the two halves stay visually
  // comparable when the user toggles tabs.
  const maxPlan = Math.max(1, payload.maxPlan * 1.08);
  const priceBounds = resolvePriceBounds(payload);
  const priceSpan = Math.max(1, priceBounds.max - priceBounds.min);
  const stepWidth = plotWidth / Math.max(1, buckets.length);
  // Leave a visible inter-bar gap (0.62 of the step) so the bars read as
  // discrete hours rather than a solid wall.
  const barWidth = Math.max(6, stepWidth * 0.62);

  return {
    barWidth,
    buckets,
    maxPlan,
    plotHeight,
    plotWidth,
    priceBounds,
    priceSpan,
    stepWidth,
  };
};

const buildPathData = (points: ReadonlyArray<Point | null>): string => {
  const commands: string[] = [];
  let pendingMove = true;

  for (const point of points) {
    if (!point) {
      pendingMove = true;
      continue;
    }

    commands.push(`${pendingMove ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
    pendingMove = false;
  }

  return commands.join(' ');
};

const buildBarPath = (x: number, y: number, width: number, height: number, radius: number): string => {
  const safeHeight = Math.max(0, height);
  const safeRadius = Math.min(radius, width / 2, safeHeight);
  const right = x + width;
  const bottom = y + safeHeight;

  if (safeRadius <= 0 || safeHeight <= 0) {
    return `M ${x} ${bottom} L ${x} ${y} L ${right} ${y} L ${right} ${bottom} Z`;
  }

  return [
    `M ${x} ${bottom}`,
    `L ${x} ${y + safeRadius}`,
    `Q ${x} ${y} ${x + safeRadius} ${y}`,
    `L ${right - safeRadius} ${y}`,
    `Q ${right} ${y} ${right} ${y + safeRadius}`,
    `L ${right} ${bottom}`,
    'Z',
  ].join(' ');
};

const createChartGroups = (chartDocument: Document): ChartGroups => {
  const chartGroup = createSvg(chartDocument, 'g');
  const panelGroup = createSvg(chartDocument, 'g');
  const plotGroup = createSvg(chartDocument, 'g');
  const labelsGroup = createSvg(chartDocument, 'g');
  const legendGroup = createSvg(chartDocument, 'g');

  chartGroup.append(panelGroup, plotGroup, labelsGroup, legendGroup);

  return {
    chartGroup,
    labelsGroup,
    legendGroup,
    panelGroup,
    plotGroup,
  };
};

const appendPanel = (chartDocument: Document, panelGroup: SVGGElement): void => {
  panelGroup.appendChild(createSvg(chartDocument, 'rect', {
    class: 'chart__panel',
    x: PANEL.x,
    y: PANEL.y,
    width: PANEL.width,
    height: PANEL.height,
    rx: PANEL.radius,
    ry: PANEL.radius,
  }));
};

const appendAxisTitles = (
  chartDocument: Document,
  labelsGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
): void => {
  labelsGroup.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__axis-title',
    x: PLOT.left - 8,
    y: AXIS_TITLE_Y,
    'text-anchor': 'start',
  }, PLAN_PRICE_WIDGET_AXIS.energy));

  if (!payload.hasPriceData || !payload.priceAxisUnit) return;

  labelsGroup.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__axis-title',
    x: PLOT.right + 8,
    y: AXIS_TITLE_Y,
    'text-anchor': 'end',
  }, payload.priceAxisUnit));
};

const appendGridAndAxisLabels = (
  chartDocument: Document,
  groups: ChartGroups,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
): void => {
  for (let index = 0; index <= GRID_LINES; index += 1) {
    const ratio = index / GRID_LINES;
    const y = PLOT.bottom - (metrics.plotHeight * ratio);

    groups.plotGroup.appendChild(createSvg(chartDocument, 'line', {
      class: 'chart__grid',
      x1: PLOT.left,
      y1: y,
      x2: PLOT.right,
      y2: y,
    }));

    groups.labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: PLOT.left - 8,
      y: y + 4,
      'text-anchor': 'end',
    }, formatPlanTick(metrics.maxPlan * ratio)));

    if (!payload.hasPriceData) continue;

    const priceValue = metrics.priceBounds.min + (metrics.priceSpan * ratio);
    groups.labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: PLOT.right + 8,
      y: y + 4,
      'text-anchor': 'start',
    }, formatPriceTick(priceValue)));
  }
};

const appendNowMarker = (
  chartDocument: Document,
  plotGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
): void => {
  if (!payload.showNow) return;
  const visible = metrics.buckets.find((bucket) => bucket.dayIndex === payload.currentIndex);
  if (!visible) return;

  const currentX = PLOT.left + (metrics.stepWidth * (visible.localIndex + 0.5));
  plotGroup.appendChild(createSvg(chartDocument, 'line', {
    class: 'chart__now',
    x1: currentX,
    y1: PLOT.top,
    x2: currentX,
    y2: PLOT.bottom,
  }));
};

const appendPlanBars = (
  chartDocument: Document,
  plotGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
): void => {
  metrics.buckets.forEach((bucket) => {
    const value = payload.plannedKwh[bucket.dayIndex] ?? 0;
    const x = PLOT.left + (metrics.stepWidth * bucket.localIndex) + ((metrics.stepWidth - metrics.barWidth) / 2);
    const height = metrics.plotHeight * (value / metrics.maxPlan);
    const y = PLOT.bottom - height;

    plotGroup.appendChild(createSvg(chartDocument, 'path', {
      class: 'chart__bar',
      d: buildBarPath(x, y, metrics.barWidth, height, BAR_RADIUS),
    }));
  });
};

const appendPriceSeries = (
  chartDocument: Document,
  plotGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
): void => {
  const pricePoints = metrics.buckets.map((bucket) => {
    const value = payload.priceSeries[bucket.dayIndex];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return {
      x: PLOT.left + (metrics.stepWidth * (bucket.localIndex + 0.5)),
      y: PLOT.bottom - ((value - metrics.priceBounds.min) / metrics.priceSpan) * metrics.plotHeight,
    };
  });
  const pricePath = buildPathData(pricePoints);

  if (pricePath) {
    plotGroup.appendChild(createSvg(chartDocument, 'path', {
      class: 'chart__price',
      d: pricePath,
    }));
  }

  if (!payload.showNow) return;
  const visible = metrics.buckets.find((bucket) => bucket.dayIndex === payload.currentIndex);
  if (!visible || !Number.isFinite(payload.priceSeries[payload.currentIndex])) return;

  const currentValue = payload.priceSeries[payload.currentIndex] as number;
  const currentPriceY = PLOT.bottom - (
    ((currentValue - metrics.priceBounds.min) / metrics.priceSpan) * metrics.plotHeight
  );

  plotGroup.appendChild(createSvg(chartDocument, 'circle', {
    class: 'chart__price-dot',
    cx: PLOT.left + (metrics.stepWidth * (visible.localIndex + 0.5)),
    cy: currentPriceY,
    r: DOT_RADIUS + 1,
  }));
};

const appendActualMarkers = (
  chartDocument: Document,
  plotGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
): void => {
  if (!payload.showActual) return;

  metrics.buckets.forEach((bucket) => {
    const value = payload.actualKwh[bucket.dayIndex];
    if (typeof value !== 'number' || !Number.isFinite(value) || bucket.dayIndex > payload.currentIndex) return;

    plotGroup.appendChild(createSvg(chartDocument, 'circle', {
      class: 'chart__actual',
      cx: PLOT.left + (metrics.stepWidth * (bucket.localIndex + 0.5)),
      cy: PLOT.bottom - (value / metrics.maxPlan) * metrics.plotHeight,
      r: DOT_RADIUS,
    }));
  });
};

const appendBucketLabels = (
  chartDocument: Document,
  labelsGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
): void => {
  // ~12 bars per half stay legible with a label every other hour.
  const labelEvery = 2;
  metrics.buckets.forEach((bucket) => {
    const label = payload.bucketLabels[bucket.dayIndex] ?? '';
    const isVisible = bucket.localIndex % labelEvery === 0 || bucket.localIndex === metrics.buckets.length - 1;
    if (!isVisible || !label) return;

    labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: PLOT.left + (metrics.stepWidth * (bucket.localIndex + 0.5)),
      y: X_LABEL_Y,
      'text-anchor': 'middle',
    }, label));
  });
};

const appendMissingPriceBadge = (
  chartDocument: Document,
  labelsGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
): void => {
  if (payload.hasPriceData) return;

  labelsGroup.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__badge',
    x: PANEL.x + PANEL.width - 12,
    y: PANEL.y + 22,
    'text-anchor': 'end',
  }, PLAN_PRICE_WIDGET_PRICE_MISSING));
};

const renderLegend = (
  chartDocument: Document,
  legendGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
): void => {
  const legendItems = [
    { type: 'plan', label: PLAN_PRICE_WIDGET_LEGEND.planned, x: 92 },
    ...(payload.showActual ? [{ type: 'actual', label: PLAN_PRICE_WIDGET_LEGEND.used, x: 214 }] : []),
    { type: 'price', label: PLAN_PRICE_WIDGET_LEGEND.price, x: payload.showActual ? 332 : 274 },
  ] as const;

  legendItems.forEach((item) => {
    if (item.type === 'plan') {
      legendGroup.appendChild(createSvg(chartDocument, 'rect', {
        class: 'chart__legend-plan',
        x: item.x,
        y: LEGEND_Y - 7,
        width: 16,
        height: 10,
        rx: 3,
        ry: 3,
      }));
    } else if (item.type === 'actual') {
      legendGroup.appendChild(createSvg(chartDocument, 'circle', {
        class: 'chart__legend-actual',
        cx: item.x + 8,
        cy: LEGEND_Y - 2,
        r: 5,
      }));
    } else {
      legendGroup.appendChild(createSvg(chartDocument, 'line', {
        class: 'chart__legend-price',
        x1: item.x,
        y1: LEGEND_Y - 2,
        x2: item.x + 16,
        y2: LEGEND_Y - 2,
      }));
    }

    legendGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__legend-text',
      x: item.x + 24,
      y: LEGEND_Y - 2,
    }, item.label));
  });
};

export const renderEmptyState = (
  chartEl: SVGSVGElement,
  payload: Pick<PlanPriceWidgetEmptyPayload, 'subtitle' | 'title'>,
): void => {
  const chartDocument = chartEl.ownerDocument;

  clearNode(chartEl);
  chartEl.setAttribute('aria-label', payload.subtitle || 'Budget and price chart unavailable');
  chartEl.appendChild(createSvg(chartDocument, 'rect', {
    class: 'chart__panel',
    x: PANEL.x,
    y: PANEL.y,
    width: PANEL.width,
    height: PANEL.height,
    rx: PANEL.radius,
    ry: PANEL.radius,
  }));
  chartEl.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__empty-title',
    x: VIEWPORT.width / 2,
    y: PANEL.y + (PANEL.height / 2) - 10,
    'text-anchor': 'middle',
  }, payload.title || WIDGET_TITLE));
  chartEl.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__empty-subtitle',
    x: VIEWPORT.width / 2,
    y: PANEL.y + (PANEL.height / 2) + 16,
    'text-anchor': 'middle',
  }, payload.subtitle || DEFAULT_EMPTY_SUBTITLE));
};

export const renderReadyState = (
  chartEl: SVGSVGElement,
  payload: PlanPriceWidgetReadyPayload,
  half: PlanPriceWidgetHalf,
): void => {
  const chartDocument = chartEl.ownerDocument;
  const groups = createChartGroups(chartDocument);
  const metrics = resolvePlotMetrics(payload, half);

  clearNode(chartEl);
  chartEl.setAttribute(
    'aria-label',
    payload.target === 'tomorrow'
      ? 'Budget and price chart for tomorrow'
      : 'Budget and price chart for today',
  );

  chartEl.appendChild(groups.chartGroup);
  appendPanel(chartDocument, groups.panelGroup);
  appendAxisTitles(chartDocument, groups.labelsGroup, payload);
  appendGridAndAxisLabels(chartDocument, groups, payload, metrics);
  appendNowMarker(chartDocument, groups.plotGroup, payload, metrics);
  appendPlanBars(chartDocument, groups.plotGroup, payload, metrics);
  appendPriceSeries(chartDocument, groups.plotGroup, payload, metrics);
  appendActualMarkers(chartDocument, groups.plotGroup, payload, metrics);
  appendBucketLabels(chartDocument, groups.labelsGroup, payload, metrics);
  appendMissingPriceBadge(chartDocument, groups.labelsGroup, payload);
  renderLegend(chartDocument, groups.legendGroup, payload);
};

// The projected summary line shown above the chart. Returns the text the
// caller writes into the summary element (empty for non-ready payloads).
export const resolveSummaryText = (payload: PlanPriceWidgetPayload | null): string => {
  if (!payload || payload.state !== 'ready') return '';
  return formatPlanPriceSummary({
    projectedKwh: payload.projectedKwh,
    projectedCost: payload.projectedCost,
    costUnit: payload.costUnit,
    tone: payload.summaryTone,
  });
};

export const renderWidget = (
  chartEl: SVGSVGElement,
  payload: PlanPriceWidgetPayload | null,
  half: PlanPriceWidgetHalf,
): void => {
  if (!payload || payload.state !== 'ready') {
    renderEmptyState(chartEl, payload || {
      title: WIDGET_TITLE,
      subtitle: DEFAULT_EMPTY_SUBTITLE,
    });
    return;
  }

  renderReadyState(chartEl, payload, half);
};
