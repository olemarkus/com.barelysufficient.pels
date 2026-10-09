import type {
  DeferredObjectivePlanPreviewHour,
  DeferredObjectivePlanPreviewPricePoint,
} from '../../../../packages/contracts/src/deferredObjectivePlanPreview';
import { clearChildren } from '../../../_shared/widgetDom';
import { createSvg } from '../../../_shared/widgetSvg';

// Compact price-curve for the create-task preview: the price line across the
// now→deadline window with the SCHEDULED hours shaded behind it, so the user
// can see the planner picked the cheap hours rather than being told it did.
// Deliberately NOT the 480×360 plan_budget chart — that one is bound to its own
// payload and far too tall for this tile. This is a self-contained sparkline-
// scale band with hour ticks and an external legend, without a y-axis grid.
//
// Colour/stroke come from CSS classes (tokenised in index.css), never inline,
// so the chart tracks the dashboard dark/light theme like the rest of the UI.

// viewBox units; the SVG scales to the container width via CSS (width:100%).
const VIEW = { width: 480, height: 108 };
const PLOT = { left: 10, right: 470, top: 14, bottom: 104 };
const PLOT_WIDTH = PLOT.right - PLOT.left;
const PLOT_HEIGHT = PLOT.bottom - PLOT.top;

// Hourly spot prices are piecewise-constant: each hour is a flat price BLOCK,
// not a point on a smooth curve. So the x-axis is divided into `count` equal
// hour buckets and the price is drawn as a step line across them — which is what
// a real electricity price chart looks like. `bucketLeft`/`bucketCenter` resolve
// a bucket's left edge and centre.
const bucketWidth = (count: number): number => PLOT_WIDTH / Math.max(1, count);
const bucketLeft = (index: number, count: number): number => PLOT.left + bucketWidth(count) * index;
const bucketCenter = (index: number, count: number): number => bucketLeft(index, count) + bucketWidth(count) / 2;

// Padded price→y mapping so the curve never hugs the top/bottom edge. Returns a
// constant mid-line when every price is equal (or only one point).
const makeYScale = (prices: number[]): ((price: number) => number) => {
  const finite = prices.filter((p) => Number.isFinite(p));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const pad = max > min ? (max - min) * 0.14 : Math.max(1, Math.abs(max) * 0.1);
  const lo = min - pad;
  const span = max + pad - lo;
  return (price) => PLOT.bottom - ((price - lo) / span) * PLOT_HEIGHT;
};

// Local "HH" hour label for a tick. The authoritative DST-safe labels are a
// backend concern; for the curve's sparse ticks the host-local hour matches how
// the user reads the chosen times, and a one-off here avoids a timezone helper
// in the widget bundle.
const hourLabel = (startsAtMs: number): string => String(new Date(startsAtMs).getHours()).padStart(2, '0');

// Contiguous runs of scheduled indices, so an N-hour window shades as one band
// rather than abutting per-hour rects.
const scheduledRuns = (scheduledIndexes: number[]): Array<{ start: number; end: number }> => {
  const sorted = [...scheduledIndexes].sort((a, b) => a - b);
  const runs: Array<{ start: number; end: number }> = [];
  for (const index of sorted) {
    const last = runs[runs.length - 1];
    if (last && index === last.end + 1) last.end = index;
    else runs.push({ start: index, end: index });
  }
  return runs;
};

// Step path across the hour buckets: a flat segment at each bucket's price,
// with a vertical step at the boundary where the price changes. Breaks the pen
// across buckets with no price (null y).
const buildStepPath = (ys: Array<number | null>, count: number): string => {
  let path = '';
  let penDown = false;
  ys.forEach((y, index) => {
    if (y === null) { penDown = false; return; }
    const left = bucketLeft(index, count);
    const right = left + bucketWidth(count);
    // `M` to start a run; otherwise `L` to the new bucket's left edge at the new
    // price — that command IS the vertical step between hours.
    path += `${penDown ? 'L' : 'M'}${left.toFixed(1)} ${y.toFixed(1)} L${right.toFixed(1)} ${y.toFixed(1)} `;
    penDown = true;
  });
  return path.trim();
};

export type PreviewChartInput = {
  priceSeries: DeferredObjectivePlanPreviewPricePoint[];
  scheduledHours: DeferredObjectivePlanPreviewHour[];
};

// Render the price curve into `container` (cleared first). Returns false when
// there is nothing chartable (no priced points) so the caller can hide the
// chart and fall back to the text lines.
export const renderPreviewChart = (
  container: HTMLElement,
  { priceSeries, scheduledHours }: PreviewChartInput,
): boolean => {
  const doc = container.ownerDocument;
  clearChildren(container);

  const count = priceSeries.length;
  const prices = priceSeries.map((point) => point.price).filter((p): p is number => Number.isFinite(p));
  if (count < 2 || prices.length === 0) return false;

  const yScale = makeYScale(prices);
  const ys = priceSeries.map((point) => (Number.isFinite(point.price) ? yScale(point.price as number) : null));
  const scheduledStarts = new Set(scheduledHours.map((hour) => hour.startsAtMs));
  const scheduledIndexes = priceSeries
    .map((point, index) => (scheduledStarts.has(point.startsAtMs) ? index : -1))
    .filter((index) => index >= 0);

  const svg = createSvg(doc, 'svg', {
    class: 'pchart',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });

  // 1) Scheduled-hour bands behind everything: shade the chosen hour buckets
  // edge-to-edge so the band aligns with the price steps, not a centred slot.
  for (const run of scheduledRuns(scheduledIndexes)) {
    const x1 = bucketLeft(run.start, count);
    const x2 = bucketLeft(run.end, count) + bucketWidth(count);
    svg.appendChild(createSvg(doc, 'rect', {
      class: 'pchart__band',
      x: x1, y: PLOT.top, width: Math.max(0, x2 - x1), height: PLOT_HEIGHT, rx: 3,
    }));
  }

  // 2) Stepped price line across the hour buckets (breaks across null prices).
  const stepPath = buildStepPath(ys, count);
  if (stepPath) svg.appendChild(createSvg(doc, 'path', { class: 'pchart__line', d: stepPath }));

  // 3) Dots at the centre of each scheduled hour's step so the chosen hours read
  // even at a glance.
  for (const index of scheduledIndexes) {
    const y = ys[index];
    if (y !== null) {
      svg.appendChild(createSvg(doc, 'circle', {
        class: 'pchart__dot', cx: bucketCenter(index, count), cy: y, r: 4,
      }));
    }
  }

  // 4) Sparse hour ticks at bucket centres: first, last, and ~every third — but
  // suppress an every-third tick within two buckets of the last one, so its label
  // can't collide with the always-shown final tick on a long (23–24h) window.
  const axis = doc.createElement('div');
  axis.className = 'pchart-axis';
  priceSeries.forEach((point, index) => {
    const show = index === 0
      || index === count - 1
      || (index % 3 === 0 && (count - 1 - index) >= 2);
    if (!show) return;
    // HTML labels keep the host's caption size when the chart is narrow.
    const label = doc.createElement('span');
    label.className = 'pchart__axis';
    label.style.left = `${bucketCenter(index, count) / VIEW.width * 100}%`;
    label.textContent = hourLabel(point.startsAtMs);
    axis.appendChild(label);
  });

  container.appendChild(svg);
  container.appendChild(axis);
  return true;
};
