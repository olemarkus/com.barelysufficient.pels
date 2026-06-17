// Budget-tab chart lifecycle: persistent ECharts instance per container,
// resize wiring, and the pinned-readout interaction (chart-overhaul Phase 3).
// Option assembly lives in `budgetRedesignChartOptions.ts`; the pure data
// derivations and readout content bundles in `budgetRedesignChartData.ts`.
import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { initEcharts, type EChartsType } from './echartsRegistry.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import { attachTabShownResize } from './chartVisibilityResize.ts';
import { attachChartReadout, type ChartReadoutHandle } from './chartReadout.ts';
import {
  buildBudgetHourlyReadoutBundle,
  buildBudgetMoneyProgressReadoutBundle,
  buildBudgetProgressReadoutBundle,
  type BudgetChartUnit,
  type BudgetReadoutBundle,
  type BudgetRedesignDayView,
} from './budgetRedesignChartData.ts';
import {
  buildHourlyOption,
  buildProgressOption,
  READOUT_MARKER_SERIES_ID,
  resolveBudgetChartPalette,
} from './budgetRedesignChartOptions.ts';

export type BudgetRedesignChartMode = 'progress' | 'hourlyPlan';
export type { BudgetChartUnit, BudgetRedesignDayView } from './budgetRedesignChartData.ts';

type BudgetRedesignChartParams = {
  container: HTMLElement;
  payload: DailyBudgetDayPayload;
  mode: BudgetRedesignChartMode;
  view: BudgetRedesignDayView;
  priceReliable: boolean;
  costDisplay: CostDisplay;
  // Progress-mode cumulative unit (kWh⇄kr toggle). Ignored in hourly mode.
  // Defaults to energy so the Adjust comparison charts stay on kWh.
  unit?: BudgetChartUnit;
  dataMaxOverride?: number;
  // Pinned readout row under the chart (chart-overhaul Phase 3). Optional:
  // the Adjust view's small comparison charts render without one.
  readoutHost?: HTMLElement | null;
};

type ChartHandle = {
  chart: EChartsType;
  resizeObserver?: ResizeObserver;
  detachTabShown?: () => void;
  readout?: ChartReadoutHandle;
  readoutHost?: HTMLElement;
  // Progress-mode marker y-values (cumulative kWh at each index) consumed by
  // the readout's `onSelectionApplied` hook; null in hourly mode where the
  // native bar select border carries the selection identity instead.
  markerValues?: Array<number | null> | null;
};
const chartHandles = new WeakMap<HTMLElement, ChartHandle>();

const DEFAULT_CHART_HEIGHT = 210;
const DEFAULT_CHART_WIDTH = 480;

const resolveChartSize = (element: HTMLElement) => {
  const width = element.clientWidth > 0
    ? element.clientWidth
    : (element.parentElement?.clientWidth ?? 0);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  const fallbackWidth = viewportWidth > 0 ? Math.min(DEFAULT_CHART_WIDTH, viewportWidth) : DEFAULT_CHART_WIDTH;
  return {
    width: width > 0 ? width : fallbackWidth,
    height: element.clientHeight > 0 ? element.clientHeight : DEFAULT_CHART_HEIGHT,
  };
};

export const clearBudgetRedesignChart = (container?: HTMLElement) => {
  if (!container) return;
  const handle = chartHandles.get(container);
  if (!handle) return;
  handle.resizeObserver?.disconnect();
  handle.detachTabShown?.();
  handle.readout?.detach();
  if (handle.readoutHost) handle.readoutHost.hidden = true;
  handle.chart.dispose();
  chartHandles.delete(container);
};

const ensureChart = (container: HTMLElement): EChartsType => {
  const existing = chartHandles.get(container);
  if (existing) return existing.chart;
  container.replaceChildren();
  const chart = initEcharts(container, undefined, {
    renderer: 'svg',
    ...resolveChartSize(container),
  });
  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      const handle = chartHandles.get(container);
      if (!handle) return;
      handle.chart.resize(resolveChartSize(container));
    });
    resizeObserver.observe(container);
  }
  const detachTabShown = attachTabShownResize({ container, chart, resolveSize: resolveChartSize });
  chartHandles.set(container, { chart, resizeObserver, detachTabShown });
  return chart;
};

// Attach the pinned-readout interaction once per chart lifetime. The
// selection-marker hook reads the CURRENT render's `markerValues` off the
// handle, so the closure stays valid across mode switches and realtime
// refreshes without re-attaching (the zr click handler cannot be removed).
const ensureReadout = (container: HTMLElement, host: HTMLElement): ChartReadoutHandle | null => {
  const handle = chartHandles.get(container);
  if (!handle) return null;
  if (handle.readout && handle.readoutHost === host) return handle.readout;
  if (handle.readout) {
    handle.readout.detach();
    if (handle.readoutHost) handle.readoutHost.hidden = true;
  }
  const { chart } = handle;
  handle.readout = attachChartReadout({
    chart,
    host,
    onSelectionApplied: (index) => {
      const current = chartHandles.get(container);
      // Hourly mode (markerValues null): the native bar select border
      // carries the selection identity; the marker series doesn't exist.
      const values = current?.markerValues;
      if (!current || current.chart !== chart || !values) return;
      const value = values[index];
      chart.setOption({
        series: [{
          id: READOUT_MARKER_SERIES_ID,
          data: typeof value === 'number' && Number.isFinite(value) ? [[index, value]] : [],
        }],
      });
    },
  });
  handle.readoutHost = host;
  return handle.readout;
};

export const renderBudgetRedesignChart = (params: BudgetRedesignChartParams) => {
  const {
    container,
    payload,
    mode,
    view,
    priceReliable,
    costDisplay,
    unit = 'energy',
    dataMaxOverride,
    readoutHost = null,
  } = params;
  const palette = resolveBudgetChartPalette(container);
  const isMoney = mode === 'progress' && unit === 'money';
  let bundle: BudgetReadoutBundle;
  if (mode !== 'progress') {
    bundle = buildBudgetHourlyReadoutBundle({ payload, view, priceReliable, costDisplay });
  } else if (isMoney) {
    bundle = buildBudgetMoneyProgressReadoutBundle(payload, view, costDisplay);
  } else {
    bundle = buildBudgetProgressReadoutBundle(payload, view);
  }
  const option = mode === 'progress'
    ? buildProgressOption({ payload, view, palette, readouts: bundle.readouts, dataMaxOverride, unit, costDisplay })
    : buildHourlyOption({
      payload, view, palette, priceReliable, costDisplay, readouts: bundle.readouts, dataMaxOverride,
    });
  const chart = ensureChart(container);
  chart.setOption(option, { notMerge: true });
  if (!readoutHost) return;
  const readout = ensureReadout(container, readoutHost);
  const handle = chartHandles.get(container);
  if (!readout || !handle) return;
  handle.markerValues = bundle.markerValues;
  readoutHost.hidden = bundle.readouts.length === 0;
  // Re-applies the (surviving) selection after the notMerge wipe and
  // re-resolves the readout content for the current mode.
  readout.update({
    itemCount: bundle.readouts.length,
    defaultIndex: bundle.defaultIndex,
    resolveContent: (index) => bundle.readouts[index] ?? null,
    selectSeriesIndexes: bundle.selectSeriesIndexes,
  });
};
