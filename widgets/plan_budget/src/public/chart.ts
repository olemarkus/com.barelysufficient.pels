import type {
  PlanPriceWidgetEmptyPayload,
  PlanPriceWidgetPayload,
  PlanPriceWidgetReadyPayload,
} from '../planPriceWidgetTypes';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWPORT = { width: 480, height: 480 };
const PANEL = { x: 12, y: 12, width: 456, height: 416, radius: 12 };
const PLOT = { left: 46, right: 422, top: 30, bottom: 372 };
const LEGEND_Y = 450;
const X_LABEL_Y = 404;
const GRID_LINES = 4;
const BAR_RADIUS = 3;
const DOT_RADIUS = 4;
const WIDGET_TITLE = 'Budget and Price';
const DEFAULT_EMPTY_SUBTITLE = 'No plan data available';

type SvgAttributeValue = number | string | null | undefined;
type SvgAttributes = Record<string, SvgAttributeValue>;
type Point = { x: number; y: number };
type PriceBounds = { min: number; max: number };
type PlotMetrics = {
  barWidth: number;
  bucketCount: number;
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

const resolvePlotMetrics = (payload: PlanPriceWidgetReadyPayload): PlotMetrics => {
  const plotWidth = PLOT.right - PLOT.left;
  const plotHeight = PLOT.bottom - PLOT.top;
  const bucketCount = payload.plannedKwh.length;
  const maxPlan = Math.max(1, payload.maxPlan * 1.08);
  const priceBounds = resolvePriceBounds(payload);
  const priceSpan = Math.max(1, priceBounds.max - priceBounds.min);
  const stepWidth = plotWidth / Math.max(1, bucketCount);
  const barWidth = Math.max(6, stepWidth * 0.72);

  return {
    barWidth,
    bucketCount,
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

  const currentX = PLOT.left + (metrics.stepWidth * (payload.currentIndex + 0.5));
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
  payload.plannedKwh.forEach((value, index) => {
    const x = PLOT.left + (metrics.stepWidth * index) + ((metrics.stepWidth - metrics.barWidth) / 2);
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
  const pricePoints = payload.priceSeries.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return {
      x: PLOT.left + (metrics.stepWidth * (index + 0.5)),
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

  if (!payload.showNow || !Number.isFinite(payload.priceSeries[payload.currentIndex])) {
    return;
  }

  const currentValue = payload.priceSeries[payload.currentIndex] as number;
  const currentPriceY = PLOT.bottom - (
    ((currentValue - metrics.priceBounds.min) / metrics.priceSpan) * metrics.plotHeight
  );

  plotGroup.appendChild(createSvg(chartDocument, 'circle', {
    class: 'chart__price-dot',
    cx: PLOT.left + (metrics.stepWidth * (payload.currentIndex + 0.5)),
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

  payload.actualKwh.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || index > payload.currentIndex) return;

    plotGroup.appendChild(createSvg(chartDocument, 'circle', {
      class: 'chart__actual',
      cx: PLOT.left + (metrics.stepWidth * (index + 0.5)),
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
  payload.bucketLabels.forEach((label, index) => {
    const isVisible = index % payload.labelEvery === 0 || index === payload.bucketLabels.length - 1;
    if (!isVisible) return;

    labelsGroup.appendChild(createSvg(chartDocument, 'text', {
      class: 'chart__axis-label',
      x: PLOT.left + (metrics.stepWidth * (index + 0.5)),
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
  }, 'Price data missing'));
};

const renderLegend = (
  chartDocument: Document,
  legendGroup: SVGGElement,
  payload: PlanPriceWidgetReadyPayload,
): void => {
  const legendItems = [
    { type: 'plan', label: 'Plan', x: 92 },
    ...(payload.showActual ? [{ type: 'actual', label: 'Actual', x: 214 }] : []),
    { type: 'price', label: 'Price', x: payload.showActual ? 346 : 274 },
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
    y: 214,
    'text-anchor': 'middle',
  }, payload.title || WIDGET_TITLE));
  chartEl.appendChild(createSvg(chartDocument, 'text', {
    class: 'chart__empty-subtitle',
    x: VIEWPORT.width / 2,
    y: 244,
    'text-anchor': 'middle',
  }, payload.subtitle || DEFAULT_EMPTY_SUBTITLE));
};

export const renderReadyState = (chartEl: SVGSVGElement, payload: PlanPriceWidgetReadyPayload): void => {
  const chartDocument = chartEl.ownerDocument;
  const groups = createChartGroups(chartDocument);
  const metrics = resolvePlotMetrics(payload);

  clearNode(chartEl);
  chartEl.setAttribute(
    'aria-label',
    payload.target === 'tomorrow'
      ? 'Budget and price chart for tomorrow'
      : 'Budget and price chart for today',
  );

  chartEl.appendChild(groups.chartGroup);
  appendPanel(chartDocument, groups.panelGroup);
  appendGridAndAxisLabels(chartDocument, groups, payload, metrics);
  appendNowMarker(chartDocument, groups.plotGroup, payload, metrics);
  appendPlanBars(chartDocument, groups.plotGroup, payload, metrics);
  appendPriceSeries(chartDocument, groups.plotGroup, payload, metrics);
  appendActualMarkers(chartDocument, groups.plotGroup, payload, metrics);
  appendBucketLabels(chartDocument, groups.labelsGroup, payload, metrics);
  appendMissingPriceBadge(chartDocument, groups.labelsGroup, payload);
  renderLegend(chartDocument, groups.legendGroup, payload);
};

export const renderWidget = (chartEl: SVGSVGElement, payload: PlanPriceWidgetPayload | null): void => {
  if (!payload || payload.state !== 'ready') {
    renderEmptyState(chartEl, payload || {
      title: WIDGET_TITLE,
      subtitle: DEFAULT_EMPTY_SUBTITLE,
    });
    return;
  }

  renderReadyState(chartEl, payload);
};
