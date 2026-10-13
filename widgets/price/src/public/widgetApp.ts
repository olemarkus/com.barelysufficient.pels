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
import { observeBox } from '../../../_shared/widgetChartSize';
import { renderChart, renderWidget, type RenderTargets } from './render';
import type { PriceWidgetPayload, PriceWidgetShow } from '../priceWidgetTypes';

// Prices change per period (15 min at the finest), and the "now" marker moves
// with the clock, so a minute keeps the widget current without busy polling.
const REFRESH_INTERVAL_MS = 60 * 1000;

export type WidgetWindow = WidgetWindowBase & { ResizeObserver?: typeof ResizeObserver };

export type WidgetHomey = WidgetHomeyBase & {
  getSettings?: () => unknown;
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
  const chartSvg = widgetDocument.querySelector('[data-chart-svg]');
  const elements = {
    summaryEl: widgetDocument.querySelector('[data-summary]'),
    priceEl: widgetDocument.querySelector('[data-price]'),
    levelEl: widgetDocument.querySelector('[data-level]'),
    sublineEl: widgetDocument.querySelector('[data-subline]'),
    captionEl: widgetDocument.querySelector('[data-caption]'),
    legendEl: widgetDocument.querySelector('[data-legend]'),
    emptyEl: widgetDocument.querySelector('[data-empty]'),
    emptyTitleEl: widgetDocument.querySelector('[data-empty-title]'),
    emptySubtitleEl: widgetDocument.querySelector('[data-empty-subtitle]'),
  };
  if (!(root instanceof HTMLElement) || !(chartSvg instanceof SVGSVGElement)) return null;
  if (!Object.values(elements).every((el) => el instanceof HTMLElement)) return null;
  return { root, chartSvg, ...(elements as Record<keyof typeof elements, HTMLElement>) };
};

// The widget sits at its manifest height and fills the frame (see
// widgets/_shared/widget-frame.css); it never calls `Homey.setHeight`. The
// chart is drawn at its measured size, so it is redrawn when that size changes.
export const createWidgetController = (
  targets: RenderTargets,
  widgetDocument: Document,
  widgetWindow: WidgetWindow,
): WidgetController => {
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let destroyed = false;
  let lastPayload: PriceWidgetPayload | null = null;
  let stopObserving: (() => void) | null = null;
  const reporter = widgetErrorReporter('price', () => homeyRef);

  const present = (payload: PriceWidgetPayload): void => {
    lastPayload = payload;
    renderWidget(targets, payload);
  };

  // Redraw only the chart on a resize; the header keeps its text.
  const handleResize = (): void => {
    if (destroyed || lastPayload?.state !== 'ready') return;
    renderChart(targets.chartSvg, lastPayload);
  };

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
      present(response);
      reporter.flush();
    } catch (error) {
      if (destroyed || loadId !== loadSequence) return;
      if (reloadIfOrphaned(error, widgetWindow)) return;
      reporter.report('error', 'Failed to load price widget', error);
      present({ state: 'empty', title: PRICE_WIDGET_TITLE, subtitle: PRICE_WIDGET_EMPTY.loadError });
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
    stopObserving ??= observeBox(widgetWindow, targets.chartSvg, handleResize);
    void loadAndRender();
    refresh.start();
    refresh.bindVisibility();
  };

  const destroy = (): void => {
    destroyed = true;
    refresh.stop();
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
  createController: ({ targets, widgetDocument: doc, widgetWindow: win }) => (
    createWidgetController(targets, doc, win)
  ),
});
