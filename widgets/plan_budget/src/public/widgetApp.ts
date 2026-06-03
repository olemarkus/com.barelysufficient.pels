import {
  parseBucketLocalHour,
  renderEmptyState,
  renderWidget,
  resolveSummaryText,
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
};

export type WidgetController = SharedWidgetController<WidgetHomey>;

export type WidgetTargets = {
  chartEl: SVGSVGElement;
  summaryEl: HTMLElement;
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
  const tabsEl = widgetDocument.querySelector('[data-tabs]');
  const morningBtn = widgetDocument.querySelector('[data-tab="morning"]');
  const afternoonBtn = widgetDocument.querySelector('[data-tab="afternoon"]');

  if (
    !(chartEl instanceof SVGSVGElement)
    || !(summaryEl instanceof HTMLElement)
    || !(tabsEl instanceof HTMLElement)
    || !(morningBtn instanceof HTMLButtonElement)
    || !(afternoonBtn instanceof HTMLButtonElement)
  ) {
    return null;
  }

  return {
    chartEl,
    summaryEl,
    tabsEl,
    tabButtons: { morning: morningBtn, afternoon: afternoonBtn },
  };
};

// Reflect the projected summary, tab visibility, and selected tab into the DOM,
// then redraw the chart for the active half. Pulled out of the controller so
// the closure stays small and lint-clean.
const renderView = (
  targets: WidgetTargets,
  payload: PlanPriceWidgetPayload | null,
  half: PlanPriceWidgetHalf,
): void => {
  const { chartEl, summaryEl, tabsEl, tabButtons } = targets;
  tabsEl.hidden = payload?.state !== 'ready';
  summaryEl.textContent = resolveSummaryText(payload);

  HALVES.forEach((value) => {
    const selected = value === half;
    const button = tabButtons[value];
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    button.classList.toggle('tab--active', selected);
  });

  renderWidget(chartEl, payload, half);
};

// Tear the view down to the load-error state. Destructured so the assignments
// don't trip no-param-reassign on the shared targets object.
const renderLoadErrorView = (
  targets: WidgetTargets,
  title: string,
  subtitle: string,
): void => {
  const { chartEl, summaryEl, tabsEl } = targets;
  tabsEl.hidden = true;
  summaryEl.textContent = '';
  renderEmptyState(chartEl, { title, subtitle });
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
  const { tabsEl, tabButtons } = targets;
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let unbindTabs: (() => void) | null = null;
  let lastPayload: PlanPriceWidgetPayload | null = null;
  let half: PlanPriceWidgetHalf = 'morning';
  let halfPinned = false;
  // Set once destroy() runs; guards in-flight async loads from rendering to a
  // detached DOM after teardown (destroy doesn't bump loadSequence).
  let destroyed = false;

  const labelTabs = (): void => {
    tabButtons.morning.textContent = PLAN_PRICE_WIDGET_TABS.morning;
    tabButtons.afternoon.textContent = PLAN_PRICE_WIDGET_TABS.afternoon;
  };

  const render = (): void => {
    renderView(targets, lastPayload, half);
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
    renderLoadErrorView(targets, WIDGET_TITLE, LOAD_ERROR_SUBTITLE);
  };

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;

    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';

      applyPreviewTheme(widgetDocument, searchParams);

      const target = resolveTarget(getWidgetSettings(homeyRef), searchParams);
      const payload = preview || !homeyRef
        ? resolvePreviewPayload(target)
        : await homeyRef.api('GET', `/chart?day=${encodeURIComponent(target)}`);

      if (destroyed || loadId !== loadSequence) return;
      lastPayload = payload;
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
    void loadAndRender();
    refresh.start();
    refresh.bindVisibility();
  };

  const destroy = (): void => {
    destroyed = true;
    refresh.stop();
    unbindInteraction();
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
