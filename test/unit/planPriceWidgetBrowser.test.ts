// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VIEWPORT_MIN_HEIGHT,
  renderEmptyState,
  renderWidget,
  resolveSummaryParts,
} from '../../widgets/plan_budget/src/public/chart';
import { resolveGeometry, resolveViewportHeight } from '../../widgets/plan_budget/src/public/chartGeometry';
import { findRuleBlock, parseCssRuleBlocks } from '../cssTestUtils';
import { PREVIEW_OVER_PAYLOAD, PREVIEW_TODAY_PAYLOAD } from '../../widgets/plan_budget/src/public/previewPayloads';
import type { PlanPriceWidgetReadyPayload } from '../../widgets/plan_budget/src/planPriceWidgetTypes';
import {
  createWidgetController,
  installWidget,
  maybeApplyPreviewTheme,
  resolveInitialHalf,
  resolveTarget,
  type WidgetHomey,
  type WidgetTargets,
  type WidgetWindow,
} from '../../widgets/plan_budget/src/public/widgetApp';

const MARKUP = `
  <main id="widget-root" class="homey-widget widget-root">
    <div id="summary" class="summary" data-summary aria-live="polite">
      <span class="summary__headline" data-summary-headline></span>
      <span class="summary__status" data-summary-status hidden></span>
    </div>
    <div id="tabs" class="tabs" role="tablist" aria-label="Time of day" data-tabs hidden>
      <button type="button" class="tab" role="tab" data-tab="morning" aria-selected="true"></button>
      <button type="button" class="tab" role="tab" data-tab="afternoon" aria-selected="false"></button>
    </div>
    <svg
      id="chart"
      class="chart"
      viewBox="0 0 480 360"
      preserveAspectRatio="none"
      role="img"
      aria-label="Budget and price chart"
    ></svg>
  </main>
`;

const setDocumentMarkup = (): SVGSVGElement => {
  document.body.innerHTML = MARKUP;
  return document.getElementById('chart') as SVGSVGElement;
};

const resolveTargets = (): WidgetTargets => ({
  chartEl: document.getElementById('chart') as SVGSVGElement,
  summaryEl: document.querySelector('[data-summary]') as HTMLElement,
  summaryHeadlineEl: document.querySelector('[data-summary-headline]') as HTMLElement,
  summaryStatusEl: document.querySelector('[data-summary-status]') as HTMLElement,
  tabsEl: document.querySelector('[data-tabs]') as HTMLElement,
  tabButtons: {
    morning: document.querySelector('[data-tab="morning"]') as HTMLButtonElement,
    afternoon: document.querySelector('[data-tab="afternoon"]') as HTMLButtonElement,
  },
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('plan budget widget browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/');
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
    setDocumentMarkup();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.className = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('renders empty state with accessible text', () => {
    const chartEl = setDocumentMarkup();

    renderEmptyState(chartEl, {
      title: 'Budget and Price',
      subtitle: 'Unable to load widget',
    });

    expect(chartEl.getAttribute('aria-label')).toBe('Unable to load widget');
    expect(chartEl.querySelector('.chart__empty-title')?.textContent).toBe('Budget and Price');
    expect(chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');
  });

  test('renders only the selected half (12 bars) with axis titles and legend', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'morning');

    expect(chartEl.getAttribute('aria-label')).toBe('Budget and price chart for today');
    // 24-hour day → 12 morning bars (not the full 24-bar wall).
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
    // Actuals run to currentIndex 10, all within the morning half.
    expect(chartEl.querySelectorAll('.chart__actual')).toHaveLength(11);
    expect(chartEl.querySelectorAll('.chart__legend-text')).toHaveLength(3);
    expect(chartEl.querySelector('.chart__price')).not.toBeNull();
    const axisTitles = [...chartEl.querySelectorAll('.chart__axis-title')].map((node) => node.textContent);
    expect(axisTitles).toEqual(['kWh', 'øre/kWh']);
  });

  test('afternoon half drops the now marker and past-day actuals', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'afternoon');

    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
    // currentIndex 10 and all actuals live in the morning half.
    expect(chartEl.querySelectorAll('.chart__actual')).toHaveLength(0);
    expect(chartEl.querySelector('.chart__now')).toBeNull();
  });

  // Build a ready payload whose buckets carry the given LOCAL hour labels, so the
  // AM/PM split can be asserted independently of the array index (the DST case).
  const buildDayPayload = (localHourLabels: number[]): PlanPriceWidgetReadyPayload => {
    const count = localHourLabels.length;
    return {
      ...PREVIEW_TODAY_PAYLOAD,
      bucketLabels: localHourLabels.map((hour) => String(hour).padStart(2, '0')),
      plannedKwh: Array.from({ length: count }, () => 0.5),
      actualKwh: Array.from({ length: count }, () => null),
      priceSeries: Array.from({ length: count }, () => 100),
      showActual: false,
      showNow: false,
      currentIndex: 0,
      maxPlan: 1,
      priceMin: 100,
      priceMax: 100,
    };
  };

  test('splits AM/PM by local hour on a 25-hour fall-back DST day', () => {
    const chartEl = setDocumentMarkup();
    // Europe/Oslo fall-back: local 02:00 repeats → 25 buckets, hours
    // 00,01,02,02,03,...,23. Morning (hour < 12) = 13 buckets, afternoon = 12.
    const labels = [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const payload = buildDayPayload(labels);

    renderWidget(chartEl, payload, 'morning');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(13);

    renderWidget(chartEl, payload, 'afternoon');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
  });

  test('splits AM/PM by local hour on a 23-hour spring-forward DST day', () => {
    const chartEl = setDocumentMarkup();
    // Europe/Oslo spring-forward: local 02:00 skipped → 23 buckets, hours
    // 00,01,03,...,23. Morning (hour < 12) = 11 buckets, afternoon = 12.
    const labels = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const payload = buildDayPayload(labels);

    renderWidget(chartEl, payload, 'morning');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(11);

    renderWidget(chartEl, payload, 'afternoon');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
  });

  test('initial half follows the current bucket local hour on a DST day', () => {
    // Contrived day where bucket index 10 carries local hour 13 (PM). Index 10
    // alone (< HALF_SPLIT_HOUR 12) would have wrongly implied the AM tab.
    const labels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13,
      14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const payload: PlanPriceWidgetReadyPayload = {
      ...buildDayPayload(labels),
      showNow: true,
      currentIndex: 10,
    };
    expect(resolveInitialHalf(payload)).toBe('afternoon');
  });

  test('uses Budget/Used/Price legend wording', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'morning');

    const labels = [...chartEl.querySelectorAll('.chart__legend-text')].map((node) => node.textContent);
    expect(labels).toEqual(['Budget', 'Used', 'Price']);
  });

  test('splits the projected summary into headline + toned status parts', () => {
    expect(resolveSummaryParts(PREVIEW_TODAY_PAYLOAD)).toEqual({
      headline: 'Projected 16.8 kWh · 19.60 kr',
      status: 'On track',
      tone: 'on_track',
    });
    // Over budget → red tone status.
    expect(resolveSummaryParts({ ...PREVIEW_TODAY_PAYLOAD, summaryTone: 'over' })).toEqual({
      headline: 'Projected 16.8 kWh · 19.60 kr',
      status: 'Over budget',
      tone: 'over',
    });
    // Tomorrow (tone null) → headline only, no status.
    expect(resolveSummaryParts({ ...PREVIEW_TODAY_PAYLOAD, summaryTone: null })).toEqual({
      headline: 'Projected 16.8 kWh · 19.60 kr',
      status: '',
      tone: null,
    });
    expect(resolveSummaryParts(null)).toBeNull();
  });

  test('renders the two-tier summary with a toned status modifier', () => {
    setDocumentMarkup();
    window.history.replaceState({}, '', '/?preview=1&day=today');

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(null);

    expect(targets.summaryHeadlineEl.textContent).toBe('Projected 16.8 kWh · 19.60 kr');
    expect(targets.summaryStatusEl.textContent).toBe('On track');
    expect(targets.summaryStatusEl.hidden).toBe(false);
    expect(targets.summaryEl.classList.contains('summary--on-track')).toBe(true);

    controller.destroy();
  });

  test('renders empty fallback and missing-price badge states', () => {
    const chartEl = setDocumentMarkup();
    const payload = {
      ...PREVIEW_TODAY_PAYLOAD,
      hasPriceData: false,
      showActual: false,
      priceSeries: Array.from({ length: 24 }, () => null),
      priceAxisUnit: '',
      plannedKwh: [0, ...PREVIEW_TODAY_PAYLOAD.plannedKwh.slice(1)],
    };

    renderWidget(chartEl, null, 'morning');
    expect(chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('No budget data available');

    renderWidget(chartEl, payload, 'morning');
    expect(chartEl.querySelector('.chart__badge')?.textContent).toBe('Price data missing');
    expect(chartEl.querySelector('.chart__price')).toBeNull();
  });

  test('renders price series with flat bounds and gaps', () => {
    const chartEl = setDocumentMarkup();
    const payload = {
      ...PREVIEW_TODAY_PAYLOAD,
      priceMin: 100,
      priceMax: 100,
      priceSeries: [
        100, 100, null, 100, 100, 100, 100, 100, 100, 100, 100, 100,
        100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      ],
    };

    renderWidget(chartEl, payload, 'morning');

    expect(chartEl.querySelector('.chart__price')).not.toBeNull();
    expect(chartEl.querySelector('.chart__price-dot')).not.toBeNull();
  });

  test('resolves the initial half from the current hour', () => {
    expect(resolveInitialHalf(PREVIEW_TODAY_PAYLOAD)).toBe('morning');
    expect(resolveInitialHalf({ ...PREVIEW_TODAY_PAYLOAD, currentIndex: 18 })).toBe('afternoon');
    expect(resolveInitialHalf({ ...PREVIEW_TODAY_PAYLOAD, showNow: false })).toBe('morning');
    expect(resolveInitialHalf(null)).toBe('morning');
  });

  test('applies preview themes and resolves targets from query params first', () => {
    const searchParams = new URLSearchParams('theme=dark&day=tomorrow');

    maybeApplyPreviewTheme(document, searchParams);

    expect(document.body.classList.contains('homey-dark-mode')).toBe(true);
    expect(resolveTarget({ day: 'today' }, searchParams)).toBe('tomorrow');

    maybeApplyPreviewTheme(document, new URLSearchParams('theme=light'));
    expect(document.body.classList.contains('homey-dark-mode')).toBe(false);
  });

  test('loads preview data without Homey and refreshes when visible again', async () => {
    setDocumentMarkup();
    window.history.replaceState({}, '', '/?preview=1&day=tomorrow');

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    await controller.loadAndRender();

    expect(targets.chartEl.getAttribute('aria-label')).toBe('Budget and price chart for tomorrow');
    expect(targets.tabsEl.hidden).toBe(false);
    // Tomorrow has no budget comparison → headline only, no status chip.
    expect(targets.summaryHeadlineEl.textContent).toBe('Projected 15.6 kWh · 18.30 kr');
    expect(targets.summaryStatusEl.hidden).toBe(true);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(targets.chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);

    controller.destroy();
  });

  test('switching tabs re-renders the other half and tracks aria-selected', () => {
    setDocumentMarkup();
    window.history.replaceState({}, '', '/?preview=1&day=tomorrow');

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(null);

    expect(targets.tabButtons.morning.getAttribute('aria-selected')).toBe('true');

    targets.tabButtons.afternoon.click();

    expect(targets.tabButtons.afternoon.getAttribute('aria-selected')).toBe('true');
    expect(targets.tabButtons.morning.getAttribute('aria-selected')).toBe('false');
    expect(targets.chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);

    // Arrow-key navigation moves selection back to morning.
    targets.tabsEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(targets.tabButtons.morning.getAttribute('aria-selected')).toBe('true');

    controller.destroy();
  });

  test('boots with Homey data and calls ready once', async () => {
    setDocumentMarkup();
    const ready = vi.fn();
    const api = vi.fn().mockResolvedValue(PREVIEW_TODAY_PAYLOAD);
    const homey: WidgetHomey = {
      api,
      getSettings: () => ({ day: 'today' }),
      ready,
    };

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(api).toHaveBeenCalledWith('GET', '/chart?day=today');
    expect(ready).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 1000);
    await flushPromises();

    expect(api).toHaveBeenCalledTimes(2);

    controller.destroy();
  });

  test('does not render or call ready() when an in-flight load resolves after destroy()', async () => {
    setDocumentMarkup();
    let resolveApi: (payload: PlanPriceWidgetReadyPayload) => void = () => {};
    const apiPromise = new Promise<PlanPriceWidgetReadyPayload>((resolve) => {
      resolveApi = resolve;
    });
    const ready = vi.fn();
    const homey: WidgetHomey = {
      api: vi.fn().mockReturnValue(apiPromise),
      getSettings: () => ({ day: 'today' }),
      ready,
    };

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey); // starts loadAndRender, suspended on the pending api
    await flushPromises();
    expect(targets.tabsEl.hidden).toBe(true); // nothing rendered yet

    controller.destroy(); // tear down before the load resolves
    resolveApi(PREVIEW_TODAY_PAYLOAD as PlanPriceWidgetReadyPayload);
    await flushPromises();

    // The late resolution must not touch the torn-down DOM, nor call ready().
    expect(targets.tabsEl.hidden).toBe(true);
    expect(ready).not.toHaveBeenCalled();
  });

  test('renders a load error when the Homey API call fails', async () => {
    setDocumentMarkup();
    const ready = vi.fn();
    const homey: WidgetHomey = {
      api: vi.fn().mockRejectedValue(new Error('boom')),
      ready,
    };

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(targets.chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');
    expect(targets.tabsEl.hidden).toBe(true);
    // The two-tier header collapses (hidden + cleared) on the error state.
    expect(targets.summaryEl.hidden).toBe(true);
    expect(targets.summaryHeadlineEl.textContent).toBe('');
    expect(targets.summaryStatusEl.hidden).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  test('keeps the load-error copy after a resize (does not fall back to no-data)', async () => {
    setDocumentMarkup();
    const targets = resolveTargets();

    // Capture the ResizeObserver callback so the test can drive a resize tick, and
    // make the measured height change between renders so the handler does NOT
    // early-return on an unchanged measurement signature.
    let resizeCb: (() => void) | null = null;
    let measuredHeight = 240;
    const observe = vi.fn();
    class StubResizeObserver {
      constructor(cb: () => void) { resizeCb = cb; }

      observe = observe;

      disconnect = vi.fn();

      unobserve = vi.fn();
    }
    const widgetWindow = window as WidgetWindow;
    widgetWindow.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    vi.spyOn(targets.chartEl, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 320, height: measuredHeight }) as DOMRect,
    );

    const homey: WidgetHomey = { api: vi.fn().mockRejectedValue(new Error('boom')), ready: vi.fn() };
    const controller = createWidgetController({ targets, widgetDocument: document, widgetWindow });

    controller.bootstrap(homey);
    await flushPromises();

    // The load failed: the error copy is shown.
    expect(targets.chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');

    // A resize fires (tile grew). The handler re-renders; with `lastPayload` null
    // this previously repainted the NO-DATA empty state and wiped the error copy.
    measuredHeight = 600;
    expect(resizeCb).not.toBeNull();
    resizeCb?.();

    // Error copy survives the resize — NOT the no-data subtitle.
    expect(targets.chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');

    controller.destroy();
    delete widgetWindow.ResizeObserver;
  });

  test('installs the widget entrypoint and registers onHomeyReady', async () => {
    setDocumentMarkup();

    const controller = installWidget(window as WidgetWindow, document);

    expect(controller).not.toBeNull();
    expect(typeof (window as WidgetWindow).onHomeyReady).toBe('function');
    controller?.destroy();

    vi.resetModules();
    setDocumentMarkup();
    const entryModule = await import('../../widgets/plan_budget/src/public/index.ts') as {
      widgetController?: { destroy: () => void } | null;
    };

    expect(typeof (window as WidgetWindow).onHomeyReady).toBe('function');
    entryModule.widgetController?.destroy();
  });

  test('returns null when the widget root is missing', () => {
    document.body.innerHTML = '<main></main>';

    expect(installWidget(window as WidgetWindow, document)).toBeNull();
  });
});

// Panel-fill geometry: at any supported width and tile height the PANEL fills the
// whole viewBox (minus a uniform margin), so no empty band is ever left OUTSIDE
// the card; the PLOT block then FILLS the panel — the body takes all panel height
// below the fixed furniture overhead, so a tall tile grows the plot toward the
// card edge instead of capping it and pooling a dead band. Growing adds height
// only (bar WIDTH is fixed), and a tile too short to seat the furniture shrinks
// the body to fit so nothing clips. The viewBox maps 1:1 onto the tile
// (`preserveAspectRatio="none"`) — non-distorting because the caller passes a
// height preserving the container's true aspect ratio.
describe('plan budget widget panel-fill geometry', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const renderAt = (height: number): SVGSVGElement => {
    const chartEl = setDocumentMarkup();
    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'morning', height);
    return chartEl;
  };

  const PANEL_MARGIN = 12;
  // Fixed furniture overhead inside the plot block (PLOT_TOP_OFFSET + LEGEND_GAP +
  // BLOCK_BOTTOM_PAD); the plot body fills the panel height below it.
  const BLOCK_OVERHEAD = 14 + 78 + 10;
  // A short 4:3 tile, a medium tile, and a tall cell (the case that pooled a dead
  // band INSIDE the card before the plot body was allowed to fill it).
  const SHORT = VIEWPORT_MIN_HEIGHT;
  const MEDIUM = 560;
  const TALL = 960;

  // The width scale the real widget measures: 1.0 at the 480 reference width,
  // 0.667 at the 320 narrow tile.
  const SCALE_320 = 320 / 480;

  const geom = (height: number): ReturnType<typeof resolveGeometry> =>
    resolveGeometry(resolveViewportHeight(height));
  const plotBody = (g: ReturnType<typeof resolveGeometry>): number => g.plot.bottom - g.plot.top;

  // Geometry for a PHYSICALLY tall tile of `pixelH` CSS px at the given width
  // scale: the measured px height maps to `pixelH / scale` viewBox units.
  const geometryForPhysicalTile = (
    pixelH: number,
    scale: number,
  ): ReturnType<typeof resolveGeometry> => geom(pixelH / scale);

  test('the panel fills the viewBox height (minus a uniform margin) at every tile height', () => {
    for (const height of [SHORT, MEDIUM, TALL]) {
      const { panel, viewport } = resolveGeometry(resolveViewportHeight(height));
      expect(viewport.height).toBe(height);
      // Panel hugs the tile: a uniform margin top + bottom, nothing left outside.
      expect(panel.y).toBe(PANEL_MARGIN);
      expect(panel.height).toBe(height - (PANEL_MARGIN * 2));
      expect(panel.y + panel.height).toBe(height - PANEL_MARGIN);
    }
  });

  test('the plot body fills the panel below the furniture overhead at every tile height', () => {
    // The block FILLS the panel: body height + the fixed furniture overhead equals
    // the panel height, so no empty band is pooled inside the card at any height.
    for (const height of [SHORT, MEDIUM, TALL]) {
      const g = geom(height);
      expect(plotBody(g)).toBeGreaterThan(0);
      expect(plotBody(g) + BLOCK_OVERHEAD).toBeCloseTo(g.panel.height, 0);
    }
  });

  test('a taller tile grows the plot body — it is not capped', () => {
    // The fix: the plot body grows with the tile instead of capping and pooling a
    // dead band above it. Bar WIDTH is fixed by PLOT_X, so this only adds height.
    expect(plotBody(geom(TALL))).toBeGreaterThan(plotBody(geom(MEDIUM)));
    expect(plotBody(geom(MEDIUM))).toBeGreaterThan(plotBody(geom(SHORT)));
  });

  test('fills a high fraction of the card at 320 — never less than at 480 (no narrow-tile void)', () => {
    // The old bug: a fixed-unit cap rendered ~1.5× smaller at the narrow 320 tile,
    // leaving a huge interior void. Filling the panel removes the cap, so the narrow
    // tile covers AT LEAST as much of the card as the wide one — no void.
    const PIXEL_H = 700; // a physically tall tile, same px height at both widths
    const frac = (g: ReturnType<typeof resolveGeometry>): number => plotBody(g) / g.panel.height;
    const frac320 = frac(geometryForPhysicalTile(PIXEL_H, SCALE_320));
    const frac480 = frac(geometryForPhysicalTile(PIXEL_H, 1));
    expect(frac480).toBeGreaterThan(0.8);
    expect(frac320).toBeGreaterThanOrEqual(frac480 - 0.01);
  });

  test('the plot block fills the panel on a tall tile — no surplus band, hugs both edges', () => {
    // The block fills the panel rather than centring with a surplus: the axis title
    // sits just below the panel top (only the fixed top offset) and the legend just
    // above the panel bottom (only the fixed descender pad) — no pooled dead band.
    const { panel, plot, legendY, axisTitleY } = geom(TALL);
    const panelTop = panel.y;
    const panelBottom = panel.y + panel.height;
    expect(axisTitleY - panelTop).toBeLessThan(20);
    expect(panelBottom - legendY).toBeLessThan(20);
    // The plot block still sits inside the panel at both edges.
    expect(plot.top).toBeGreaterThan(panelTop);
    expect(legendY).toBeLessThan(panelBottom);
  });

  test('the furniture below the plot travels WITH the plot block, not pinned to the viewBox bottom', () => {
    // Legend + x-labels sit a fixed distance below the plot bottom at every
    // height; as the centred block moves down on a taller tile, they move with it.
    const short = resolveGeometry(resolveViewportHeight(SHORT));
    const tall = resolveGeometry(resolveViewportHeight(TALL));
    const legendGap = (g: ReturnType<typeof resolveGeometry>): number => g.legendY - g.plot.bottom;
    const xLabelGap = (g: ReturnType<typeof resolveGeometry>): number => g.xLabelY - g.plot.bottom;
    expect(legendGap(short)).toBe(legendGap(tall));
    expect(xLabelGap(short)).toBe(xLabelGap(tall));
    // And the furniture sits BELOW the plot, above the panel bottom — not pinned
    // to the viewBox bottom (which would re-open the dead band the redesign kills).
    expect(tall.legendY).toBeLessThan(tall.viewport.height - PANEL_MARGIN);
    expect(tall.legendY).toBeGreaterThan(tall.plot.bottom);
  });

  test('nothing clips at the smallest supported tile (320×~240 short 4:3)', () => {
    // At the 320-wide 4:3 tile (~240 px tall → ~360 viewBox units) the panel is
    // short. The body fills only what remains below the fixed furniture overhead
    // (>= 0), so the legend/x-labels stay inside the viewport rather than being
    // pushed below the bottom edge and clipped.
    const SHORT_320_PX = 240;
    const g = geometryForPhysicalTile(SHORT_320_PX, SCALE_320); // height ≈ 360, scale ≈ 0.667
    expect(g.viewport.height).toBe(VIEWPORT_MIN_HEIGHT);
    const panelBottom = g.panel.y + g.panel.height;
    // Legend, x-labels, and the panel itself all stay inside the viewport — nothing
    // is pushed below the bottom edge.
    expect(g.legendY).toBeLessThanOrEqual(g.viewport.height);
    expect(g.legendY).toBeLessThanOrEqual(panelBottom);
    expect(g.xLabelY).toBeLessThanOrEqual(panelBottom);
    expect(panelBottom).toBeLessThanOrEqual(g.viewport.height);
    // The plot block still sits below its top edge (not collapsed to nothing).
    expect(g.plot.bottom).toBeGreaterThan(g.plot.top);
  });

  test('renders dots as round circles (equal r) at every height, never ellipses', () => {
    // Dots are `<circle r>` (single radius, no rx/ry). With `preserveAspectRatio
    // "none"` they only render round because the caller-supplied viewBox height
    // preserves the container aspect ratio (equal x/y scale) — asserted via the
    // 1:1 mapping below; the circle element itself carries no distortion.
    for (const height of [SHORT, MEDIUM, TALL]) {
      const chartEl = renderAt(height);
      const dots = [...chartEl.querySelectorAll('.chart__actual, .chart__price-dot')];
      expect(dots.length).toBeGreaterThan(0);
      for (const dot of dots) {
        expect(dot.tagName.toLowerCase()).toBe('circle');
        expect(dot.getAttribute('r')).not.toBeNull();
        expect(dot.getAttribute('rx')).toBeNull();
        expect(dot.getAttribute('ry')).toBeNull();
      }
    }
    // The SVG maps the viewBox 1:1 onto the tile (no `meet` letterbox outside the
    // panel); dots stay round because the viewBox height preserves the container
    // aspect ratio, so the x and y scale factors are equal.
    expect(document.getElementById('chart')?.getAttribute('preserveAspectRatio')).toBe('none');
  });

  test('the over-budget preview seeds the red status tone for the render gate', () => {
    // The on_track + null tones are covered by the today/tomorrow payloads; this
    // payload exercises the otherwise-unguarded `over` (red) status chip.
    expect(PREVIEW_OVER_PAYLOAD.summaryTone).toBe('over');
    expect(resolveSummaryParts(PREVIEW_OVER_PAYLOAD)).toMatchObject({ tone: 'over', status: 'Over budget' });
  });
});

// The status/summary line must stay fully legible at real device widths
// (320–480 px). jsdom does not compute layout (no real wrapping or scrollWidth),
// so we pin the source rule that keeps the line from truncating instead:
//   - `flex: 0 0 auto`  → the flex chart below can never squeeze the summary,
//   - `white-space: normal` + `overflow-wrap: anywhere` → it wraps rather than
//     clipping, even for a long unbreakable number/unit that can't break on the
//     ` · ` separators.
describe('plan budget widget summary CSS', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'widgets/plan_budget/src/public/index.css'),
    'utf8',
  );
  const summary = findRuleBlock(parseCssRuleBlocks(css), '.summary');

  test('the .summary rule exists', () => {
    expect(summary).toBeDefined();
  });

  test('the summary cannot be squeezed by the flex chart', () => {
    expect(summary?.body).toMatch(/flex\s*:\s*0\s+0\s+auto/);
  });

  test('the summary wraps instead of truncating, even for unbreakable tokens', () => {
    expect(summary?.body).toMatch(/white-space\s*:\s*normal/);
    expect(summary?.body).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });
});
