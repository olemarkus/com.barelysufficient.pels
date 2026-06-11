import {
  SMART_TASK_WIDGET_CHART_MEASURED_LABEL,
  SMART_TASK_WIDGET_CHART_PLANNED_LABEL,
  SMART_TASK_WIDGET_CHART_RUN_BAND_LABEL,
  SMART_TASK_WIDGET_CHART_TARGET_LABEL,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import type {
  DeferredPlanHistoryChartData,
  DeferredPlanHistoryChartPoint,
} from '../../../../packages/shared-domain/src/deferredPlanHistoryChartData';

// Compact planned-vs-actual trajectory for the smart-tasks detail panel: the
// planned progress staircase (where the device should be heading toward target
// by the deadline) overlaid with the observed progress line so far, against a
// horizontal target reference. Shares the producer-resolved
// `DeferredPlanHistoryChartData` shape with the finished-task history chart so a
// tapped on-going OR recently-ended task renders through this one path.
//
// Deliberately NOT the settings-UI ECharts trajectory — this is a self-contained
// ~96px SVG sparkline that fits the fixed 220px widget without a chart library.
// Colour/stroke come from CSS classes (tokenised `--pw-*` in index.css), never
// inline, so it tracks the dashboard light/dark theme.

const SVG_NS = 'http://www.w3.org/2000/svg';

// A series needs at least two points to draw as a line. A lone planned anchor
// (a `cannot_meet`/no-allocated-hours plan integrates to just the start point)
// is NOT a drawable line — counting it would suppress the text-only fallback and
// render a legend over an empty plot.
const MIN_LINE_POINTS = 2;
const isDrawableLine = (points: readonly DeferredPlanHistoryChartPoint[] | null | undefined): boolean => (
  (points?.length ?? 0) >= MIN_LINE_POINTS
);

// viewBox units; the SVG scales to the container width via CSS (width:100%).
const VIEW = { width: 480, height: 96 };
const PLOT = { left: 8, right: 472, top: 10, bottom: 86 };
const PLOT_WIDTH = PLOT.right - PLOT.left;
const PLOT_HEIGHT = PLOT.bottom - PLOT.top;

type SvgAttrs = Record<string, string | number>;

const createSvg = <K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: SvgAttrs,
  text?: string,
): SVGElementTagNameMap[K] => {
  const el = doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
};

// Time → x across the [windowStart, windowEnd] span, clamped to the plot so a
// point that sits exactly on (or just past) an edge doesn't draw outside it.
const makeXScale = (startMs: number, endMs: number): ((atMs: number) => number) => {
  const span = endMs - startMs;
  if (!Number.isFinite(span) || span <= 0) return () => PLOT.left;
  return (atMs) => {
    const fraction = Math.max(0, Math.min(1, (atMs - startMs) / span));
    return PLOT.left + fraction * PLOT_WIDTH;
  };
};

// Padded value → y so the lines never hug the top/bottom edge. Returns a
// constant mid-line when every value is equal (or only one value).
const makeYScale = (values: number[]): ((value: number) => number) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max > min ? (max - min) * 0.12 : Math.max(1, Math.abs(max) * 0.1);
  const lo = min - pad;
  const span = max + pad - lo;
  return (value) => PLOT.bottom - ((value - lo) / span) * PLOT_HEIGHT;
};

const buildPolyline = (
  points: readonly DeferredPlanHistoryChartPoint[],
  xScale: (atMs: number) => number,
  yScale: (value: number) => number,
): string => points
  .map((point, index) => `${index === 0 ? 'M' : 'L'}${xScale(point.atMs).toFixed(1)} ${yScale(point.value).toFixed(1)}`)
  .join(' ');

// Lightly-smoothed path for the observed line. The 15-minute progress samples
// carry sensor jitter that a straight polyline renders as sawtooth noise;
// monotone cubic Hermite interpolation (Fritsch–Carlson tangents → cubic
// Bézier segments) rounds the corners WITHOUT overshooting between samples —
// a smoothed temperature line must never imply readings above/below what was
// measured (a Catmull-Rom spline would). Falls back to the straight polyline
// below 3 points, where there is nothing to smooth.
const buildSmoothPath = (
  points: readonly DeferredPlanHistoryChartPoint[],
  xScale: (atMs: number) => number,
  yScale: (value: number) => number,
): string => {
  if (points.length < 3) return buildPolyline(points, xScale, yScale);
  const pts = points.map((p) => ({ x: xScale(p.atMs), y: yScale(p.value) }));
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = pts[i + 1]!.x - pts[i]!.x;
    slope[i] = dx[i]! > 0 ? (pts[i + 1]!.y - pts[i]!.y) / dx[i]! : 0;
  }
  // Fritsch–Carlson tangents: zero at local extrema (sign change) so each
  // segment stays within its endpoints' y-range.
  const tangents: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i += 1) {
    const prev = slope[i - 1]!;
    const next = slope[i]!;
    if (prev * next <= 0) {
      tangents[i] = 0;
      continue;
    }
    const w1 = 2 * dx[i]! + dx[i - 1]!;
    const w2 = dx[i]! + 2 * dx[i - 1]!;
    tangents[i] = (w1 + w2) / (w1 / prev + w2 / next);
  }
  tangents[n - 1] = slope[n - 2]!;
  let path = `M${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i]! / 3;
    const c1y = pts[i]!.y + tangents[i]! * third;
    const c2y = pts[i + 1]!.y - tangents[i + 1]! * third;
    path += ` C${(pts[i]!.x + third).toFixed(1)} ${c1y.toFixed(1)}`
      + ` ${(pts[i + 1]!.x - third).toFixed(1)} ${c2y.toFixed(1)}`
      + ` ${pts[i + 1]!.x.toFixed(1)} ${pts[i + 1]!.y.toFixed(1)}`;
  }
  return path;
};

// Stepped path for the planned staircase: hold the previous level horizontally
// to the next point's x, then rise/fall vertically to its level (`step: 'end'`).
// The producer emits an extra anchor at each booked hour's start carrying the
// previous cumulative value precisely so this reads as flat-then-riser per hour
// (and flat across idle gaps), rather than a diagonal ramp through the points.
const buildStepPath = (
  points: readonly DeferredPlanHistoryChartPoint[],
  xScale: (atMs: number) => number,
  yScale: (value: number) => number,
): string => {
  if (points.length === 0) return '';
  const xy = points.map((p) => ({ x: xScale(p.atMs), y: yScale(p.value) }));
  let path = `M${xy[0]!.x.toFixed(1)} ${xy[0]!.y.toFixed(1)}`;
  for (let i = 1; i < xy.length; i += 1) {
    // Horizontal to the new x at the previous y, then vertical to the new y.
    path += ` L${xy[i]!.x.toFixed(1)} ${xy[i - 1]!.y.toFixed(1)} L${xy[i]!.x.toFixed(1)} ${xy[i]!.y.toFixed(1)}`;
  }
  return path;
};

// Colour-coded legend so the two lines + target guide read without a manual.
// Crisp HTML text (not in-SVG, which the `preserveAspectRatio:none` scaling
// would squish). Each present series gets one labelled item; the target item
// carries the goal value + unit ("Target 55 °C"). The scheduled-run bands get
// a swatch item (the band tint is too faint to colour a word legibly, so a
// small tinted rect carries the colour and the label stays muted text).
const appendLegend = (container: HTMLElement, data: DeferredPlanHistoryChartData): void => {
  const doc = container.ownerDocument;
  const legend = doc.createElement('div');
  legend.className = 'tchart__legend';
  const addItem = (modifier: string, text: string): HTMLElement => {
    const item = doc.createElement('span');
    item.className = `tchart__legend-item tchart__legend-item--${modifier}`;
    item.textContent = text;
    legend.appendChild(item);
    return item;
  };
  if (isDrawableLine(data.plannedOriginal) || isDrawableLine(data.plannedFinal)) {
    addItem('planned', SMART_TASK_WIDGET_CHART_PLANNED_LABEL);
  }
  if (isDrawableLine(data.observed)) {
    addItem('measured', SMART_TASK_WIDGET_CHART_MEASURED_LABEL);
  }
  if (data.target !== null && data.unit !== null) {
    const rounded = Math.round(data.target * 10) / 10;
    const valueText = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
    addItem('target', `${SMART_TASK_WIDGET_CHART_TARGET_LABEL} ${valueText} ${data.unit}`);
  }
  if (data.runBands.length > 0) {
    const item = addItem('band', SMART_TASK_WIDGET_CHART_RUN_BAND_LABEL);
    const swatch = doc.createElement('span');
    swatch.className = 'tchart__legend-swatch';
    item.prepend(swatch);
  }
  if (legend.childNodes.length > 0) container.appendChild(legend);
};

// Scheduled-run bands — low-opacity rects behind everything, shading the spans
// where the plan booked the device to run. Label-free ON the chart at this
// 96-unit height (the HTML legend above the chart carries the band key);
// xScale's clamp keeps a band that touches the window edge inside the plot.
const appendRunBands = (
  svg: SVGElement,
  doc: Document,
  bands: DeferredPlanHistoryChartData['runBands'],
  xScale: (atMs: number) => number,
): void => {
  for (const band of bands) {
    const x1 = xScale(band.fromMs);
    const x2 = xScale(band.toMs);
    if (x2 <= x1) continue;
    svg.appendChild(createSvg(doc, 'rect', {
      class: 'tchart__band',
      x: x1.toFixed(1),
      y: PLOT.top,
      width: (x2 - x1).toFixed(1),
      height: PLOT_HEIGHT,
    }));
  }
};

const formatAxisValue = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
};

// Data max (top) + min (bottom) labels at the left edge, so even a near-flat
// series reads against a value scale. The top label carries the unit ("65 °C")
// so the axis isn't a mystery number; the bottom stays bare (same unit).
// Skipped when the range collapses to a single value (nothing to scale).
//
// Each label hangs OFF its own value line — max baseline just above
// yScale(dataMax), min baseline just below yScale(dataMin) — instead of
// sitting on it. The y-extremes are by definition the only rows where the
// pad zone above/below is series-free, so the labels can never be struck
// through by the target/planned/observed lines they used to overlap.
const Y_LABEL_GAP = 4;
const appendYAxisLabels = (
  svg: SVGElement,
  doc: Document,
  values: readonly number[],
  unit: string | null,
  yScale: (value: number) => number,
): void => {
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  if (dataMax <= dataMin) return;
  const maxLabel = unit ? `${formatAxisValue(dataMax)} ${unit}` : formatAxisValue(dataMax);
  // Clamp into the viewBox so the squished in-SVG text (non-uniform scaling)
  // keeps its ascenders/descenders on the canvas.
  const maxLabelY = Math.max(10, yScale(dataMax) - Y_LABEL_GAP);
  const minLabelY = Math.min(VIEW.height - 2, yScale(dataMin) + Y_LABEL_GAP + 8);
  svg.appendChild(createSvg(doc, 'text', {
    class: 'tchart__axis', x: PLOT.left, y: maxLabelY, 'text-anchor': 'start',
  }, maxLabel));
  svg.appendChild(createSvg(doc, 'text', {
    class: 'tchart__axis', x: PLOT.left, y: minLabelY, 'text-anchor': 'start',
  }, formatAxisValue(dataMin)));
};

const collectValues = (data: DeferredPlanHistoryChartData): number[] => {
  const values: number[] = [];
  for (const point of data.plannedOriginal) values.push(point.value);
  for (const point of data.plannedFinal ?? []) values.push(point.value);
  for (const point of data.observed) values.push(point.value);
  if (data.target !== null) values.push(data.target);
  return values.filter((value) => Number.isFinite(value));
};

// Renders the trajectory chart into `container` (cleared first). Returns false
// when there is nothing chartable (legacy/empty mode, or no planned staircase
// and fewer than two observed points) so the caller hides the chart and falls
// back to the text lines.
export const renderTrajectoryChart = (
  container: HTMLElement,
  data: DeferredPlanHistoryChartData,
): boolean => {
  const doc = container.ownerDocument;
  while (container.firstChild) container.removeChild(container.firstChild);

  if (data.mode !== 'trajectory') return false;
  const hasPlanned = isDrawableLine(data.plannedOriginal);
  const hasRevised = isDrawableLine(data.plannedFinal);
  const hasObserved = isDrawableLine(data.observed);
  // Need at least one real line; otherwise fall back to the text-only panel.
  if (!hasPlanned && !hasRevised && !hasObserved) return false;

  const values = collectValues(data);
  if (values.length === 0) return false;

  const xScale = makeXScale(data.windowStartMs, data.windowEndMs);
  const yScale = makeYScale(values);

  const svg = createSvg(doc, 'svg', {
    class: 'tchart',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });

  // 0) Scheduled-run bands behind everything.
  appendRunBands(svg, doc, data.runBands, xScale);

  // 1) Target reference line behind the series.
  if (data.target !== null) {
    const y = yScale(data.target);
    svg.appendChild(createSvg(doc, 'line', {
      class: 'tchart__target', x1: PLOT.left, y1: y, x2: PLOT.right, y2: y,
    }));
  }

  // 2) Planned staircase(s). `plannedOriginal` is the primary plan; the revised
  // overlay (finished runs that replanned) draws as a second, lighter line.
  if (hasRevised && data.plannedFinal) {
    svg.appendChild(createSvg(doc, 'path', {
      class: 'tchart__planned-revised', d: buildStepPath(data.plannedFinal, xScale, yScale),
    }));
  }
  if (hasPlanned) {
    svg.appendChild(createSvg(doc, 'path', {
      class: 'tchart__planned', d: buildStepPath(data.plannedOriginal, xScale, yScale),
    }));
  }

  // 3) Observed progress line on top — the "where we actually are" series.
  // Lightly smoothed (monotone, no overshoot) so the 15-minute samples read
  // as a trend, not sensor sawtooth; 2-point series stay a straight segment.
  if (hasObserved) {
    svg.appendChild(createSvg(doc, 'path', {
      class: 'tchart__observed', d: buildSmoothPath(data.observed, xScale, yScale),
    }));
  }

  // 4) Met marker (finished runs that reached/plateaued at target).
  if (data.metAtMs !== null && data.metMarkerValue !== null) {
    svg.appendChild(createSvg(doc, 'circle', {
      class: 'tchart__marker', cx: xScale(data.metAtMs), cy: yScale(data.metMarkerValue), r: 4,
    }));
  } else if (hasObserved) {
    // No met marker → dot the latest observed reading: the "you are here" anchor
    // on an active task, and "where it ended up" on a missed/abandoned run.
    const last = data.observed[data.observed.length - 1]!;
    svg.appendChild(createSvg(doc, 'circle', {
      class: 'tchart__now', cx: xScale(last.atMs), cy: yScale(last.value), r: 4,
    }));
  }

  // 5) Y-axis scale labels so even a near-flat series reads against a value scale.
  appendYAxisLabels(svg, doc, values, data.unit, yScale);

  // Legend ABOVE the chart: the chart is the tallest element, so in tight
  // vertical layouts a legend below it is the first thing to fall off-screen.
  // Placing it first keeps the "what are these lines" key reliably visible.
  appendLegend(container, data);
  container.appendChild(svg);
  return true;
};
