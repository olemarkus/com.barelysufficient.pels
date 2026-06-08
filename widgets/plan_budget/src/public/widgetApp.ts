import {
  VIEWPORT_MIN_HEIGHT,
  parseBucketLocalHour,
  renderEmptyState,
  renderWidget,
  resolveSummaryParts,
} from './chart';
import {
  applyPreviewTheme,
  createRefreshLoop,
  installWidget as installSharedWidget,
  type WidgetController as SharedWidgetController,
} from '../../../_shared/widgetRuntime';
import { resolvePreviewPayload } from './previewPayloads';
import {
  PLAN_PRICE_WIDGET_EMPTY,
  PLAN_PRICE_WIDGET_TABS,
  PLAN_PRICE_WIDGET_TITLE,
  type PlanPriceWidgetHalf,
} from '../../../../packages/shared-domain/src/planPriceWidgetCopy';
import type { PlanPriceWidgetPayload, WidgetTarget } from '../planPriceWidgetTypes';

const LOAD_ERROR_SUBTITLE = PLAN_PRICE_WIDGET_EMPTY.loadError;
const REFRESH_INTERVAL_MS = 60 * 1000;
const WIDGET_TITLE = PLAN_PRICE_WIDGET_TITLE;

// Default the open tab to the half containing the current hour, so a today
// view lands on the slice the user most likely cares about.
const HALF_SPLIT_HOUR = 12;

const HALVES: readonly PlanPriceWidgetHalf[] = ['morning', 'afternoon'];

type WidgetSettings = {
  day?: string;
};

export type WidgetHomey = {
  api: (method: 'GET', path: string) => Promise<PlanPriceWidgetPayload>;
  getSettings?: () => unknown;
  ready?: () => void;
};

export type WidgetWindow = Window & {
  Homey?: WidgetHomey;
  onHomeyReady?: (homey: WidgetHomey) => void;
  // Read off the window so the typed lint resolves the constructor when the
  // chart's height-responsive observer is wired (absent in jsdom/preview, where
  // the chart falls back to its 4:3 minimum height).
  ResizeObserver?: typeof globalThis.ResizeObserver;
};

export type WidgetController = SharedWidgetController<WidgetHomey>;

export type WidgetTargets = {
  chartEl: SVGSVGElement;
  summaryEl: HTMLElement;
  summaryHeadlineEl: HTMLElement;
  summaryStatusEl: HTMLElement;
  tabsEl: HTMLElement;
  tabButtons: Record<PlanPriceWidgetHalf, HTMLButtonElement>;
};

type WidgetControllerDeps = {
  targets: WidgetTargets;
  widgetDocument: Document;
  widgetWindow: WidgetWindow;
};

const isWidgetSettings = (value: unknown): value is WidgetSettings => (
  typeof value === 'object' && value !== null
);

const getWidgetSettings = (homey: WidgetHomey | null): WidgetSettings => {
  const settings = homey?.getSettings?.();
  return isWidgetSettings(settings) ? settings : {};
};

export const resolveTarget = (
  settings: WidgetSettings,
  searchParams: URLSearchParams,
): WidgetTarget => {
  const previewTarget = searchParams.get('day');
  if (previewTarget === 'tomorrow') return 'tomorrow';
  if (previewTarget === 'today') return 'today';
  return settings.day === 'tomorrow' ? 'tomorrow' : 'today';
};

// Choose the half to open first: the one holding `currentIndex` for a today
// payload that knows "now"; otherwise the morning. Decide from the current
// bucket's LOCAL hour (its hour label) rather than its array index, so a DST day
// (23/25 buckets) still opens the tab whose `00–12` / `12–24` label matches the
// wall-clock hour.
export const resolveInitialHalf = (payload: PlanPriceWidgetPayload | null): PlanPriceWidgetHalf => {
  if (payload?.state === 'ready' && payload.showNow) {
    const hour = parseBucketLocalHour(payload.bucketLabels[payload.currentIndex]) ?? payload.currentIndex;
    return hour < HALF_SPLIT_HOUR ? 'morning' : 'afternoon';
  }
  return 'morning';
};

// Re-exported under the widget-local name the browser test imports; the
// implementation is the shared runtime's `applyPreviewTheme`.
export const maybeApplyPreviewTheme = applyPreviewTheme;

const resolveTargets = (widgetDocument: Document): WidgetTargets | null => {
  const chartEl = widgetDocument.getElementById('chart');
  const summaryEl = widgetDocument.querySelector('[data-summary]');
  const summaryHeadlineEl = widgetDocument.querySelector('[data-summary-headline]');
  const summaryStatusEl = widgetDocument.querySelector('[data-summary-status]');
  const tabsEl = widgetDocument.querySelector('[data-tabs]');
  const morningBtn = widgetDocument.querySelector('[data-tab="morning"]');
  const afternoonBtn = widgetDocument.querySelector('[data-tab="afternoon"]');

  if (
    !(chartEl instanceof SVGSVGElement)
    || !(summaryEl instanceof HTMLElement)
    || !(summaryHeadlineEl instanceof HTMLElement)
    || !(summaryStatusEl instanceof HTMLElement)
    || !(tabsEl instanceof HTMLElement)
    || !(morningBtn instanceof HTMLButtonElement)
    || !(afternoonBtn instanceof HTMLButtonElement)
  ) {
    return null;
  }

  return {
    chartEl,
    summaryEl,
    summaryHeadlineEl,
    summaryStatusEl,
    tabsEl,
    tabButtons: { morning: morningBtn, afternoon: afternoonBtn },
  };
};

// The kebab-case CSS modifier for a tone (the domain tone is snake_case; CSS
// classes are kebab per the stylelint BEM pattern). One per non-null tone.
const SUMMARY_TONE_CLASS = {
  on_track: 'summary--on-track',
  over: 'summary--over',
} as const;
const SUMMARY_TONE_CLASSES = Object.values(SUMMARY_TONE_CLASS);

// Write the two-tier summary: a prominent headline plus a toned status chip.
// All strings come from shared-domain (`resolveSummaryParts`); the chip colour
// is carried by a `summary--<tone>` modifier on the container. Empty payload →
// blank headline + hidden chip + the whole header collapsed.
const applySummary = (targets: WidgetTargets, payload: PlanPriceWidgetPayload | null): void => {
  const { summaryEl, summaryHeadlineEl, summaryStatusEl } = targets;
  const parts = resolveSummaryParts(payload);

  summaryEl.classList.remove(...SUMMARY_TONE_CLASSES);
  summaryHeadlineEl.textContent = parts?.headline ?? '';

  const status = parts?.status ?? '';
  summaryStatusEl.textContent = status;
  summaryStatusEl.hidden = status === '';
  if (parts?.tone) summaryEl.classList.add(SUMMARY_TONE_CLASS[parts.tone]);

  // Collapse the whole header when there's nothing to show (the `:empty`
  // selector can't fire on a container that always holds the two child spans).
  summaryEl.hidden = !parts;
};

// The viewBox width is fixed; one viewBox unit spans `widthPx / 480` CSS px.
const VIEWPORT_WIDTH = 480;

type ChartMeasurement = {
  // The container height expressed in viewBox units (measuredPx / scale).
  height: number;
};

// Measure the chart container's height in viewBox units for the responsive
// viewBox. Returns the 4:3 minimum when no layout box is available yet
// (jsdom/preview/pre-paint), so the chart still renders at its natural ratio.
const measureChart = (chartEl: SVGSVGElement): ChartMeasurement => {
  const rect = chartEl.getBoundingClientRect?.();
  const measured = rect?.height ?? 0;
  const width = rect?.width ?? 0;
  if (!Number.isFinite(measured) || measured <= 0 || !Number.isFinite(width) || width <= 0) {
    return { height: VIEWPORT_MIN_HEIGHT };
  }
  // The viewBox keeps width 480; scale the measured pixel height into viewBox
  // units so the chart fills the container's true aspect ratio (clamped in
  // chart.ts). The geometry then fills the panel in unit space, so the same
  // fraction of the card is covered at any width without a separate scale.
  const scale = width / VIEWPORT_WIDTH;
  return { height: measured / scale };
};

// Reflect the projected summary, tab visibility, and selected tab into the DOM,
// then redraw the chart for the active half at the container's measured height.
// Pulled out of the controller so the closure stays small and lint-clean.
const renderView = (
  targets: WidgetTargets,
  payload: PlanPriceWidgetPayload | null,
  half: PlanPriceWidgetHalf,
): void => {
  const { chartEl, tabsEl, tabButtons } = targets;
  tabsEl.hidden = payload?.state !== 'ready';
  applySummary(targets, payload);

  HALVES.forEach((value) => {
    const selected = value === half;
    const button = tabButtons[value];
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    button.classList.toggle('tab--active', selected);
  });

  const { height } = measureChart(chartEl);
  renderWidget(chartEl, payload, half, height);
};

// Tear the view down to the load-error state. Destructured so the assignments
// don't trip no-param-reassign on the shared targets object.
const renderLoadErrorView = (
  targets: WidgetTargets,
  title: string,
  subtitle: string,
): void => {
  const { chartEl, tabsEl } = targets;
  tabsEl.hidden = true;
  applySummary(targets, null);
  const { height } = measureChart(chartEl);
  renderEmptyState(chartEl, { title, subtitle }, height);
};

// Map a keydown to the half it selects, or null when the key is irrelevant.
const keyToHalf = (key: string): PlanPriceWidgetHalf | null => {
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'End') return 'afternoon';
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home') return 'morning';
  return null;
};

type SelectHalf = (value: PlanPriceWidgetHalf, focus: boolean) => void;

// Wire click + keyboard (WAI-ARIA tabs) selection onto the segmented control.
// Returns an unbind fn. Kept out of the controller closure so it stays small.
const bindTabInteraction = (tabsEl: HTMLElement, selectHalf: SelectHalf): (() => void) => {
  const handleClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('[data-tab]');
    if (!(button instanceof HTMLElement)) return;
    const value = button.dataset.tab;
    if (value === 'morning' || value === 'afternoon') selectHalf(value, false);
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    const next = keyToHalf(event.key);
    if (!next) return;
    event.preventDefault();
    selectHalf(next, true);
  };

  tabsEl.addEventListener('click', handleClick);
  tabsEl.addEventListener('keydown', handleKeydown);

  return (): void => {
    tabsEl.removeEventListener('click', handleClick);
    tabsEl.removeEventListener('keydown', handleKeydown);
  };
};

export const createWidgetController = (
  { targets, widgetDocument, widgetWindow }: WidgetControllerDeps,
): WidgetController => {
  const { chartEl, tabsEl, tabButtons } = targets;
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let unbindTabs: (() => void) | null = null;
  let lastPayload: PlanPriceWidgetPayload | null = null;
  let half: PlanPriceWidgetHalf = 'morning';
  let halfPinned = false;
  let resizeObserver: ResizeObserver | null = null;
  // A signature of the last-drawn measurement (rounded unit-height); lets the
  // resize handler skip re-rendering when it hasn't changed (the observer fires on
  // every sub-pixel reflow). The geometry depends only on the viewBox unit-height
  // now — the body fills the panel in unit space, so width no longer factors in.
  let lastDrawnSignature = '';
  const measurementSignature = (m: { height: number }): string =>
    `${Math.round(m.height)}`;
  // Set once destroy() runs; guards in-flight async loads from rendering to a
  // detached DOM after teardown (destroy doesn't bump loadSequence).
  let destroyed = false;
  // True while the view is showing the load-error state (a refresh failed after a
  // prior render). `lastPayload` is null in this state — the SAME null as a
  // genuine no-data payload — so a bare `render()` (e.g. from the ResizeObserver)
  // would repaint the no-data empty state and wipe the error copy. Track the mode
  // explicitly, mirroring the `destroyed` flag, so a resize re-renders the error
  // view. Cleared on the next successful load.
  let inErrorState = false;

  const labelTabs = (): void => {
    tabButtons.morning.textContent = PLAN_PRICE_WIDGET_TABS.morning;
    tabButtons.afternoon.textContent = PLAN_PRICE_WIDGET_TABS.afternoon;
  };

  const render = (): void => {
    lastDrawnSignature = measurementSignature(measureChart(chartEl));
    if (inErrorState) {
      renderLoadErrorView(targets, WIDGET_TITLE, LOAD_ERROR_SUBTITLE);
      return;
    }
    renderView(targets, lastPayload, half);
  };

  // The chart is `height: 100%` in a tall dashboard cell, so its pixel height
  // changes when the tile is resized. Re-draw at the new measured height so the
  // chart fills the cell (clamped 4:3…2:3 in chart.ts) instead of letterboxing.
  // Guarded against teardown (mirrors the `destroyed` flag) and against no-op
  // ticks (height unchanged after the clamp). ResizeObserver is read off the
  // window so jsdom/preview (no constructor) simply skips the responsive path.
  const handleResize = (): void => {
    if (destroyed) return;
    if (measurementSignature(measureChart(chartEl)) === lastDrawnSignature) return;
    render();
  };

  const observeResize = (): void => {
    if (resizeObserver || typeof widgetWindow.ResizeObserver !== 'function') return;
    resizeObserver = new widgetWindow.ResizeObserver(() => handleResize());
    resizeObserver.observe(chartEl);
  };

  const disconnectResize = (): void => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  };

  const selectHalf: SelectHalf = (value, focus): void => {
    halfPinned = true;
    if (value !== half) {
      half = value;
      render();
    }
    if (focus) tabButtons[value].focus();
  };

  const bindInteraction = (): void => {
    if (unbindTabs) return;
    unbindTabs = bindTabInteraction(tabsEl, selectHalf);
  };

  const unbindInteraction = (): void => {
    unbindTabs?.();
    unbindTabs = null;
  };

  const renderLoadError = (): void => {
    lastPayload = null;
    inErrorState = true;
    render();
  };

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;

    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';

      applyPreviewTheme(widgetDocument, searchParams);

      const target = resolveTarget(getWidgetSettings(homeyRef), searchParams);
      const payload = preview || !homeyRef
        ? resolvePreviewPayload(target, searchParams.get('tone'))
        : await homeyRef.api('GET', `/chart?day=${encodeURIComponent(target)}`);

      if (destroyed || loadId !== loadSequence) return;
      lastPayload = payload;
      inErrorState = false;
      // Only auto-pick the half on the first render; once the user has chosen a
      // tab, a background refresh must not yank them back to "now".
      if (!halfPinned) half = resolveInitialHalf(payload);
      render();
    } catch (error) {
      if (destroyed || loadId !== loadSequence) return;
      console.error('Failed to load widget chart', error);
      renderLoadError();
    } finally {
      if (!destroyed && loadId === loadSequence && !initialRenderDone && homeyRef?.ready) {
        homeyRef.ready();
        initialRenderDone = true;
      }
    }
  };

  const refresh = createRefreshLoop({
    widgetWindow,
    widgetDocument,
    intervalMs: REFRESH_INTERVAL_MS,
    onTick: () => { void loadAndRender(); },
  });

  const bootstrap = (homey: WidgetHomey | null): void => {
    if (homey && homey === homeyRef) return;

    homeyRef = homey;
    labelTabs();
    bindInteraction();
    observeResize();
    void loadAndRender();
    refresh.start();
    refresh.bindVisibility();
  };

  const destroy = (): void => {
    destroyed = true;
    refresh.stop();
    unbindInteraction();
    disconnectResize();
  };

  return {
    bootstrap,
    destroy,
    loadAndRender,
  };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => installSharedWidget<WidgetTargets, WidgetHomey, WidgetWindow>({
  widgetWindow,
  widgetDocument,
  resolveTargets,
  createController: createWidgetController,
});
