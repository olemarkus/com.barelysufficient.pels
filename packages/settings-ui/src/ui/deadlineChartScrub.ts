// Shared pointer-scrub primitive for the smart-task charts (live page +
// history detail). Lifted out of `views/DeadlinePlan.tsx` for Phase 1B so the
// history-detail trajectory chart reuses the exact interaction wiring instead
// of cloning it (and so the import direction stays acyclic — the live view
// already imports the history view).
import type { EChartsType } from './echartsRegistry.ts';

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
