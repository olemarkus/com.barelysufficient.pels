import { PREVIEW_HEADROOM_PAYLOAD } from './previewPayloads';
import { renderWidget, type RenderTargets } from './render';
import type { HeadroomWidgetPayload } from '../headroomWidgetTypes';

const REFRESH_INTERVAL_MS = 10 * 1000;
const LOAD_ERROR_SUBTITLE = 'Unable to load';

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

const maybeApplyPreviewTheme = (widgetDocument: Document, searchParams: URLSearchParams): void => {
  const theme = searchParams.get('theme');
  if (theme === 'dark') {
    widgetDocument.body.classList.add('homey-dark-mode');
  } else if (theme === 'light') {
    widgetDocument.body.classList.remove('homey-dark-mode');
  }
};

const resolveTargets = (widgetDocument: Document): RenderTargets | null => {
  const root = widgetDocument.getElementById('widget-root');
  const currentEl = widgetDocument.querySelector('[data-current]');
  const budgetEl = widgetDocument.querySelector('[data-budget]');
  const chipEl = widgetDocument.querySelector('[data-price]');
  const barFillEl = widgetDocument.querySelector('[data-bar]');
  const metaEl = widgetDocument.querySelector('[data-meta]');
  if (
    !(root instanceof HTMLElement)
    || !(currentEl instanceof HTMLElement)
    || !(budgetEl instanceof HTMLElement)
    || !(chipEl instanceof HTMLElement)
    || !(barFillEl instanceof HTMLElement)
    || !(metaEl instanceof HTMLElement)
  ) {
    return null;
  }
  return { root, currentEl, budgetEl, chipEl, barFillEl, metaEl };
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

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';
      maybeApplyPreviewTheme(widgetDocument, searchParams);
      const payload: HeadroomWidgetPayload = preview || !homeyRef
        ? PREVIEW_HEADROOM_PAYLOAD
        : await homeyRef.api('GET', '/headroom') as HeadroomWidgetPayload;
      if (loadId !== loadSequence) return;
      renderWidget(targets, payload);
    } catch (error) {
      if (loadId !== loadSequence) return;
      console.error('Failed to load headroom widget', error);
      renderWidget(targets, { state: 'empty', subtitle: LOAD_ERROR_SUBTITLE });
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
    void loadAndRender();
    startRefreshLoop();
    bindVisibilityReload();
  };

  const destroy = (): void => {
    if (refreshTimer !== null) {
      widgetWindow.clearInterval(refreshTimer);
      refreshTimer = null;
    }
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
