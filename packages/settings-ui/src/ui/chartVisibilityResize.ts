// `ResizeObserver` does not reliably fire when a chart container flips from
// `display:none` → visible, so charts stay at their last-known size (usually
// the 480 px hidden-tab fallback). The settings shell dispatches
// `pels:tab-shown` from `realtime.ts` after switching panels; this helper
// listens for it and resizes the chart on the next frame once layout settles.

const TAB_SHOWN_EVENT = 'pels:tab-shown';

export type ChartLike = {
  resize(opts?: { width?: number; height?: number }): void;
  isDisposed?(): boolean;
};

export type ChartSize = { width: number; height: number };

type ResolveChartSize = (element: HTMLElement) => ChartSize;

// Resizes `chart` on `pels:tab-shown` once `container` is visible; returns the
// teardown that detaches the listener.
const attachTabShownResize = (
  container: HTMLElement,
  chart: ChartLike,
  resolveSize: ResolveChartSize,
): (() => void) => {
  // rAF so flex/grid layout has settled after the panel's `display` flip —
  // without it, `clientWidth` can still read the stale 0 on some browsers.
  const handler = () => requestAnimationFrame(() => {
    if (chart.isDisposed?.()) return;
    if (container.offsetWidth <= 0) return;
    chart.resize(resolveSize(container));
  });
  document.addEventListener(TAB_SHOWN_EVENT, handler);
  return () => document.removeEventListener(TAB_SHOWN_EVENT, handler);
};

/**
 * Keeps a chart sized to its container: a `ResizeObserver` (where the browser
 * has one) plus the `pels:tab-shown` resize above. Returns the teardown, which
 * callers run before disposing the chart so old chart handles do not leak.
 */
export const attachChartResize = (
  container: HTMLElement,
  chart: ChartLike,
  resolveSize: ResolveChartSize,
): (() => void) => {
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      chart.resize(resolveSize(container));
    })
    : null;
  resizeObserver?.observe(container);
  const detachTabShown = attachTabShownResize(container, chart, resolveSize);
  return () => {
    resizeObserver?.disconnect();
    detachTabShown();
  };
};
