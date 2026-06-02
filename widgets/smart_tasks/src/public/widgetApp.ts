import { PREVIEW_SMART_TASKS_PAYLOAD } from './previewPayloads';
import { renderWidget, type RenderTargets } from './render';
import type { SmartTasksWidgetPayload } from '../smartTasksWidgetTypes';

const REFRESH_INTERVAL_MS = 60 * 1000;
const LOAD_ERROR_SUBTITLE = 'Unable to load';
// Consecutive failed refreshes tolerated before the widget drops the last good
// render and shows the error state — ~3 × 60 s grace for transient SDK blips.
const MAX_CONSECUTIVE_LOAD_FAILURES = 3;

export type WidgetWindow = Window & {
  Homey?: unknown;
  onHomeyReady?: (homey: WidgetHomey) => void;
};

export type WidgetHomey = {
  api: (method: string, path: string) => Promise<unknown>;
  ready?: () => void;
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
  let interactionBound = false;
  let consecutiveLoadFailures = 0;

  const render = (): void => {
    renderWidget(targets, lastPayload, view);
  };

  const openDetail = (event: Event, section: DetailSection): void => {
    const dom = SECTION_DOM[section];
    const button = event.target instanceof Element ? event.target.closest(dom.buttonSelector) : null;
    if (!(button instanceof HTMLElement)) return;
    const key = button.dataset[dom.datasetKey];
    if (!key) return;
    view = { kind: 'detail', section, key };
    render();
    targets.detailBackBtn.focus();
  };

  const handleRowClick = (event: Event): void => openDetail(event, 'active');
  const handleEndedClick = (event: Event): void => openDetail(event, 'ended');

  const handleBackClick = (): void => {
    if (view.kind === 'list') return;
    const { section, key } = view;
    view = { kind: 'list' };
    render();
    focusRowButton(targets, section, key);
  };

  const bindInteraction = (): void => {
    if (interactionBound) return;
    targets.rowsList.addEventListener('click', handleRowClick);
    targets.endedRowsList.addEventListener('click', handleEndedClick);
    targets.detailBackBtn.addEventListener('click', handleBackClick);
    interactionBound = true;
  };

  const unbindInteraction = (): void => {
    if (!interactionBound) return;
    targets.rowsList.removeEventListener('click', handleRowClick);
    targets.endedRowsList.removeEventListener('click', handleEndedClick);
    targets.detailBackBtn.removeEventListener('click', handleBackClick);
    interactionBound = false;
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
      if (loadId !== loadSequence) return;
      consecutiveLoadFailures = 0;
      lastPayload = payload;
      view = rehydrateView(view, payload);
      render();
    } catch (error) {
      if (loadId !== loadSequence) return;
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
      lastPayload = { state: 'empty', subtitle: LOAD_ERROR_SUBTITLE, hint: null };
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
    bindInteraction();
    void loadAndRender();
    startRefreshLoop();
    bindVisibilityReload();
  };

  const destroy = (): void => {
    if (refreshTimer !== null) {
      widgetWindow.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    unbindInteraction();
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
  const installWindow = widgetWindow;
  installWindow.onHomeyReady = (homey: WidgetHomey): void => {
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
  return controller;
};
