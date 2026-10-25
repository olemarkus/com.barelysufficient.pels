import { resolveRunBands } from '../../../packages/shared-domain/src/deferredPlanHistoryChartData';
import type {
  DeferredObjectivePlanPreviewInterval,
  DeferredObjectivePlanPreviewPricePoint,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import { clearChildren } from '../widgetDom';
import { createSvg } from '../widgetSvg';

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
const hourLabel = (startsAtMs: number): string => (
  new Date(startsAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
);

const buildStepPath = (
  periods: readonly DeferredObjectivePlanPreviewPricePoint[],
  xScale: (atMs: number) => number,
  yScale: (price: number) => number,
): string => {
  let path = '';
  let previousEnd: number | null = null;
  for (const period of periods) {
    if (period.price === null) { previousEnd = null; continue; }
    const y = yScale(period.price).toFixed(1);
    const command = previousEnd === period.startsAtMs ? 'L' : 'M';
    path += `${command}${xScale(period.startsAtMs).toFixed(1)} ${y} L${xScale(period.endsAtMs).toFixed(1)} ${y} `;
    previousEnd = period.endsAtMs;
  }
  return path.trim();
};

export type PreviewChartInput = {
  priceSeries: DeferredObjectivePlanPreviewPricePoint[];
  scheduledHours: DeferredObjectivePlanPreviewInterval[];
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
  const startMs = priceSeries[0].startsAtMs;
  const endMs = priceSeries[priceSeries.length - 1].endsAtMs;
  const xScale = (atMs: number): number => PLOT.left + (atMs - startMs) / (endMs - startMs) * PLOT_WIDTH;
  const bands = resolveRunBands(scheduledHours, startMs, endMs);
  const svg = createSvg(doc, 'svg', {
    class: 'pchart',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });

  // 1) Scheduled-hour bands behind everything: shade the chosen hour buckets
  // edge-to-edge so the band aligns with the price steps, not a centred slot.
  for (const run of bands) {
    const x1 = xScale(run.fromMs);
    const x2 = xScale(run.toMs);
    svg.appendChild(createSvg(doc, 'rect', {
      class: 'pchart__band',
      x: x1, y: PLOT.top, width: Math.max(0, x2 - x1), height: PLOT_HEIGHT, rx: 3,
    }));
  }

  // 2) Stepped price line across the hour buckets (breaks across null prices).
  const stepPath = buildStepPath(priceSeries, xScale, yScale);
  if (stepPath) svg.appendChild(createSvg(doc, 'path', { class: 'pchart__line', d: stepPath }));

  // A dot at each booked span's centre, using the price at that time.
  for (const period of scheduledHours) {
    const centerMs = (period.startsAtMs + period.endsAtMs) / 2;
    const price = priceSeries.find((point) => point.startsAtMs <= centerMs && point.endsAtMs > centerMs)?.price;
    if (price === null || price === undefined) continue;
    svg.appendChild(createSvg(doc, 'circle', {
      class: 'pchart__dot', cx: xScale(centerMs), cy: yScale(price), r: 4,
    }));
  }

  // 4) Sparse hour ticks at bucket centres: first, last, and ~every third — but
  // suppress an every-third tick within two buckets of the last one, so its label
  // can't collide with the always-shown final tick on a long (23–24h) window.
  const axis = doc.createElement('div');
  axis.className = 'pchart-axis';
  priceSeries.forEach((point, index) => {
    const show = index === 0
      || index === count - 1
      || (index % Math.ceil(count / 5) === 0 && (count - 1 - index) >= Math.ceil(count / 10));
    if (!show) return;
    // HTML labels keep the host's caption size when the chart is narrow.
    const label = doc.createElement('span');
    label.className = 'pchart__axis';
    label.style.left = `${xScale((point.startsAtMs + point.endsAtMs) / 2) / VIEW.width * 100}%`;
    label.textContent = hourLabel(point.startsAtMs);
    axis.appendChild(label);
  });

  container.appendChild(svg);
  container.appendChild(axis);
  return true;
};
