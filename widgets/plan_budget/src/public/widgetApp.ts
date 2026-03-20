import { renderEmptyState, renderWidget } from './chart';
import { resolvePreviewPayload } from './previewPayloads';
import type { PlanPriceWidgetPayload, WidgetTarget } from '../planPriceWidgetTypes';

const LOAD_ERROR_SUBTITLE = 'Unable to load widget';
const REFRESH_INTERVAL_MS = 60 * 1000;
const WIDGET_TITLE = 'Budget and Price';

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

export type WidgetController = {
  bootstrap: (homey: WidgetHomey | null) => void;
  destroy: () => void;
  loadAndRender: () => Promise<void>;
};

type WidgetControllerDeps = {
  chartEl: SVGSVGElement;
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

export const maybeApplyPreviewTheme = (
  widgetDocument: Document,
  searchParams: URLSearchParams,
): void => {
  const theme = searchParams.get('theme');
  if (theme === 'dark') {
    widgetDocument.body.classList.add('homey-dark-mode');
  } else if (theme === 'light') {
    widgetDocument.body.classList.remove('homey-dark-mode');
  }
};

export const createWidgetController = (
  { chartEl, widgetDocument, widgetWindow }: WidgetControllerDeps,
): WidgetController => {
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

      const target = resolveTarget(getWidgetSettings(homeyRef), searchParams);
      const payload = preview || !homeyRef
        ? resolvePreviewPayload(target)
        : await homeyRef.api('GET', `/chart?day=${encodeURIComponent(target)}`);

      if (loadId !== loadSequence) return;
      renderWidget(chartEl, payload);
    } catch (error) {
      if (loadId !== loadSequence) return;
      console.error('Failed to load widget chart', error);
      renderEmptyState(chartEl, {
        title: WIDGET_TITLE,
        subtitle: LOAD_ERROR_SUBTITLE,
      });
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

  return {
    bootstrap,
    destroy,
    loadAndRender,
  };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
) => {
  const chartEl = widgetDocument.getElementById('chart');
  if (!(chartEl instanceof SVGSVGElement)) {
    return null;
  }

  const controller = createWidgetController({
    chartEl,
    widgetDocument,
    widgetWindow,
  });
  const installWindow = widgetWindow;

  installWindow.onHomeyReady = (homey: WidgetHomey) => {
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
