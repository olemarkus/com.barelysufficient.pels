import { SMART_TASK_WIDGET_LOAD_ERROR_SUBTITLE } from '../../../../packages/shared-domain/src/deadlineLabels';
import { PREVIEW_SMART_TASKS_PAYLOAD } from './previewPayloads';
import { renderLoading, renderWidget, type RenderTargets } from './render';
import type { SmartTasksWidgetPayload } from '../smartTasksWidgetTypes';

const REFRESH_INTERVAL_MS = 60 * 1000;
// Consecutive failed refreshes tolerated before the widget drops the last good
// render and shows the error state — ~3 × 60 s grace for transient SDK blips.
const MAX_CONSECUTIVE_LOAD_FAILURES = 3;

export type WidgetWindow = Window & {
  Homey?: unknown;
  onHomeyReady?: (homey: WidgetHomey) => void;
  // Declared so the typed lint resolves the constructor when the height
  // reporter reads the global `ResizeObserver` off the widget window.
  ResizeObserver?: typeof globalThis.ResizeObserver;
};

export type WidgetHomey = {
  api: (method: string, path: string) => Promise<unknown>;
  ready?: () => void;
  // Resize the widget iframe to fit content. The list (active rows + a
  // "Recently ended" section) and the detail (chart + legend) both vary in
  // height and exceed any single fixed compose height — Homey widgets don't
  // scroll internally, so we measure and report the content height instead of
  // clipping. Mirrors the create_smart_task widget.
  setHeight?: (height: number) => void;
};

// Keep the widget iframe sized to its content. A ResizeObserver (not a
// synchronous measure in render) is what makes this reliable: first paint,
// web-font load, async payload arrival, and list↔detail swaps all change the
// height after a render returns. `getHomey` is read lazily so a reporter
// created before bootstrap still sees the assigned client.
const createHeightReporter = (
  root: HTMLElement,
  widgetWindow: WidgetWindow,
  getHomey: () => WidgetHomey | null,
): { observe: () => void; disconnect: () => void } => {
  let observer: ResizeObserver | null = null;
  let lastReportedHeight = 0;
  const report = (): void => {
    const homey = getHomey();
    if (!homey?.setHeight) return;
    // Homey pads <body> around #widget-root; the root's box excludes that, so
    // add the body's vertical padding or the iframe lands a few px short and
    // clips the bottom row.
    const bodyStyle = widgetWindow.getComputedStyle(root.ownerDocument.body);
    const bodyPadding = (Number.parseFloat(bodyStyle.paddingTop) || 0)
      + (Number.parseFloat(bodyStyle.paddingBottom) || 0);
    const height = Math.ceil(root.getBoundingClientRect().height + bodyPadding);
    if (height <= 0 || height === lastReportedHeight) return;
    lastReportedHeight = height;
    homey.setHeight(height);
  };
  return {
    observe: (): void => {
      if (observer || typeof widgetWindow.ResizeObserver !== 'function') return;
      observer = new widgetWindow.ResizeObserver(() => report());
      observer.observe(root);
    },
    disconnect: (): void => {
      observer?.disconnect();
      observer = null;
    },
  };
};

export type WidgetController = {
  bootstrap: (homey: WidgetHomey | null) => void;
  destroy: () => void;
  loadAndRender: () => Promise<void>;
};

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

const maybeApplyPreviewTheme = (widgetDocument: Document, searchParams: URLSearchParams): void => {
  const theme = searchParams.get('theme');
  if (theme === 'dark') {
    widgetDocument.body.classList.add('homey-dark-mode');
  } else if (theme === 'light') {
    widgetDocument.body.classList.remove('homey-dark-mode');
  }
};

// The detail panel's plain HTMLElement slots, keyed by the RenderTargets field
// name. `root` (id lookup), `rowTemplate` (HTMLTemplateElement) and
// `detailBackBtn` (HTMLButtonElement) are resolved separately because they need
// a narrower instanceof check than the generic slots below.
const GENERIC_TARGET_SELECTORS = {
  listView: '[data-list-view]',
  detailView: '[data-detail-view]',
  rowsList: '[data-rows]',
  emptyEl: '[data-empty]',
  emptyHintEl: '[data-empty-hint]',
  overflowEl: '[data-overflow]',
  endedSectionEl: '[data-ended-section]',
  endedHeadingEl: '[data-ended-heading]',
  endedRowsList: '[data-ended-rows]',
  detailHeaderEl: '[data-detail-name]',
  detailChipEl: '[data-detail-chip]',
  detailDeadlineEl: '[data-detail-deadline]',
  detailChartEl: '[data-detail-chart]',
  detailTargetEl: '[data-detail-target]',
  detailWhyEl: '[data-detail-why]',
  detailRecourseEl: '[data-detail-recourse]',
  detailMetaEl: '[data-detail-meta]',
  detailConfidenceEl: '[data-detail-confidence]',
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
  const detailBackBtn = widgetDocument.querySelector('[data-detail-back]');
  const generic = resolveGenericTargets(widgetDocument);
  if (
    !(root instanceof HTMLElement)
    || !(rowTemplate instanceof HTMLTemplateElement)
    || !(endedRowTemplate instanceof HTMLTemplateElement)
    || !(detailBackBtn instanceof HTMLButtonElement)
    || generic === null
  ) {
    return null;
  }
  return { root, rowTemplate, endedRowTemplate, detailBackBtn, ...generic };
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
  let refreshTimer: number | null = null;
  let visibilityListenerBound = false;
  let lastPayload: SmartTasksWidgetPayload | null = null;
  let view: ViewState = { kind: 'list' };
  let teardownInteraction: (() => void) | null = null;
  let consecutiveLoadFailures = 0;
  // Guards in-flight loads from rendering into a torn-down widget after destroy().
  let destroyed = false;
  // Until the first API response lands, show the loading state instead of the
  // blank empty state — the app can take many seconds to respond after a restart
  // (cold-start device enumeration / busy event loop), and a blank panel for that
  // whole window reads as "nothing here" rather than "loading".
  let everLoaded = false;

  const render = (): void => {
    if (lastPayload === null && !everLoaded) {
      renderLoading(targets);
      return;
    }
    renderWidget(targets, lastPayload, view);
  };

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';
      maybeApplyPreviewTheme(widgetDocument, searchParams);
      const payload: SmartTasksWidgetPayload = preview || !homeyRef
        ? PREVIEW_SMART_TASKS_PAYLOAD
        : await homeyRef.api('GET', '/smart_tasks') as SmartTasksWidgetPayload;
      if (destroyed || loadId !== loadSequence) return;
      consecutiveLoadFailures = 0;
      everLoaded = true;
      lastPayload = payload;
      view = rehydrateView(view, payload);
      render();
    } catch (error) {
      if (destroyed || loadId !== loadSequence) return;
      console.error('Failed to load smart_tasks widget', error);
      // Homey SDK reads fail transiently (per feedback_homey_sdk_unreliable).
      // Keep the last good payload + open detail panel across a brief blip and
      // only fall back to the error state after several consecutive misses, so
      // one flaky 60 s refresh doesn't tear down a detail panel the user is
      // reading or flash a misleading "Unable to load".
      consecutiveLoadFailures += 1;
      if (consecutiveLoadFailures < MAX_CONSECUTIVE_LOAD_FAILURES && lastPayload?.state === 'ready') {
        return;
      }
      everLoaded = true;
      lastPayload = { state: 'empty', subtitle: SMART_TASK_WIDGET_LOAD_ERROR_SUBTITLE, hint: null };
      view = { kind: 'list' };
      render();
    } finally {
      if (loadId === loadSequence && !initialRenderDone && homeyRef?.ready) {
        homeyRef.ready();
        initialRenderDone = true;
      }
    }
  };

  const handleVisibilityChange = (): void => {
    if (widgetDocument.visibilityState === 'visible') {
      void loadAndRender();
    }
  };

  const startRefreshLoop = (): void => {
    if (refreshTimer !== null) {
      widgetWindow.clearInterval(refreshTimer);
    }
    refreshTimer = widgetWindow.setInterval(() => {
      void loadAndRender();
    }, REFRESH_INTERVAL_MS);
  };

  const bindVisibilityReload = (): void => {
    if (visibilityListenerBound) return;
    widgetDocument.addEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerBound = true;
  };

  const bootstrap = (homey: WidgetHomey | null): void => {
    if (homey && homey === homeyRef) return;
    homeyRef = homey;
    teardownInteraction ??= wireInteraction(targets, {
      getView: () => view,
      setView: (next) => { view = next; },
      render,
    });
    // Paint the loading state synchronously so the slow first `homey.api()` round
    // trip shows "Loading…" rather than a blank panel.
    render();
    void loadAndRender();
    startRefreshLoop();
    bindVisibilityReload();
  };

  const destroy = (): void => {
    destroyed = true;
    if (refreshTimer !== null) {
      widgetWindow.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    teardownInteraction?.();
    teardownInteraction = null;
    if (!visibilityListenerBound) return;
    widgetDocument.removeEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerBound = false;
  };

  return { bootstrap, destroy, loadAndRender };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => {
  const targets = resolveTargets(widgetDocument);
  if (!targets) return null;

  const controller = createWidgetController({ targets, widgetDocument, widgetWindow });
  // Size the iframe to content (Homey.setHeight) once a real client is wired;
  // the no-Homey preview/harness path renders at natural page size.
  let activeHomey: WidgetHomey | null = null;
  const heightReporter = createHeightReporter(targets.root, widgetWindow, () => activeHomey);
  const installWindow = widgetWindow;
  installWindow.onHomeyReady = (homey: WidgetHomey): void => {
    activeHomey = homey;
    heightReporter.observe();
    controller.bootstrap(homey);
  };

  const bootstrapWithoutHomey = (): void => {
    if (!widgetWindow.Homey) {
      controller.bootstrap(null);
    }
  };
  if (widgetDocument.readyState === 'loading') {
    widgetDocument.addEventListener('DOMContentLoaded', bootstrapWithoutHomey, { once: true });
  } else {
    bootstrapWithoutHomey();
  }
  return {
    ...controller,
    destroy: (): void => {
      controller.destroy();
      heightReporter.disconnect();
      // Drop the client so a late ResizeObserver callback short-circuits in
      // getHomey() instead of calling setHeight on a torn-down widget.
      activeHomey = null;
    },
  };
};
