// Shared pointer-scrub primitive for the smart-task charts (live page +
// history detail). Lifted out of `views/DeadlinePlan.tsx` for Phase 1B so the
// history-detail trajectory chart reuses the exact interaction wiring instead
// of cloning it (and so the import direction stays acyclic — the live view
// already imports the history view).
import type { EChartsType, SeriesOption } from './echartsRegistry.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;

// Pointer-down + drag scrubbing that snaps to hour columns. 26 bars at 320 px
// are too thin for individual taps, so the listener sits at the zr level and
// resolves any plot-area position to an hour via `convertFromPixel`. A tap
// outside the grid resolves to `null`, which the shared state treats as
// "restore the default selection". ZRender synthesizes mouse events from
// touch, so the same handlers cover the Homey WebView.
export const attachHourScrub = (
  chart: EChartsType,
  resolveIndex: (x: number, y: number) => number | null,
  onSelect: (index: number | null) => void,
): void => {
  const zr = chart.getZr();
  let dragging = false;
  const apply = (event: { offsetX: number; offsetY: number }): void => {
    onSelect(resolveIndex(event.offsetX, event.offsetY));
  };
  zr.on('mousedown', (event) => {
    dragging = true;
    apply(event);
  });
  zr.on('mousemove', (event) => {
    if (dragging) apply(event);
  });
  zr.on('mouseup', () => {
    dragging = false;
  });
  zr.on('globalout', () => {
    dragging = false;
  });
};

// Resolve a trajectory-chart time-axis position (ms) to an index in the REAL
// hour list. The producer tolerates gapped price buckets (`resolveNowIndex`
// has the same fallback), so deriving the index arithmetically from the first
// hour's start would desynchronise the readout + hairline as soon as an hour
// is missing. Containing bucket wins; a position in a gap or outside the
// listed hours snaps to the nearest bucket (clamping to the ends). Exported
// for unit tests.
export const resolveScrubHourIndex = (
  hours: ReadonlyArray<{ startsAtMs: number }>,
  ms: number,
): number | null => {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, hour] of hours.entries()) {
    const endMs = hour.startsAtMs + ONE_HOUR_MS;
    const distance = ms < hour.startsAtMs
      ? hour.startsAtMs - ms
      : Math.max(0, ms - endMs);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
};

// Hour scrub for a time-axis trajectory chart (live page + history detail): a
// plot-area position resolves to its hour in `hours` (`resolveScrubHourIndex`),
// a tap outside the grid to null.
export const attachTimeAxisHourScrub = (
  chart: EChartsType,
  hours: ReadonlyArray<{ startsAtMs: number }>,
  onSelect: (index: number | null) => void,
): void => attachHourScrub(
  chart,
  (x, y) => {
    if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
    // Scalar pixel for the single-axis finder: an `[x, y]` pair makes ECharts
    // return null.
    const raw = chart.convertFromPixel({ xAxisIndex: 0 }, x);
    const ms = Array.isArray(raw) ? raw[0] : raw;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return resolveScrubHourIndex(hours, ms);
  },
  onSelect,
);

// The selection hairline series of both trajectory charts. Its line style is
// baked into the initial option with the live palette; `setSelectionHairline`
// then feeds only `markLine.data` from the shared scrub state.
export const selectionHairlineSeries = (textColor: string): SeriesOption => ({
  id: 'selection-hairline',
  type: 'line',
  data: [],
  silent: true,
  markLine: {
    silent: true,
    symbol: 'none',
    lineStyle: { color: textColor, width: 1, opacity: 0.5 },
    label: { show: false },
    data: [],
  },
});

// Moves the hairline to the selected hour's centre, merged onto the
// `selection-hairline` series by id; none at the default (null) selection.
export const setSelectionHairline = (chart: EChartsType | null, selectedHourMs: number | null): void => {
  if (!chart || chart.isDisposed()) return;
  chart.setOption({
    series: [{
      id: 'selection-hairline',
      markLine: {
        data: selectedHourMs === null ? [] : [{ xAxis: selectedHourMs + ONE_HOUR_MS / 2 }],
      },
    }],
  });
};
