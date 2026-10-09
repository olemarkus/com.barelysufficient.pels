// The imperative charts' ECharts lifecycle (power-week heatmap, usage day,
// usage stats, budget): one setup and one teardown. The Preact wrappers mount
// through `useEchartsMount` (`echartsRegistry.ts`) instead; both keep the chart
// sized through `attachChartResize`.
import { initEcharts, type EChartsType } from './echartsRegistry.ts';
import { attachChartResize, type ChartSize } from './chartVisibilityResize.ts';

const DEFAULT_CHART_WIDTH = 480;

/**
 * The width a chart renders at: its container's, else the parent's, else the
 * viewport capped at 480 px (a hidden tab measures 0 wide).
 */
export const resolveChartWidth = (element: HTMLElement): number => {
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (element.parentElement?.clientWidth ?? 0);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  const fallbackWidth = viewportWidth > 0
    ? Math.min(DEFAULT_CHART_WIDTH, viewportWidth)
    : DEFAULT_CHART_WIDTH;
  return width > 0 ? width : fallbackWidth;
};

/** `resolveChartWidth`, with the container's height or `fallbackHeight` while it measures 0. */
export const resolveChartSize = (element: HTMLElement, fallbackHeight: number): ChartSize => ({
  width: resolveChartWidth(element),
  height: element.clientHeight > 0 ? element.clientHeight : fallbackHeight,
});

export type MountedChart = {
  chart: EChartsType;
  /** Detaches the resize wiring and disposes the chart. */
  dispose: () => void;
};

/**
 * An SVG chart on `container` at the resolved size, kept sized to it
 * (`attachChartResize`).
 */
export const mountChart = (
  container: HTMLElement,
  resolveSize: (element: HTMLElement) => ChartSize,
): MountedChart => {
  const chart = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveSize(container),
  });
  const detachResize = attachChartResize(container, chart, resolveSize);
  return {
    chart,
    dispose: () => {
      detachResize();
      chart.dispose();
    },
  };
};
