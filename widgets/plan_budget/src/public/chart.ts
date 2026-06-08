import {
  PLAN_PRICE_WIDGET_ARIA,
  PLAN_PRICE_WIDGET_AXIS,
  PLAN_PRICE_WIDGET_EMPTY,
  PLAN_PRICE_WIDGET_LEGEND,
  PLAN_PRICE_WIDGET_PRICE_MISSING,
  PLAN_PRICE_WIDGET_TITLE,
  formatPlanPriceSummaryParts,
  type PlanPriceSummaryParts,
  type PlanPriceWidgetHalf,
} from '../../../../packages/shared-domain/src/planPriceWidgetCopy';
import {
  VIEWPORT_MIN_HEIGHT,
  resolveGeometry,
  resolveViewportHeight,
  type Geometry,
} from './chartGeometry';
import {
  buildBarPath,
  buildPathData,
  clearNode,
  createSvg,
} from './chartSvg';
import type {
  PlanPriceWidgetEmptyPayload,
  PlanPriceWidgetPayload,
  PlanPriceWidgetReadyPayload,
} from '../planPriceWidgetTypes';

// Re-export the viewport minimum so existing consumers/tests that import it from
// `chart` keep working after the geometry split.
export { VIEWPORT_MIN_HEIGHT } from './chartGeometry';

const GRID_LINES = 4;
const BAR_RADIUS = 3;
const DOT_RADIUS = 4;
const WIDGET_TITLE = PLAN_PRICE_WIDGET_TITLE;
const DEFAULT_EMPTY_SUBTITLE = PLAN_PRICE_WIDGET_EMPTY.noData;

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
  geometry: Geometry,
): PlotMetrics => {
  const { plot } = geometry;
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
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

const appendPanel = (chartDocument: Document, panelGroup: SVGGElement, geometry: Geometry): void => {
  const { panel } = geometry;
  panelGroup.appendChild(createSvg(chartDocument, 'rect', {
    class: 'chart__panel',
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height,
    rx: panel.radius,
    ry: panel.radius,
  }));
};

const appendAxisTitles = (
  chartDocument: Document,
  labelsGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  geometry: Geometry,
): void => {
  const { plot, axisTitleY } = geometry;
  labelsGroup.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__axis-title',
    x: plot.left - 8,
    y: axisTitleY,
    'text-anchor': 'start',
  }, PLAN_PRICE_WIDGET_AXIS.energy));

  if (!payload.hasPriceData || !payload.priceAxisUnit) return;

  labelsGroup.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__axis-title',
    x: plot.right + 8,
    y: axisTitleY,
    'text-anchor': 'end',
  }, payload.priceAxisUnit));
};

const appendGridAndAxisLabels = (
  chartDocument: Document,
  groups: ChartGroups,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
  geometry: Geometry,
): void => {
  const { plot } = geometry;
  for (let index = 0; index <= GRID_LINES; index += 1) {
    const ratio = index / GRID_LINES;
    const y = plot.bottom - (metrics.plotHeight * ratio);

    groups.plotGroup.appendChild(createSvg(chartDocument, 'line', {
      class: 'chart__grid',
      x1: plot.left,
      y1: y,
      x2: plot.right,
      y2: y,
    }));

    groups.labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: plot.left - 8,
      y: y + 4,
      'text-anchor': 'end',
    }, formatPlanTick(metrics.maxPlan * ratio)));

    if (!payload.hasPriceData) continue;

    const priceValue = metrics.priceBounds.min + (metrics.priceSpan * ratio);
    groups.labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: plot.right + 8,
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
  geometry: Geometry,
): void => {
  if (!payload.showNow) return;
  const visible = metrics.buckets.find((bucket) => bucket.dayIndex === payload.currentIndex);
  if (!visible) return;

  const { plot } = geometry;
  const currentX = plot.left + (metrics.stepWidth * (visible.localIndex + 0.5));
  plotGroup.appendChild(createSvg(chartDocument, 'line', {
    class: 'chart__now',
    x1: currentX,
    y1: plot.top,
    x2: currentX,
    y2: plot.bottom,
  }));
};

const appendPlanBars = (
  chartDocument: Document,
  plotGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
  geometry: Geometry,
): void => {
  const { plot } = geometry;
  metrics.buckets.forEach((bucket) => {
    const value = payload.plannedKwh[bucket.dayIndex] ?? 0;
    const x = plot.left + (metrics.stepWidth * bucket.localIndex) + ((metrics.stepWidth - metrics.barWidth) / 2);
    const height = metrics.plotHeight * (value / metrics.maxPlan);
    const y = plot.bottom - height;

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
  geometry: Geometry,
): void => {
  const { plot } = geometry;
  const pricePoints = metrics.buckets.map((bucket) => {
    const value = payload.priceSeries[bucket.dayIndex];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return {
      x: plot.left + (metrics.stepWidth * (bucket.localIndex + 0.5)),
      y: plot.bottom - ((value - metrics.priceBounds.min) / metrics.priceSpan) * metrics.plotHeight,
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
  const currentPriceY = plot.bottom - (
    ((currentValue - metrics.priceBounds.min) / metrics.priceSpan) * metrics.plotHeight
  );

  plotGroup.appendChild(createSvg(chartDocument, 'circle', {
    class: 'chart__price-dot',
    cx: plot.left + (metrics.stepWidth * (visible.localIndex + 0.5)),
    cy: currentPriceY,
    r: DOT_RADIUS + 1,
  }));
};

const appendActualMarkers = (
  chartDocument: Document,
  plotGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
  geometry: Geometry,
): void => {
  if (!payload.showActual) return;

  const { plot } = geometry;
  metrics.buckets.forEach((bucket) => {
    const value = payload.actualKwh[bucket.dayIndex];
    if (typeof value !== 'number' || !Number.isFinite(value) || bucket.dayIndex > payload.currentIndex) return;

    plotGroup.appendChild(createSvg(chartDocument, 'circle', {
      class: 'chart__actual',
      cx: plot.left + (metrics.stepWidth * (bucket.localIndex + 0.5)),
      cy: plot.bottom - (value / metrics.maxPlan) * metrics.plotHeight,
      r: DOT_RADIUS,
    }));
  });
};

const appendBucketLabels = (
  chartDocument: Document,
  labelsGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  metrics: PlotMetrics,
  geometry: Geometry,
): void => {
  const { plot, xLabelY } = geometry;
  // ~12 bars per half stay legible with a label every other hour.
  const labelEvery = 2;
  metrics.buckets.forEach((bucket) => {
    const label = payload.bucketLabels[bucket.dayIndex] ?? '';
    const isVisible = bucket.localIndex % labelEvery === 0 || bucket.localIndex === metrics.buckets.length - 1;
    if (!isVisible || !label) return;

    labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: plot.left + (metrics.stepWidth * (bucket.localIndex + 0.5)),
      y: xLabelY,
      'text-anchor': 'middle',
    }, label));
  });
};

const appendMissingPriceBadge = (
  chartDocument: Document,
  labelsGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  geometry: Geometry,
): void => {
  if (payload.hasPriceData) return;

  const { panel } = geometry;
  labelsGroup.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__badge',
    x: panel.x + panel.width - 12,
    y: panel.y + 22,
    'text-anchor': 'end',
  }, PLAN_PRICE_WIDGET_PRICE_MISSING));
};

const renderLegend = (
  chartDocument: Document,
  legendGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
  geometry: Geometry,
): void => {
  const { legendY } = geometry;
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
        y: legendY - 7,
        width: 16,
        height: 10,
        rx: 3,
        ry: 3,
      }));
    } else if (item.type === 'actual') {
      legendGroup.appendChild(createSvg(chartDocument, 'circle', {
        class: 'chart__legend-actual',
        cx: item.x + 8,
        cy: legendY - 2,
        r: 5,
      }));
    } else {
      legendGroup.appendChild(createSvg(chartDocument, 'line', {
        class: 'chart__legend-price',
        x1: item.x,
        y1: legendY - 2,
        x2: item.x + 16,
        y2: legendY - 2,
      }));
    }

    legendGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__legend-text',
      x: item.x + 24,
      y: legendY - 2,
    }, item.label));
  });
};

// Reflect the resolved viewBox height onto the SVG so the rendered geometry and
// the viewBox agree. `viewBox` width stays 480; height is the (clamped) container
// height in viewBox units. `preserveAspectRatio="none"` maps the viewBox 1:1 onto
// the tile (no `meet` letterbox outside the panel) — and because the caller
// passes a height that preserves the container's true aspect ratio, the x and y
// scale factors are EQUAL, so `<circle>` dots stay round despite `none`. The
// panel itself fills the viewBox (minus a small margin), so the card reaches the
// tile edges at any height; the plot block fills the panel inside it.
const applyViewBox = (chartEl: SVGSVGElement, viewport: Geometry['viewport']): void => {
  chartEl.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
  chartEl.setAttribute('preserveAspectRatio', 'none');
};

export const renderEmptyState = (
  chartEl: SVGSVGElement,
  payload: Pick<PlanPriceWidgetEmptyPayload, 'subtitle' | 'title'>,
  height: number = VIEWPORT_MIN_HEIGHT,
): void => {
  const chartDocument = chartEl.ownerDocument;
  const { panel, viewport } = resolveGeometry(resolveViewportHeight(height));

  clearNode(chartEl);
  applyViewBox(chartEl, viewport);
  chartEl.setAttribute('aria-label', payload.subtitle || PLAN_PRICE_WIDGET_ARIA.unavailable);
  chartEl.appendChild(createSvg(chartDocument, 'rect', {
    class: 'chart__panel',
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height,
    rx: panel.radius,
    ry: panel.radius,
  }));
  chartEl.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__empty-title',
    x: viewport.width / 2,
    y: panel.y + (panel.height / 2) - 10,
    'text-anchor': 'middle',
  }, payload.title || WIDGET_TITLE));
  chartEl.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__empty-subtitle',
    x: viewport.width / 2,
    y: panel.y + (panel.height / 2) + 16,
    'text-anchor': 'middle',
  }, payload.subtitle || DEFAULT_EMPTY_SUBTITLE));
};

export const renderReadyState = (
  chartEl: SVGSVGElement,
  payload: PlanPriceWidgetReadyPayload,
  half: PlanPriceWidgetHalf,
  height: number = VIEWPORT_MIN_HEIGHT,
): void => {
  const chartDocument = chartEl.ownerDocument;
  const geometry = resolveGeometry(resolveViewportHeight(height));
  const groups = createChartGroups(chartDocument);
  const metrics = resolvePlotMetrics(payload, half, geometry);

  clearNode(chartEl);
  applyViewBox(chartEl, geometry.viewport);
  chartEl.setAttribute(
    'aria-label',
    payload.target === 'tomorrow'
      ? PLAN_PRICE_WIDGET_ARIA.tomorrow
      : PLAN_PRICE_WIDGET_ARIA.today,
  );

  chartEl.appendChild(groups.chartGroup);
  appendPanel(chartDocument, groups.panelGroup, geometry);
  appendAxisTitles(chartDocument, groups.labelsGroup, payload, geometry);
  appendGridAndAxisLabels(chartDocument, groups, payload, metrics, geometry);
  appendNowMarker(chartDocument, groups.plotGroup, payload, metrics, geometry);
  appendPlanBars(chartDocument, groups.plotGroup, payload, metrics, geometry);
  appendPriceSeries(chartDocument, groups.plotGroup, payload, metrics, geometry);
  appendActualMarkers(chartDocument, groups.plotGroup, payload, metrics, geometry);
  appendBucketLabels(chartDocument, groups.labelsGroup, payload, metrics, geometry);
  appendMissingPriceBadge(chartDocument, groups.labelsGroup, payload, geometry);
  renderLegend(chartDocument, groups.legendGroup, payload, geometry);
};

// The projected summary split into a prominent headline and a toned status, for
// the two-tier widget header. Returns null for non-ready payloads so the caller
// clears the header. All strings come from shared-domain (UI-text-shared-with-logs).
export const resolveSummaryParts = (
  payload: PlanPriceWidgetPayload | null,
): PlanPriceSummaryParts | null => {
  if (!payload || payload.state !== 'ready') return null;
  return formatPlanPriceSummaryParts({
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
  height: number = VIEWPORT_MIN_HEIGHT,
): void => {
  if (!payload || payload.state !== 'ready') {
    renderEmptyState(chartEl, payload || {
      title: WIDGET_TITLE,
      subtitle: DEFAULT_EMPTY_SUBTITLE,
    }, height);
    return;
  }

  renderReadyState(chartEl, payload, half, height);
};
