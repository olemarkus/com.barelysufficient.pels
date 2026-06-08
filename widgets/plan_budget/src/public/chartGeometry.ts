// Panel-fill layout for the plan_budget chart. The SVG viewBox HEIGHT equals the
// measured container height (in viewBox units), so the chart — and the card
// surface (`.chart__panel`) drawn inside it — FILLS the whole dashboard tile at
// any supported width (320–480 px) and height; there is no `meet` letterbox left
// OUTSIDE the panel. The PLOT block (grid + bars + price + x-labels + legend) also
// FILLS the panel: the plot body takes all panel height below the fixed furniture
// overhead, so a tall tile grows the plot toward the card edge rather than capping
// it and pooling an empty band. Growing adds HEIGHT only — bar WIDTH is fixed by
// PLOT_X, so taller tiles never stretch the ~12 bars into spaghetti. The furniture
// below the plot (x-labels, legend) sits a fixed distance below the plot body, so
// it grows with the plot rather than being pinned to the viewBox bottom.
//
// Because the caller passes a height that preserves the container's true aspect
// ratio (`measureChartHeight` scales measured px into the fixed 480 viewBox
// width), the SVG can use `preserveAspectRatio="none"` and still map the viewBox
// 1:1 onto the tile WITHOUT distortion: the x and y scale factors are equal, so
// `<circle>` dots stay round. See `chart.ts` `applyViewBox`.
//
// Split out of chart.ts purely to keep that file under the max-lines budget; it
// has no other consumer and stays browser-safe (no DOM, pure math).

const VIEWPORT_WIDTH = 480;
// The viewBox-height band the caller is clamped into BEFORE centring. The minimum
// (4:3) keeps a short tile from collapsing the panel; the maximum is a guard so a
// runaway measurement can't produce an absurd viewBox. The PLOT is capped/centred
// independently (see PLOT_BODY_*), so a tile between these bounds always fills.
export const VIEWPORT_MIN_HEIGHT = 360;
const VIEWPORT_MAX_HEIGHT = 1600;

// Horizontal layout (height-independent).
const PANEL_X = { x: 12, width: 456, radius: 12 };
// The panel hugs the tile: a small uniform margin on all four sides so it doesn't
// sit edge-to-edge. The panel FILLS the viewBox height minus this top+bottom
// margin, so no empty band is ever left outside the card.
const PANEL_MARGIN = 12;
const PLOT_X = { left: 52, right: 416 };

// Plot-block composition, all relative to the block's top edge (`blockTop`),
// which is positioned to centre the block in the panel. The plot body sits
// PLOT_TOP_OFFSET below blockTop; the x-labels and legend trail a fixed distance
// below the plot body so they travel WITH it.
const PLOT_TOP_OFFSET = 14; // blockTop → plot body top
const AXIS_TITLE_OFFSET = 6; // plot body top → axis-title baseline (above the plot)
const X_LABEL_GAP = 32; // plot body bottom → x-label baseline
const LEGEND_GAP = 78; // plot body bottom → legend baseline
const BLOCK_BOTTOM_PAD = 10; // legend baseline → block bottom (descender room)

export type Geometry = {
  viewport: { width: number; height: number };
  panel: { x: number; y: number; width: number; height: number; radius: number };
  plot: { left: number; right: number; top: number; bottom: number };
  legendY: number;
  xLabelY: number;
  axisTitleY: number;
};

// Clamp a desired viewBox height into the supported band. NaN/non-finite (a
// container with no measured size yet) falls back to the 4:3 minimum.
export const resolveViewportHeight = (desired: number): number => {
  if (!Number.isFinite(desired)) return VIEWPORT_MIN_HEIGHT;
  return Math.min(VIEWPORT_MAX_HEIGHT, Math.max(VIEWPORT_MIN_HEIGHT, Math.round(desired)));
};

// Fixed vertical overhead of the plot block above the plot body (PLOT_TOP_OFFSET)
// plus everything below it (legend gap + descender pad). The plot body takes
// whatever panel height remains below this overhead.
const BLOCK_OVERHEAD = PLOT_TOP_OFFSET + LEGEND_GAP + BLOCK_BOTTOM_PAD;

// Resolve all geometry for a (clamped) viewBox height. The panel fills the viewBox
// minus the uniform margin; the plot block FILLS the panel — the body takes all
// panel height below the fixed furniture overhead, so a tall tile grows the plot
// toward the card edge instead of capping it and pooling an empty band.
//
// Growing the body only adds HEIGHT: bar WIDTH is fixed by PLOT_X, so taller tiles
// never thin the ~12 bars into spaghetti. Width-independence is automatic — the
// body is sized in viewBox units that map 1:1 onto the tile (the caller passes a
// height preserving the tile's true aspect ratio), so the same fraction of the
// card is filled at 320 and 480 with no scale conversion needed. A tile too short
// to seat the furniture shrinks the body to whatever remains (>= 0) so the
// legend/x-labels stay inside the viewport.
export const resolveGeometry = (height: number): Geometry => {
  const panelHeight = height - (PANEL_MARGIN * 2);
  // The body fills the panel below the furniture overhead (>= 0 so a tile too
  // short for the furniture clips nothing — the body collapses, legend stays in).
  const plotBodyHeight = Math.max(0, panelHeight - BLOCK_OVERHEAD);

  const plotTop = PANEL_MARGIN + PLOT_TOP_OFFSET;
  const plotBottom = plotTop + plotBodyHeight;

  return {
    viewport: { width: VIEWPORT_WIDTH, height },
    panel: {
      x: PANEL_X.x,
      y: PANEL_MARGIN,
      width: PANEL_X.width,
      height: panelHeight,
      radius: PANEL_X.radius,
    },
    plot: {
      left: PLOT_X.left,
      right: PLOT_X.right,
      top: plotTop,
      bottom: plotBottom,
    },
    legendY: plotBottom + LEGEND_GAP,
    xLabelY: plotBottom + X_LABEL_GAP,
    axisTitleY: plotTop - AXIS_TITLE_OFFSET,
  };
};
