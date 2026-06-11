import { BarChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
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
// Minimal pointer-event surface of a ZRender instance. The deadline-plan
// scrub interaction listens at the zr level (not per-series `chart.on`)
// because 26 one-hour bar columns at 320 px are too thin to tap individually
// — the whole plot area must resolve pointer positions to hour columns.
type ZRenderLike = {
  on: (event: string, handler: (event: { offsetX: number; offsetY: number }) => void) => void;
};

type EChartsType = {
  setOption: (option: EChartsOption, opts?: Record<string, unknown>) => void;
  resize: (opts?: Record<string, unknown>) => void;
  dispose: () => void;
  isDisposed: () => boolean;
  // `convertFromPixel` resolves a pixel coordinate back to an axis value —
  // category index for category axes, ms for time/value axes. Drives the
  // deadline-plan scrub-to-hour snapping. NOTE: with a single-axis finder
  // (`{xAxisIndex}`) the value must be the scalar pixel coordinate along
  // that axis — passing an `[x, y]` pair makes ECharts return null.
  convertFromPixel: (
    finder: { xAxisIndex?: number; yAxisIndex?: number; gridIndex?: number; seriesIndex?: number },
    value: number | number[],
  ) => number | number[] | null;
  // True when the pixel lies inside the referenced coordinate system (grid).
  // Used to treat taps outside the plot area as "restore default selection".
  containPixel: (
    finder: { gridIndex?: number; seriesIndex?: number },
    value: number[],
  ) => boolean;
  // Imperative highlight/downplay for the selected-hour emphasis state.
  dispatchAction: (payload: Record<string, unknown>) => void;
  getZr: () => ZRenderLike;
};
type SeriesOption = Record<string, unknown>;

let isRegistered = false;

const ensureRegistry = () => {
  if (isRegistered) return;
  use([
    BarChart,
    HeatmapChart,
    LineChart,
    ScatterChart,
    GridComponent,
    LegendComponent,
    // Mark components were previously unregistered, so every `markLine` /
    // `markPoint` already present in option builders (deadline now-line,
    // usage-stats budget line, history-detail met marker) silently no-oped.
    // Registered for the smart-task live-page split; the latent marks above
    // now render as their authors intended.
    MarkAreaComponent,
    MarkLineComponent,
    MarkPointComponent,
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
  // Optional hook invoked once per (re-)mount, right after the initial
  // `setOption`. Gives the caller the live chart handle for imperative
  // wiring — the deadline-plan charts attach zr-level scrub handlers and
  // stash the handle for `dispatchAction` selection updates. Runs again on
  // every `deps` remount with the fresh chart; the previous chart was
  // disposed, so callers must not retain stale handles beyond it.
  onChartInit?: (chart: EChartsType, container: HTMLDivElement) => void;
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
  const { buildOption, resolveSize, deps, onChartInit } = params;
  const chartRef = useRef<HTMLDivElement>(null);
  // The `ResizeObserver` / tab-shown handler are long-lived (re-created only on
  // a `deps` change), but must call the LATEST `resolveSize`, not the identity
  // captured when the effect first ran. Hold it in a latest-ref (updated every
  // render) so a re-render with new callbacks but unchanged `deps` doesn't
  // leave the resize path calling stale closures. `buildOption` /
  // `onChartInit` are intentionally NOT ref'd: they run at mount and re-mount
  // is exactly what a `deps` change is for.
  const resolveSizeRef = useRef(resolveSize);
  resolveSizeRef.current = resolveSize;
  useEffect(() => {
    const container = chartRef.current;
    if (!container) return undefined;
    const resolveSizeNow = (element: HTMLElement): ChartSize => resolveSizeRef.current(element);
    const chart = initEcharts(container, undefined, {
      renderer: 'svg',
      ...resolveSizeNow(container),
    });
    chart.setOption(buildOption(container), { notMerge: true });
    onChartInit?.(chart, container);
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        chart.resize(resolveSizeNow(container));
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
