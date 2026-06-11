// Pinned chart readout row (chart-overhaul Phase 3).
//
// Touch grammar shared with the smart-task pages: ECharts floating tooltips
// are disabled on coarse pointers (a finger covers the data) and the chart
// instead drives a pinned readout row under the plot plus a visible selected
// state on the tapped bar. The listener sits at the zr level and resolves any
// plot-area position to a category index via `convertFromPixel`, so taps are
// column-tolerant — thin bars at 320 px don't require pixel-perfect hits
// (same approach as `deadlineChartScrub.ts`; this generalisation serves the
// imperative module-singleton charts, which re-render via
// `setOption(notMerge: true)` and therefore need the selection re-applied on
// every refresh).
import type { ChartReadoutContent } from './chartTooltipFormat.ts';
import type { EChartsType } from './echartsRegistry.ts';

// True on touch-first environments (the Homey WebView). Mirrors the tippy
// trigger gate in `tooltips.ts` so DOM tooltips and chart tooltips flip to
// touch behaviour together.
export const prefersCoarsePointer = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none), (pointer: coarse)').matches;
};

// Resolve a plot-area pixel to a category-axis column index; null when the
// position is outside the grid or doesn't land on a column. Extracted from
// the deadline-plan schedule chart's scrub resolver so every category-axis
// chart shares the same column-tolerant tap math.
export const resolveCategoryIndexFromPixel = (
  chart: EChartsType,
  x: number,
  y: number,
  itemCount: number,
): number | null => {
  if (itemCount <= 0) return null;
  if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
  // Single-axis finder takes the scalar pixel coordinate — passing an
  // `[x, y]` pair makes ECharts return null on a category axis.
  const raw = chart.convertFromPixel({ xAxisIndex: 0 }, x);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const index = Math.round(value);
  return index >= 0 && index < itemCount ? index : null;
};

type ChartReadoutState = {
  itemCount: number;
  defaultIndex: number;
  resolveContent: (index: number) => ChartReadoutContent | null;
};

export type ChartReadoutHandle = {
  // Called after every `setOption` with the fresh data shape. Re-applies the
  // selection (a `notMerge` refresh wipes ECharts' select state) and
  // re-renders the readout row.
  update: (state: ChartReadoutState) => void;
  detach: () => void;
};

const renderHost = (host: HTMLElement, content: ChartReadoutContent | null): void => {
  host.replaceChildren();
  if (!content) return;
  const primary = document.createElement('div');
  primary.className = 'chart-readout__primary';
  primary.textContent = content.when;
  const secondary = document.createElement('div');
  secondary.className = 'chart-readout__secondary';
  content.values.forEach((value, index) => {
    if (index > 0) secondary.append(' · ');
    const span = document.createElement('span');
    if (value.tone === 'warn') span.className = 'chart-readout__value--warn';
    span.textContent = value.text;
    secondary.append(span);
  });
  host.append(primary, secondary);
};

// Attach the readout interaction to a persistent chart instance. The handle
// outlives individual renders: callers attach once per chart lifetime and
// call `update` after each `setOption`, so an explicit user selection
// survives the realtime refresh cycle. A tap outside the plot grid (or on a
// position that doesn't resolve to a column) restores the default selection,
// so the row is never empty.
export const attachChartReadout = (params: {
  chart: EChartsType;
  host: HTMLElement;
  seriesIndex?: number;
}): ChartReadoutHandle => {
  const { chart, host } = params;
  const seriesIndex = params.seriesIndex ?? 0;
  let state: ChartReadoutState | null = null;
  // Explicit user selection; null means "follow the default index".
  let selected: number | null = null;
  let detached = false;

  const applySelection = (): void => {
    if (!state || state.itemCount <= 0) {
      renderHost(host, null);
      return;
    }
    const fallback = Math.min(Math.max(state.defaultIndex, 0), state.itemCount - 1);
    const effective = selected !== null && selected >= 0 && selected < state.itemCount
      ? selected
      : fallback;
    // Deterministic re-apply: clear the whole series selection first so
    // neither a `notMerge` wipe nor ECharts' own click-toggle can leave the
    // visual mark out of sync with the readout row.
    chart.dispatchAction({
      type: 'unselect',
      seriesIndex,
      dataIndex: Array.from({ length: state.itemCount }, (_, index) => index),
    });
    chart.dispatchAction({ type: 'select', seriesIndex, dataIndex: effective });
    renderHost(host, state.resolveContent(effective));
  };

  chart.getZr().on('click', (event) => {
    if (detached || !state) return;
    selected = resolveCategoryIndexFromPixel(chart, event.offsetX, event.offsetY, state.itemCount);
    applySelection();
  });

  return {
    update: (next: ChartReadoutState) => {
      if (detached) return;
      state = next;
      if (selected !== null && selected >= next.itemCount) selected = null;
      applySelection();
    },
    detach: () => {
      // The zr handler can't be unregistered through the narrow `on`-only
      // surface; the flag neutralises it until the caller disposes the chart
      // (which tears the zr instance down with it).
      detached = true;
      state = null;
      host.replaceChildren();
    },
  };
};
