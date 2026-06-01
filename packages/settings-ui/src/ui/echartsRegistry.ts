import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { format, init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { attachTabShownResize } from './chartVisibilityResize.ts';

type EChartsInitOpts = Record<string, unknown>;
type EChartsOption = Record<string, unknown>;
type EChartsType = {
  setOption: (option: EChartsOption, opts?: Record<string, unknown>) => void;
  resize: (opts?: Record<string, unknown>) => void;
  dispose: () => void;
  // `convertToPixel` returns the pixel position of a data point in the
  // chart's coordinate system. Used by the deadline-plan bar-centre parity
  // test to verify both grids resolve the same `xAxisIndex × dataIndex` to
  // the same `[x, y]` pixel; without exposing the method the test would have
  // to parse SVG path geometry, which is brittle across renderer versions.
  convertToPixel: (
    finder: { xAxisIndex?: number; yAxisIndex?: number; gridIndex?: number; seriesIndex?: number },
    value: number | string | Array<number | string>,
  ) => number | number[];
};
type SeriesOption = Record<string, unknown>;

let isRegistered = false;

const ensureRegistry = () => {
  if (isRegistered) return;
  use([
    BarChart,
    HeatmapChart,
    LineChart,
    GridComponent,
    LegendComponent,
    TooltipComponent,
    VisualMapComponent,
    SVGRenderer,
  ]);
  isRegistered = true;
};

export const initEcharts = (
  dom: HTMLElement,
  theme?: string | object | null,
  opts?: EChartsInitOpts,
): EChartsType => {
  ensureRegistry();
  return init(dom, theme, opts) as EChartsType;
};

export const encodeHtml = (value: string): string => format.encodeHTML(value);

type ChartSize = { width: number; height: number };

type MountEchartsParams = {
  // Builds the option lazily on (re-)mount so the closure captures the fresh
  // palette / typography read off the live container at mount time.
  buildOption: (container: HTMLDivElement) => EChartsOption;
  // Resolves the SVG viewport size. Each call site reads a slightly different
  // container token / fallback width, so the size resolver is injected rather
  // than baked into the primitive.
  resolveSize: (element: HTMLElement) => ChartSize;
  // Re-mount trigger list. Mirrors a `useEffect` dependency array — the chart
  // is disposed + rebuilt whenever any entry changes identity.
  deps: ReadonlyArray<unknown>;
  // Optional post-render side-effect, invoked once after the initial
  // `setOption` and again after every `ResizeObserver` resize. The deadline
  // price-horizon chart uses this to write per-bar pixel centres onto the
  // container for the bar-centre parity test; charts without that need pass
  // nothing and the hook is a no-op on this axis.
  onAfterRender?: (chart: EChartsType, container: HTMLDivElement) => void;
};

// Shared ECharts mount hook for the Preact chart wrappers. Initializes the
// chart with an SVG renderer at the resolved size, applies the lazily-built
// option with `notMerge`, wires a `ResizeObserver` + the `pels:tab-shown`
// resize, and disposes everything on unmount. `deps` controls when the chart
// re-mounts; `buildOption` already closes over the caller's data + palette, so
// it is intentionally excluded from the dependency array (including it would
// remount on every render because the arrow recreates each time).
//
// Imperative module-singleton charts (power-week heatmap, usage-stats,
// budget-redesign, usage-day) deliberately do NOT route through here: they
// reuse a persistent chart instance across re-render calls, expose external
// `dispose`/`clear` entry points, and wrap rendering in try/catch fallbacks —
// a lifecycle that does not collapse into a `useEffect` mount/unmount without
// changing behavior.
export const useEchartsMount = (
  params: MountEchartsParams,
): RefObject<HTMLDivElement> => {
  const { buildOption, resolveSize, deps, onAfterRender } = params;
  const chartRef = useRef<HTMLDivElement>(null);
  // The `ResizeObserver` / tab-shown handler are long-lived (re-created only on
  // a `deps` change), but must call the LATEST `resolveSize` / `onAfterRender`,
  // not the identities captured when the effect first ran. Hold them in
  // latest-refs (updated every render) so a re-render with new callbacks but
  // unchanged `deps` doesn't leave the resize path calling stale closures.
  // `buildOption` is intentionally NOT ref'd: it runs at mount and re-mount is
  // exactly what a `deps` change is for.
  const resolveSizeRef = useRef(resolveSize);
  resolveSizeRef.current = resolveSize;
  const onAfterRenderRef = useRef(onAfterRender);
  onAfterRenderRef.current = onAfterRender;
  useEffect(() => {
    const container = chartRef.current;
    if (!container) return undefined;
    const resolveSizeNow = (element: HTMLElement): ChartSize => resolveSizeRef.current(element);
    const chart = initEcharts(container, undefined, {
      renderer: 'svg',
      ...resolveSizeNow(container),
    });
    chart.setOption(buildOption(container), { notMerge: true });
    onAfterRenderRef.current?.(chart, container);
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        chart.resize(resolveSizeNow(container));
        onAfterRenderRef.current?.(chart, container);
      })
      : null;
    resizeObserver?.observe(container);
    const detachTabShown = attachTabShownResize({ container, chart, resolveSize: resolveSizeNow });
    return () => {
      resizeObserver?.disconnect();
      detachTabShown();
      chart.dispose();
    };
    // `buildOption` closes over the caller-supplied deps already; including it
    // here would re-mount on every render because the arrow recreates.
  }, deps);
  return chartRef;
};

export type {
  EChartsOption,
  EChartsType,
  SeriesOption,
};
