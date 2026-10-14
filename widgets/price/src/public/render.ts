import { createSvg } from '../../../_shared/widgetSvg';
import { measureBox, type BoxSize } from '../../../_shared/widgetChartSize';
import type {
  PriceWidgetChart,
  PriceWidgetLegendItem,
  PriceWidgetPayload,
  PriceWidgetReadyPayload,
  PriceWidgetStep,
} from '../priceWidgetTypes';

export type RenderTargets = {
  root: HTMLElement;
  summaryEl: HTMLElement;
  priceEl: HTMLElement;
  levelEl: HTMLElement;
  sublineEl: HTMLElement;
  captionEl: HTMLElement;
  chartSvg: SVGSVGElement;
  legendEl: HTMLElement;
  emptyEl: HTMLElement;
  emptyTitleEl: HTMLElement;
  emptySubtitleEl: HTMLElement;
};

// The chart is drawn at the SVG's measured CSS-px size (viewBox = px), so text
// stays at the token sizes at any tile width and the plot fills whatever the
// fixed header leaves. The fallback is used before layout (jsdom, pre-paint).
const FALLBACK_SIZE: BoxSize = { width: 320, height: 160 };

// Plot insets in px inside the chart panel. The top leaves room for the
// "Tomorrow" divider label, the bottom for the hour labels.
const INSET = { top: 26, right: 12, bottom: 28, left: 10 };
// Gap between a y label's right edge and the plot.
const Y_LABEL_GAP = 6;
// Body-size digits are ~8 px wide; size the y-label gutter from the longest
// label so a "-0.125" axis gets the room a "60" axis does not need.
const LABEL_CHAR_PX = 8.5;
const X_LABEL_BASELINE = 20;
const DIVIDER_LABEL_PX = 72;
const EDGE_LABEL_ROOM = 12;
const DOT_RADIUS = 4.5;

type Plot = { left: number; right: number; top: number; bottom: number };
type Scale = { x: (ms: number) => number; y: (price: number) => number };

const resolvePlot = (chart: PriceWidgetChart, size: BoxSize): Plot => {
  const longest = Math.max(1, ...chart.yTicks.map((tick) => tick.label.length));
  const left = INSET.left + longest * LABEL_CHAR_PX + Y_LABEL_GAP;
  return {
    left,
    right: Math.max(left + 1, size.width - INSET.right),
    top: INSET.top,
    bottom: Math.max(INSET.top + 1, size.height - INSET.bottom),
  };
};

const createScale = (chart: PriceWidgetChart, plot: Plot): Scale => {
  const span = Math.max(1, chart.windowEndMs - chart.windowStartMs);
  const range = Math.max(Number.EPSILON, chart.yMax - chart.yMin);
  return {
    x: (ms) => plot.left + ((ms - chart.windowStartMs) / span) * (plot.right - plot.left),
    y: (price) => plot.top + ((chart.yMax - price) / range) * (plot.bottom - plot.top),
  };
};

/** A stepped path: flat for each period, vertical between periods. */
const steppedPath = (steps: PriceWidgetStep[], scale: Scale): string => (
  steps.map((step, index) => {
    const x0 = scale.x(step.startMs).toFixed(1);
    const x1 = scale.x(step.endMs).toFixed(1);
    const y = scale.y(step.price).toFixed(1);
    const previous = steps[index - 1];
    const joined = previous !== undefined && previous.endMs === step.startMs;
    return `${index === 0 || !joined ? 'M' : 'L'}${x0} ${y} H${x1}`;
  }).join(' ')
);

const appendShades = (svg: SVGSVGElement, chart: PriceWidgetChart, scale: Scale, plot: Plot): void => {
  const doc = svg.ownerDocument;
  for (const shade of chart.shades) {
    svg.appendChild(createSvg(doc, 'rect', {
      class: `chart__shade chart__shade--${shade.level}`,
      x: scale.x(shade.startMs).toFixed(1),
      y: plot.top,
      width: Math.max(0, scale.x(shade.endMs) - scale.x(shade.startMs)).toFixed(1),
      height: plot.bottom - plot.top,
    }));
  }
};

/** The cheap and expensive lines, faint and dashed, across the whole plot. */
const appendLevelLines = (svg: SVGSVGElement, chart: PriceWidgetChart, scale: Scale, plot: Plot): void => {
  const doc = svg.ownerDocument;
  for (const line of chart.levelLines) {
    const y = scale.y(line.price).toFixed(1);
    svg.appendChild(createSvg(doc, 'line', {
      class: `chart__level-line chart__level-line--${line.level}`, x1: plot.left, x2: plot.right, y1: y, y2: y,
    }));
  }
};

const appendYAxis = (svg: SVGSVGElement, chart: PriceWidgetChart, scale: Scale, plot: Plot): void => {
  const doc = svg.ownerDocument;
  for (const tick of chart.yTicks) {
    const y = scale.y(tick.value);
    svg.appendChild(createSvg(doc, 'line', {
      class: 'chart__grid', x1: plot.left, x2: plot.right, y1: y.toFixed(1), y2: y.toFixed(1),
    }));
    svg.appendChild(createSvg(doc, 'text', {
      class: 'chart__axis-label', x: plot.left - Y_LABEL_GAP, y: (y + 5).toFixed(1), 'text-anchor': 'end',
    }, tick.label));
  }
};

const appendTimeAxis = (svg: SVGSVGElement, chart: PriceWidgetChart, scale: Scale, plot: Plot): void => {
  const doc = svg.ownerDocument;
  for (const tick of chart.timeTicks) {
    const x = scale.x(tick.atMs);
    // Keep the outermost labels inside the plot instead of centring them
    // across its edge.
    let anchor = 'middle';
    if (x > plot.right - EDGE_LABEL_ROOM) anchor = 'end';
    else if (x < plot.left + EDGE_LABEL_ROOM) anchor = 'start';
    svg.appendChild(createSvg(doc, 'text', {
      class: 'chart__axis-label', x: x.toFixed(1), y: plot.bottom + X_LABEL_BASELINE, 'text-anchor': anchor,
    }, tick.label));
  }
  for (const divider of chart.dayDividers) {
    const x = scale.x(divider.atMs);
    svg.appendChild(createSvg(doc, 'line', {
      class: 'chart__divider', x1: x.toFixed(1), x2: x.toFixed(1), y1: plot.top - 18, y2: plot.bottom,
    }));
    // The label reads rightward from the divider, or leftward when the
    // divider sits too close to the right edge for the word to fit.
    const fitsRight = x + 4 + DIVIDER_LABEL_PX <= plot.right;
    svg.appendChild(createSvg(doc, 'text', {
      class: 'chart__axis-label',
      x: (fitsRight ? x + 4 : x - 4).toFixed(1),
      y: plot.top - 8,
      'text-anchor': fitsRight ? 'start' : 'end',
    }, divider.label));
  }
};

const appendSeries = (svg: SVGSVGElement, chart: PriceWidgetChart, scale: Scale, plot: Plot): void => {
  const doc = svg.ownerDocument;
  const nowX = scale.x(chart.nowMs).toFixed(1);
  svg.appendChild(createSvg(doc, 'line', {
    class: 'chart__now', x1: nowX, x2: nowX, y1: plot.top, y2: plot.bottom,
  }));
  if (chart.exportSteps.length > 0) {
    svg.appendChild(createSvg(doc, 'path', { class: 'chart__price', d: steppedPath(chart.exportSteps, scale) }));
  }
  if (chart.importSteps.length > 0) {
    svg.appendChild(createSvg(doc, 'path', { class: 'chart__import', d: steppedPath(chart.importSteps, scale) }));
  }
  // The dot sits on the series the headline shows: import when drawn,
  // otherwise the export line, in that series' colour.
  svg.appendChild(createSvg(doc, 'circle', {
    class: chart.importSteps.length > 0 ? 'chart__import-dot' : 'chart__price-dot',
    cx: nowX,
    cy: scale.y(chart.nowPrice).toFixed(1),
    r: DOT_RADIUS,
  }));
};

// Draw the chart into the panel's SVG at its measured size.
export const renderChart = (svg: SVGSVGElement, payload: PriceWidgetReadyPayload): void => {
  const size = measureBox(svg, FALLBACK_SIZE);
  const { chart } = payload;
  const plot = resolvePlot(chart, size);
  const scale = createScale(chart, plot);
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  svg.setAttribute('aria-label', payload.ariaLabel);
  appendShades(svg, chart, scale, plot);
  appendYAxis(svg, chart, scale, plot);
  appendLevelLines(svg, chart, scale, plot);
  appendTimeAxis(svg, chart, scale, plot);
  appendSeries(svg, chart, scale, plot);
};

const renderLegend = (legendEl: HTMLElement, items: PriceWidgetLegendItem[], axisUnit: string): void => {
  const doc = legendEl.ownerDocument;
  legendEl.replaceChildren(...items.map((item) => {
    const entry = doc.createElement('span');
    entry.className = 'chart__legend-item';
    const swatch = doc.createElement('span');
    swatch.className = `chart__legend-swatch chart__legend-swatch--${item.key}`;
    swatch.setAttribute('aria-hidden', 'true');
    entry.append(swatch, doc.createTextNode(item.label));
    return entry;
  }));
  if (axisUnit !== '') {
    const unit = doc.createElement('span');
    unit.className = 'chart__legend-unit';
    unit.textContent = axisUnit;
    legendEl.appendChild(unit);
  }
};

// The header chip tone, on the shared `summary--<tone>` modifiers.
const LEVEL_TONE_CLASS = { cheap: 'summary--success', expensive: 'summary--danger' } as const;

const renderReady = (targets: RenderTargets, payload: PriceWidgetReadyPayload): void => {
  const {
    summaryEl, priceEl, levelEl, sublineEl, captionEl, chartSvg, legendEl, emptyEl,
  } = targets;
  summaryEl.hidden = false;
  summaryEl.classList.remove(...Object.values(LEVEL_TONE_CLASS));
  if (payload.level?.tone) summaryEl.classList.add(LEVEL_TONE_CLASS[payload.level.tone]);
  priceEl.textContent = payload.priceText;
  levelEl.hidden = payload.level === null;
  levelEl.textContent = payload.level?.label ?? '';
  sublineEl.textContent = payload.subline;
  captionEl.hidden = payload.caption === null;
  captionEl.textContent = payload.caption ?? '';
  emptyEl.hidden = true;
  chartSvg.toggleAttribute('hidden', false);
  renderLegend(legendEl, payload.legend, payload.chart.axisUnit);
  legendEl.hidden = legendEl.childElementCount === 0;
  // Last, so the SVG is measured after the header and legend took their room.
  renderChart(chartSvg, payload);
};

export const renderWidget = (targets: RenderTargets, payload: PriceWidgetPayload): void => {
  const {
    root, summaryEl, chartSvg, legendEl, emptyEl, emptyTitleEl, emptySubtitleEl,
  } = targets;
  root.dataset.state = payload.state;
  if (payload.state === 'ready') {
    renderReady(targets, payload);
    return;
  }
  // Empty and error states: the panel carries the message, like the Budget
  // and Price widget, and the header steps aside.
  summaryEl.hidden = true;
  chartSvg.toggleAttribute('hidden', true);
  chartSvg.replaceChildren();
  legendEl.replaceChildren();
  legendEl.hidden = true;
  emptyEl.hidden = false;
  emptyTitleEl.textContent = payload.title;
  emptySubtitleEl.textContent = payload.subtitle;
};
