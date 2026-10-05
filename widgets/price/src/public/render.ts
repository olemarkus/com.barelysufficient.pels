import type {
  PriceWidgetChart,
  PriceWidgetLegendItem,
  PriceWidgetPayload,
  PriceWidgetStep,
} from '../priceWidgetTypes';

export type RenderTargets = {
  root: HTMLElement;
  priceEl: HTMLElement;
  levelEl: HTMLElement;
  sublineEl: HTMLElement;
  chartEl: HTMLElement;
  legendEl: HTMLElement;
  captionEl: HTMLElement;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// Chart drawing box, in viewBox units. The SVG scales to the widget width, so
// at a phone dashboard's ~320 px these read as pixels.
const WIDTH = 320;
const HEIGHT = 150;
const PLOT = { left: 36, right: 4, top: 20, bottom: 20 } as const;
const EDGE_LABEL_ROOM = 10;

const svgEl = <K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] => {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
};

type Scale = { x: (ms: number) => number; y: (price: number) => number };

const createScale = (chart: PriceWidgetChart): Scale => {
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const span = Math.max(1, chart.windowEndMs - chart.windowStartMs);
  const range = Math.max(Number.EPSILON, chart.yMax - chart.yMin);
  return {
    x: (ms) => PLOT.left + ((ms - chart.windowStartMs) / span) * plotWidth,
    y: (price) => PLOT.top + ((chart.yMax - price) / range) * plotHeight,
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

const renderChart = (doc: Document, chart: PriceWidgetChart, ariaLabel: string): SVGSVGElement => {
  const scale = createScale(chart);
  const svg = svgEl(doc, 'svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    class: 'chart__svg',
    role: 'img',
    'aria-label': ariaLabel,
  });
  const plotTop = PLOT.top;
  const plotBottom = HEIGHT - PLOT.bottom;

  for (const shade of chart.shades) {
    svg.appendChild(svgEl(doc, 'rect', {
      x: scale.x(shade.startMs).toFixed(1),
      y: plotTop,
      width: Math.max(0, scale.x(shade.endMs) - scale.x(shade.startMs)).toFixed(1),
      height: plotBottom - plotTop,
      class: `chart__shade chart__shade--${shade.level}`,
    }));
  }
  for (const tick of chart.yTicks) {
    const y = scale.y(tick.value).toFixed(1);
    svg.appendChild(svgEl(doc, 'line', { x1: PLOT.left, x2: WIDTH - PLOT.right, y1: y, y2: y, class: 'chart__grid' }));
    svg.appendChild(svgEl(doc, 'text', {
      x: PLOT.left - 5, y: Number(y) + 5, 'text-anchor': 'end', class: 'chart__label',
    }, tick.label));
  }
  for (const tick of chart.timeTicks) {
    const x = scale.x(tick.atMs);
    // Keep the outermost labels inside the drawing instead of centring them
    // across the edge.
    let anchor = 'middle';
    if (x > WIDTH - EDGE_LABEL_ROOM) anchor = 'end';
    else if (x < PLOT.left + EDGE_LABEL_ROOM) anchor = 'start';
    svg.appendChild(svgEl(doc, 'text', {
      x: x.toFixed(1), y: HEIGHT - 4, 'text-anchor': anchor, class: 'chart__label',
    }, tick.label));
  }
  for (const divider of chart.dayDividers) {
    const x = scale.x(divider.atMs).toFixed(1);
    svg.appendChild(svgEl(doc, 'line', { x1: x, x2: x, y1: plotTop - 16, y2: plotBottom, class: 'chart__divider' }));
    svg.appendChild(svgEl(doc, 'text', { x: Number(x) + 4, y: plotTop - 6, class: 'chart__label' }, divider.label));
  }
  if (chart.exportSteps.length > 0) {
    svg.appendChild(svgEl(doc, 'path', { d: steppedPath(chart.exportSteps, scale), class: 'chart__export' }));
  }
  if (chart.importSteps.length > 0) {
    svg.appendChild(svgEl(doc, 'path', { d: steppedPath(chart.importSteps, scale), class: 'chart__import' }));
  }
  const nowX = scale.x(chart.nowMs).toFixed(1);
  svg.appendChild(svgEl(doc, 'line', { x1: nowX, x2: nowX, y1: plotTop, y2: plotBottom, class: 'chart__now-line' }));
  svg.appendChild(svgEl(doc, 'circle', {
    cx: nowX, cy: scale.y(chart.nowPrice).toFixed(1), r: 3.5, class: 'chart__now-dot',
  }));
  return svg;
};

const renderLegend = (doc: Document, legendEl: HTMLElement, items: PriceWidgetLegendItem[], axisUnit: string): void => {
  legendEl.replaceChildren(...items.map((item) => {
    const entry = doc.createElement('span');
    entry.className = 'legend__item';
    const swatch = doc.createElement('span');
    swatch.className = `legend__swatch legend__swatch--${item.key}`;
    swatch.setAttribute('aria-hidden', 'true');
    entry.append(swatch, doc.createTextNode(item.label));
    return entry;
  }));
  if (axisUnit !== '') {
    const unit = doc.createElement('span');
    unit.className = 'legend__unit';
    unit.textContent = axisUnit;
    legendEl.appendChild(unit);
  }
};

export const renderWidget = (targets: RenderTargets, payload: PriceWidgetPayload): void => {
  const { root, priceEl, levelEl, sublineEl, chartEl, legendEl, captionEl } = targets;
  const doc = root.ownerDocument;
  root.dataset.state = payload.state;
  if (payload.state === 'empty') {
    priceEl.textContent = payload.title;
    levelEl.hidden = true;
    sublineEl.textContent = payload.subtitle;
    chartEl.replaceChildren();
    legendEl.replaceChildren();
    captionEl.hidden = true;
    return;
  }
  priceEl.textContent = payload.priceText;
  levelEl.hidden = payload.level === null;
  levelEl.textContent = payload.level?.label ?? '';
  levelEl.className = payload.level?.tone
    ? `headline__level headline__level--chip headline__level--${payload.level.tone}`
    : 'headline__level';
  sublineEl.textContent = payload.subline;
  chartEl.replaceChildren(renderChart(doc, payload.chart, payload.ariaLabel));
  renderLegend(doc, legendEl, payload.legend, payload.chart.axisUnit);
  captionEl.hidden = payload.caption === null;
  captionEl.textContent = payload.caption ?? '';
};
