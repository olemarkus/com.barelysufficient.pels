import { PRICE_WIDGET_EMPTY, PRICE_WIDGET_TITLE } from '../../../../packages/shared-domain/src/priceWidgetCopy';
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
import { resolvePriceWidgetPreviewPayload } from './previewPayloads';
import { renderWidget, type RenderTargets } from './render';
import type { PriceWidgetPayload, PriceWidgetShow } from '../priceWidgetTypes';

// Prices change per period (15 min at the finest), and the "now" marker moves
// with the clock, so a minute keeps the widget current without busy polling.
const REFRESH_INTERVAL_MS = 60 * 1000;

export type WidgetWindow = WidgetWindowBase & { ResizeObserver?: typeof ResizeObserver };

export type WidgetHomey = WidgetHomeyBase & {
  getSettings?: () => unknown;
  setHeight?: (height: number) => void;
};

export type WidgetController = SharedWidgetController<WidgetHomey>;

const resolveShow = (homey: WidgetHomey | null, searchParams: URLSearchParams): PriceWidgetShow => {
  const settings = homey?.getSettings?.();
  const raw = searchParams.get('show')
    ?? (settings && typeof settings === 'object' ? (settings as { show?: unknown }).show : undefined);
  return raw === 'export' || raw === 'both' ? raw : 'import';
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * The Homey API bridge hands back `unknown`. Check the payload's shape before
 * rendering, so a mismatched app version or a broken response reaches the
 * load-error path (and the client log) instead of a half-drawn widget.
 */
const isPriceWidgetPayload = (value: unknown): value is PriceWidgetPayload => {
  if (!isRecord(value)) return false;
  if (value.state === 'empty') return typeof value.title === 'string' && typeof value.subtitle === 'string';
  if (value.state !== 'ready' || !isRecord(value.chart)) return false;
  const { chart } = value;
  return typeof value.priceText === 'string'
    && typeof value.subline === 'string'
    && Array.isArray(value.legend)
    && Array.isArray(chart.importSteps)
    && Array.isArray(chart.exportSteps)
    && Array.isArray(chart.shades)
    && Array.isArray(chart.yTicks)
    && Array.isArray(chart.timeTicks)
    && Array.isArray(chart.dayDividers)
    && typeof chart.nowPrice === 'number';
};

const resolveTargets = (widgetDocument: Document): RenderTargets | null => {
  const root = widgetDocument.getElementById('widget-root');
  const priceEl = widgetDocument.querySelector('[data-price]');
  const levelEl = widgetDocument.querySelector('[data-level]');
  const sublineEl = widgetDocument.querySelector('[data-subline]');
  const chartEl = widgetDocument.querySelector('[data-chart]');
  const legendEl = widgetDocument.querySelector('[data-legend]');
  const captionEl = widgetDocument.querySelector('[data-caption]');
  if (
    !(root instanceof HTMLElement)
    || !(priceEl instanceof HTMLElement)
    || !(levelEl instanceof HTMLElement)
    || !(sublineEl instanceof HTMLElement)
    || !(chartEl instanceof HTMLElement)
    || !(legendEl instanceof HTMLElement)
    || !(captionEl instanceof HTMLElement)
  ) {
    return null;
  }
  return { root, priceEl, levelEl, sublineEl, chartEl, legendEl, captionEl };
};

// Sizes the iframe to the content: the subline and caption wrap on a narrow
// dashboard, so a fixed height would either clip them or leave a gap. Homey
// pads <body> around #widget-root, so that padding is added to the root height.
const createHeightReporter = (
  root: HTMLElement,
  widgetWindow: WidgetWindow,
  getHomey: () => WidgetHomey | null,
): { observe: () => void; disconnect: () => void; report: () => void } => {
  let observer: ResizeObserver | null = null;
  let lastReportedHeight = 0;
  const report = (): void => {
    const homey = getHomey();
    if (!homey?.setHeight) return;
    const bodyStyle = widgetWindow.getComputedStyle(root.ownerDocument.body);
    const bodyPadding = (Number.parseFloat(bodyStyle.paddingTop) || 0)
      + (Number.parseFloat(bodyStyle.paddingBottom) || 0);
    const height = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height) + bodyPadding);
    if (height <= 0 || height === lastReportedHeight) return;
    lastReportedHeight = height;
    homey.setHeight(height);
  };
  return {
    report,
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

export const createWidgetController = (
  targets: RenderTargets,
  widgetDocument: Document,
  widgetWindow: WidgetWindow,
  reportHeight: () => void,
): WidgetController => {
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let destroyed = false;
  const reporter = widgetErrorReporter('price', () => homeyRef);

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';
      applyPreviewTheme(widgetDocument, searchParams);
      const show = resolveShow(homeyRef, searchParams);
      const response: unknown = preview || !homeyRef
        ? resolvePriceWidgetPreviewPayload(searchParams.get('state'), show)
        : await homeyRef.api('GET', `/timeline?show=${encodeURIComponent(show)}`);
      if (destroyed || loadId !== loadSequence) return;
      if (!isPriceWidgetPayload(response)) throw new Error('Unexpected price widget payload');
      const payload = response;
      renderWidget(targets, payload);
      reportHeight();
      reporter.flush();
    } catch (error) {
      if (destroyed || loadId !== loadSequence) return;
      if (reloadIfOrphaned(error, widgetWindow)) return;
      reporter.report('error', 'Failed to load price widget', error);
      renderWidget(targets, { state: 'empty', title: PRICE_WIDGET_TITLE, subtitle: PRICE_WIDGET_EMPTY.loadError });
      reportHeight();
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
    void loadAndRender();
    refresh.start();
    refresh.bindVisibility();
  };

  const destroy = (): void => {
    destroyed = true;
    refresh.stop();
  };

  return { bootstrap, destroy, loadAndRender };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => {
  let activeHomey: WidgetHomey | null = null;
  let heightReporter: ReturnType<typeof createHeightReporter> | null = null;
  return installSharedWidget<RenderTargets, WidgetHomey, WidgetWindow>({
    widgetWindow,
    widgetDocument,
    resolveTargets,
    createController: ({ targets, widgetDocument: doc, widgetWindow: win }) => {
      heightReporter = createHeightReporter(targets.root, win, () => activeHomey);
      return createWidgetController(targets, doc, win, () => heightReporter?.report());
    },
    onHomeyClient: (homey) => {
      activeHomey = homey;
      heightReporter?.observe();
    },
    wrapController: (controller) => ({
      ...controller,
      destroy: (): void => {
        controller.destroy();
        heightReporter?.disconnect();
        activeHomey = null;
      },
    }),
  });
};
