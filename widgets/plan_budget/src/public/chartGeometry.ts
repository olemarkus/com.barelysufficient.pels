// Panel-fill layout for the plan_budget chart. The SVG viewBox HEIGHT equals the
// measured container height (in viewBox units), so the chart — and the card
// surface (`.chart__panel`) drawn inside it — FILLS the whole dashboard tile at
// any supported width (320–480 px) and height; there is no `meet` letterbox left
// OUTSIDE the panel. The PLOT block (grid + bars + price + x-labels + legend) is
// capped at a sane maximum height (so bars never stretch into spaghetti) and a
// minimum (so short tiles don't squash), then VERTICALLY CENTERED inside the
// panel with the surplus distributed as balanced top/bottom padding INSIDE the
// card. The furniture below the plot (x-labels, legend) moves WITH the plot
// block — a fixed distance below the plot body — rather than being pinned to the
// viewBox bottom.
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

// Plot BODY (the bar/grid area) height band, expressed in CONTAINER PIXELS at the
// reference width (480 px, where 1 viewBox unit = 1 px). Capped at the maximum so
// tall tiles centre the plot with padding instead of stretching ~12 bars into
// spaghetti; floored at the minimum so short tiles stay legible rather than
// squashing.
//
// These are PHYSICAL pixel bands. At a narrower tile (e.g. 320 px) one viewBox
// unit is physically smaller (scale = widthPx/480 < 1), so the same physical cap
// is MORE viewBox units. `resolveGeometry` divides by the scale to convert the
// px band into unit space, so the plot body occupies the SAME physical height at
// every tile width — otherwise a fixed-unit cap renders ~1.5× smaller at 320,
// leaving a huge interior void.
const PLOT_BODY_MIN_PX = 180;
const PLOT_BODY_MAX_PX = 360;

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
// plus everything below it (legend gap + descender pad). The plot body height is
// whatever panel space remains, clamped into the body band.
const BLOCK_OVERHEAD = PLOT_TOP_OFFSET + LEGEND_GAP + BLOCK_BOTTOM_PAD;

// Resolve all geometry for a (clamped) viewBox height. The panel fills the
// viewBox minus the uniform margin; the plot block is capped + vertically centred
// inside the panel, surplus split as balanced top/bottom padding.
//
// `scale` is the container's width scale (`widthPx / 480`): how many CSS px one
// viewBox unit spans. It converts the PHYSICAL-pixel plot-body band into unit
// space so the body stays the same physical size at every tile width. A
// missing/zero scale (jsdom/pre-paint) falls back to 1 — the reference width,
// where unit == px and the band is used verbatim.
export const resolveGeometry = (height: number, scale = 1): Geometry => {
  const unitScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // The px band converted to viewBox units: at a narrow tile (scale < 1) the same
  // physical cap is MORE units, so the plot grows to the reference physical size
  // instead of rendering smaller and over-padding.
  const plotBodyMin = PLOT_BODY_MIN_PX / unitScale;
  const plotBodyMax = PLOT_BODY_MAX_PX / unitScale;
  const panelHeight = height - (PANEL_MARGIN * 2);
  // Space the block could occupy if the plot body weren't capped, then clamp the
  // body into its band. On a tall tile the body hits the max and the leftover
  // panel height becomes balanced padding; on a short tile it floors at the min.
  const availableBody = panelHeight - BLOCK_OVERHEAD;
  const bandedBody = Math.min(plotBodyMax, Math.max(plotBodyMin, availableBody));
  // The MIN_PX floor is a target, not an inviolable floor: at the smallest
  // supported tile (320×~240 → ~360 viewBox units, scale ≈ 0.667) the floored
  // body + the fixed furniture overhead is TALLER than the panel, which would
  // push the legend/x-labels below the viewport and clip them. When the tile is
  // physically too small for the floor, shrink the body DOWN to whatever the
  // panel can hold (>= 0) so the whole block — legend included — stays inside.
  const plotBodyHeight = Math.max(0, Math.min(bandedBody, availableBody));
  const blockHeight = plotBodyHeight + BLOCK_OVERHEAD;
  // Centre the block in the panel; never push it above the panel top when the
  // block is taller than the panel (very short tile — the floor wins, surplus 0).
  const surplus = Math.max(0, panelHeight - blockHeight);
  const blockTop = PANEL_MARGIN + (surplus / 2);

  const plotTop = blockTop + PLOT_TOP_OFFSET;
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
