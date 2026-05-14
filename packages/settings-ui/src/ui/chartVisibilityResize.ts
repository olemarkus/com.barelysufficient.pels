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

type AttachParams<TChart extends ChartLike> = {
  container: HTMLElement;
  chart: TChart;
  resolveSize: (element: HTMLElement) => { width: number; height: number };
};

/**
 * Listens for `pels:tab-shown` and calls `chart.resize` once the container is
 * visible. Returns a teardown function that detaches the listener — callers
 * should invoke it in their `dispose` path so old chart handles do not leak.
 */
export const attachTabShownResize = <TChart extends ChartLike>(
  params: AttachParams<TChart>,
): (() => void) => {
  const { container, chart, resolveSize } = params;
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
