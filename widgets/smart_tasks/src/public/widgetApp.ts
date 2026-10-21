import { SMART_TASK_WIDGET_LOAD_ERROR_SUBTITLE } from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  applyPreviewTheme,
  createRefreshLoop,
  reloadIfOrphaned,
  installWidget as installSharedWidget,
  type WidgetController as SharedWidgetController,
  type WidgetHomeyBase,
  type WidgetWindowBase,
} from '../../../_shared/widgetRuntime';
import { widgetErrorReporter } from '../../../_shared/widgetClientLog';
import { measureBox, observeBox } from '../../../_shared/widgetChartSize';
import { PREVIEW_SMART_TASKS_PAYLOAD } from './previewPayloads';
import { resolveDetailTargets } from '../../../_shared/smartTaskDetail/detailRender';
import { renderLoading, renderWidget, type RenderTargets } from './render';
import type { SmartTasksWidgetPayload } from '../smartTasksWidgetTypes';

const REFRESH_INTERVAL_MS = 60 * 1000;
// Consecutive failed refreshes tolerated before the widget drops the last good
// render and shows the error state — ~3 × 60 s grace for transient SDK blips.
const MAX_CONSECUTIVE_LOAD_FAILURES = 3;

export type WidgetWindow = WidgetWindowBase & {
  // Declared so the typed lint resolves the constructor when the detail chart's
  // resize observer reads the global `ResizeObserver` off the widget window.
  ResizeObserver?: typeof globalThis.ResizeObserver;
};

// The widget sits at its manifest height and fills the frame (see
// widgets/_shared/widget-frame.css): the list and the detail body scroll
// inside it, so it never calls `Homey.setHeight`.
export type WidgetHomey = WidgetHomeyBase;

export type WidgetController = SharedWidgetController<WidgetHomey>;

// Internal navigation state. `detail` keeps the selected row's deviceId so a
// refresh can rehydrate the same task; the controller drops back to `list`
// when the selected task disappears from the payload (satisfied / abandoned).
type DetailSection = 'active' | 'ended';

// `key` is the row identity within its section: `deviceId` for active tasks,
// the unique history-entry `id` for ended tasks (deviceId is not unique among
// ended rows). See the matching note in render.ts.
type ViewState =
  | { kind: 'list' }
  | { kind: 'detail'; section: DetailSection; key: string };

// The DOM dataset attribute + CSS selector that carry each section's row key.
const SECTION_DOM = {
  active: { buttonSelector: '[data-row-button]', datasetKey: 'deviceId', listKey: 'rowsList' },
  ended: { buttonSelector: '[data-ended-button]', datasetKey: 'historyId', listKey: 'endedRowsList' },
} as const;

// If the open detail panel's task has dropped out of the latest payload
// (satisfied / abandoned / device removed / aged out of the 24h window), fall
// back to the list. Pure so it stays out of the controller closure.
const rehydrateView = (view: ViewState, payload: SmartTasksWidgetPayload | null): ViewState => {
  if (view.kind !== 'detail') return view;
  if (!payload || payload.state !== 'ready') return { kind: 'list' };
  const present = view.section === 'ended'
    ? payload.endedRows.some((row) => row.id === view.key)
    : payload.rows.some((row) => row.deviceId === view.key);
  return present ? view : { kind: 'list' };
};

// Move focus across the list↔detail swap so keyboard / switch-access users
// aren't stranded on a now-hidden element (M3 navigation).
const focusRowButton = (targets: RenderTargets, section: DetailSection, key: string): void => {
  const dom = SECTION_DOM[section];
  const dataAttr = section === 'ended' ? 'data-history-id' : 'data-device-id';
  const button = targets[dom.listKey].querySelector(`${dom.buttonSelector}[${dataAttr}="${key}"]`);
  if (button instanceof HTMLElement) button.focus();
};

// Wire the three click listeners (active row / ended row → open detail; back →
// list) and return a teardown that removes them. Lifted out of the controller
// so the controller closure stays under the size bar; reads/writes the view via
// the passed accessors.
const wireInteraction = (
  targets: RenderTargets,
  deps: { getView: () => ViewState; setView: (next: ViewState) => void; render: () => void },
): (() => void) => {
  const openDetail = (event: Event, section: DetailSection): void => {
    const dom = SECTION_DOM[section];
    const button = event.target instanceof Element ? event.target.closest(dom.buttonSelector) : null;
    if (!(button instanceof HTMLElement)) return;
    const key = button.dataset[dom.datasetKey];
    if (!key) return;
    deps.setView({ kind: 'detail', section, key });
    deps.render();
    targets.detailBackBtn.focus();
  };
  const onRow = (event: Event): void => openDetail(event, 'active');
  const onEnded = (event: Event): void => openDetail(event, 'ended');
  const onBack = (): void => {
    const view = deps.getView();
    if (view.kind === 'list') return;
    deps.setView({ kind: 'list' });
    deps.render();
    focusRowButton(targets, view.section, view.key);
  };
  targets.rowsList.addEventListener('click', onRow);
  targets.endedRowsList.addEventListener('click', onEnded);
  targets.detailBackBtn.addEventListener('click', onBack);
  return (): void => {
    targets.rowsList.removeEventListener('click', onRow);
    targets.endedRowsList.removeEventListener('click', onEnded);
    targets.detailBackBtn.removeEventListener('click', onBack);
  };
};

// The list's plain HTMLElement slots, keyed by the RenderTargets field name.
// `root` (id lookup) and the row templates (HTMLTemplateElement) are resolved
// separately because they need a narrower instanceof check; the detail panel's
// slots come from its shared module.
const GENERIC_TARGET_SELECTORS = {
  listView: '[data-list-view]',
  rowsList: '[data-rows]',
  emptyEl: '[data-empty]',
  emptyHintEl: '[data-empty-hint]',
  overflowEl: '[data-overflow]',
  endedSectionEl: '[data-ended-section]',
  endedHeadingEl: '[data-ended-heading]',
  endedRowsList: '[data-ended-rows]',
} as const;

type GenericTargetKey = keyof typeof GENERIC_TARGET_SELECTORS;
type GenericTargets = Record<GenericTargetKey, HTMLElement>;

const resolveGenericTargets = (widgetDocument: Document): GenericTargets | null => {
  const entries = Object.entries(GENERIC_TARGET_SELECTORS).map(([key, selector]) => {
    const el = widgetDocument.querySelector(selector);
    return el instanceof HTMLElement ? ([key, el] as const) : null;
  });
  if (entries.some((entry) => entry === null)) return null;
  return Object.fromEntries(entries as ReadonlyArray<readonly [string, HTMLElement]>) as GenericTargets;
};

const resolveTargets = (widgetDocument: Document): RenderTargets | null => {
  const root = widgetDocument.getElementById('widget-root');
  const rowTemplate = widgetDocument.getElementById('row-template');
  const endedRowTemplate = widgetDocument.getElementById('ended-row-template');
  const detail = resolveDetailTargets(widgetDocument);
  const generic = resolveGenericTargets(widgetDocument);
  if (
    !(root instanceof HTMLElement)
    || !(rowTemplate instanceof HTMLTemplateElement)
    || !(endedRowTemplate instanceof HTMLTemplateElement)
    || detail === null
    || generic === null
  ) {
    return null;
  }
  return { root, rowTemplate, endedRowTemplate, ...detail, ...generic };
};

export const createWidgetController = (params: {
  targets: RenderTargets;
  widgetDocument: Document;
  widgetWindow: WidgetWindow;
}): WidgetController => {
  const { targets, widgetDocument, widgetWindow } = params;
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let lastPayload: SmartTasksWidgetPayload | null = null;
  let view: ViewState = { kind: 'list' };
  let teardownInteraction: (() => void) | null = null;
  let consecutiveLoadFailures = 0;
  // Guards in-flight loads from rendering into a torn-down widget after destroy().
  let destroyed = false;
  const reporter = widgetErrorReporter('smart_tasks', () => homeyRef);
  // Until the first API response lands, show the loading state instead of the
  // blank empty state — the app can take many seconds to respond after a restart
  // (cold-start device enumeration / busy event loop), and a blank panel for that
  // whole window reads as "nothing here" rather than "loading".
  let everLoaded = false;
  let stopObserving: (() => void) | null = null;
  // The detail chart's size at its last draw, so a resize tick that did not
  // change it (or one from the hidden list view) skips the redraw.
  let chartSignature = '';
  const NO_SIZE = { width: 0, height: 0 };
  const measureChartSignature = (): string => {
    const { width, height } = measureBox(targets.detailChartEl, NO_SIZE);
    return `${width}x${height}`;
  };

  const render = (): void => {
    if (lastPayload === null && !everLoaded) {
      renderLoading(targets);
    } else {
      renderWidget(targets, lastPayload, view);
    }
    chartSignature = measureChartSignature();
  };

  // The detail chart is drawn at its measured size; redraw it when the tile
  // (and so the chart's share of the detail panel) changes size.
  const handleChartResize = (): void => {
    if (destroyed || view.kind !== 'detail') return;
    if (measureChartSignature() === chartSignature) return;
    render();
  };

  const handleLoadFailure = (error: unknown): void => {
    // A host-orphaned instance ("Widget Not Found") loops forever on retry; a
    // one-shot iframe reload re-establishes routing. Bail if it fired.
    if (reloadIfOrphaned(error, widgetWindow)) return;
    // Homey SDK reads fail transiently (per feedback_homey_sdk_unreliable).
    // Keep the last good payload + open detail panel across a brief blip and
    // only fall back to the error state after several consecutive misses, so
    // one flaky 60 s refresh doesn't tear down a detail panel the user is
    // reading or flash a misleading "Unable to load".
    consecutiveLoadFailures += 1;
    if (consecutiveLoadFailures < MAX_CONSECUTIVE_LOAD_FAILURES && lastPayload?.state === 'ready') {
      return;
    }
    // Surfaced the error state to the user — mirror it into the app log, since
    // the WebView console is unreachable on the mobile dashboard.
    reporter.report('error', 'Failed to load smart_tasks widget', error);
    everLoaded = true;
    lastPayload = { state: 'empty', subtitle: SMART_TASK_WIDGET_LOAD_ERROR_SUBTITLE, hint: null };
    view = { kind: 'list' };
    render();
  };

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';
      applyPreviewTheme(widgetDocument, searchParams);
      const payload: SmartTasksWidgetPayload = preview || !homeyRef
        ? PREVIEW_SMART_TASKS_PAYLOAD
        : await homeyRef.api('GET', '/smart_tasks') as SmartTasksWidgetPayload;
      if (destroyed || loadId !== loadSequence) return;
      consecutiveLoadFailures = 0;
      everLoaded = true;
      lastPayload = payload;
      view = rehydrateView(view, payload);
      render();
      reporter.flush();
    } catch (error) {
      if (destroyed || loadId !== loadSequence) return;
      handleLoadFailure(error);
    } finally {
      if (loadId === loadSequence && !initialRenderDone && homeyRef?.ready) {
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
    stopObserving ??= observeBox(widgetWindow, targets.detailChartEl, handleChartResize);
    teardownInteraction ??= wireInteraction(targets, {
      getView: () => view,
      setView: (next) => { view = next; },
      render,
    });
    // Paint the loading state synchronously so the slow first `homey.api()` round
    // trip shows "Loading…" rather than a blank panel.
    render();
    void loadAndRender();
    refresh.start();
    refresh.bindVisibility();
  };

  const destroy = (): void => {
    destroyed = true;
    refresh.stop();
    teardownInteraction?.();
    teardownInteraction = null;
    stopObserving?.();
    stopObserving = null;
  };

  return { bootstrap, destroy, loadAndRender };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => installSharedWidget<RenderTargets, WidgetHomey, WidgetWindow>({
  widgetWindow,
  widgetDocument,
  resolveTargets,
  createController: createWidgetController,
});
