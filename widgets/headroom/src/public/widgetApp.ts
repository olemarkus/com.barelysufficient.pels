import { HEADROOM_WIDGET_COPY } from '../../../../packages/shared-domain/src/headroomWidgetCopy';
import {
  applyPreviewTheme,
  createRefreshLoop,
  installWidget as installSharedWidget,
  type WidgetController as SharedWidgetController,
  type WidgetHomeyBase,
  type WidgetWindowBase,
} from '../../../_shared/widgetRuntime';
import { resolveHeadroomPreviewPayload } from './previewPayloads';
import { renderWidget, type RenderTargets } from './render';
import type { HeadroomWidgetPayload } from '../headroomWidgetTypes';

const REFRESH_INTERVAL_MS = 10 * 1000;
const LOAD_ERROR_SUBTITLE = HEADROOM_WIDGET_COPY.loadErrorSubtitle;

export type WidgetWindow = WidgetWindowBase;

export type WidgetHomey = WidgetHomeyBase;

export type WidgetController = SharedWidgetController<WidgetHomey>;

const resolveTargets = (widgetDocument: Document): RenderTargets | null => {
  const root = widgetDocument.getElementById('widget-root');
  const currentEl = widgetDocument.querySelector('[data-current]');
  const budgetEl = widgetDocument.querySelector('[data-budget]');
  const captionCurrentEl = widgetDocument.querySelector('[data-caption-current]');
  const captionBudgetEl = widgetDocument.querySelector('[data-caption-budget]');
  const chipEl = widgetDocument.querySelector('[data-price]');
  const barFillEl = widgetDocument.querySelector('[data-bar]');
  const stateLabelEl = widgetDocument.querySelector('[data-state-label]');
  const metaEl = widgetDocument.querySelector('[data-meta]');
  if (
    !(root instanceof HTMLElement)
    || !(currentEl instanceof HTMLElement)
    || !(budgetEl instanceof HTMLElement)
    || !(captionCurrentEl instanceof HTMLElement)
    || !(captionBudgetEl instanceof HTMLElement)
    || !(chipEl instanceof HTMLElement)
    || !(barFillEl instanceof HTMLElement)
    || !(stateLabelEl instanceof HTMLElement)
    || !(metaEl instanceof HTMLElement)
  ) {
    return null;
  }
  return {
    root, currentEl, budgetEl, captionCurrentEl, captionBudgetEl,
    chipEl, barFillEl, stateLabelEl, metaEl,
  };
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
  let destroyed = false;

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    try {
      const searchParams = new URLSearchParams(widgetWindow.location.search);
      const preview = searchParams.get('preview') === '1';
      applyPreviewTheme(widgetDocument, searchParams);
      const payload: HeadroomWidgetPayload = preview || !homeyRef
        ? resolveHeadroomPreviewPayload(searchParams.get('state'))
        : await homeyRef.api('GET', '/headroom') as HeadroomWidgetPayload;
      if (destroyed || loadId !== loadSequence) return;
      renderWidget(targets, payload);
    } catch (error) {
      if (destroyed || loadId !== loadSequence) return;
      console.error('Failed to load headroom widget', error);
      renderWidget(targets, { state: 'empty', subtitle: LOAD_ERROR_SUBTITLE });
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
): WidgetController | null => installSharedWidget<RenderTargets, WidgetHomey, WidgetWindow>({
  widgetWindow,
  widgetDocument,
  resolveTargets,
  createController: createWidgetController,
});
