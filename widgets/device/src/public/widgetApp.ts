import { DEVICE_WIDGET_COPY } from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  applyPreviewTheme,
  createRefreshLoop,
  reloadIfOrphaned,
  type WidgetController as SharedWidgetController,
} from '../../../_shared/widgetRuntime';
import { widgetErrorReporter, type WidgetErrorReporter } from '../../../_shared/widgetClientLog';
import {
  installHeightReportingWidget,
  type HeightReportingHomey,
  type HeightReportingWindow,
} from '../../../_shared/widgetHeight';
import { createSmartTaskCreateClient } from '../../../_shared/smartTaskCreate/flowClient';
import { createSmartTaskCreateFlow } from '../../../_shared/smartTaskCreate/flowController';
import { resolveFlowTargets } from '../../../_shared/smartTaskCreate/flowView';
import { resolveDeviceWidgetPreviewPayload } from './previewPayloads';
import { renderTileView, type RenderTargets, type TileState } from './render';
import type { DeviceWidgetPayload } from '../deviceWidgetTypes';

const C = DEVICE_WIDGET_COPY;
const REFRESH_INTERVAL_MS = 60 * 1000;

export type WidgetWindow = HeightReportingWindow;
export type WidgetHomey = HeightReportingHomey & {
  // The widget's own settings; `device` is the autocomplete choice.
  getSettings?: () => unknown;
};
export type WidgetController = SharedWidgetController<WidgetHomey>;

type ChosenDevice = { id: string; name: string };

// The Device setting holds the autocomplete item the user picked.
const readChosenDevice = (homey: WidgetHomey | null): ChosenDevice | null => {
  const settings = homey?.getSettings?.();
  if (typeof settings !== 'object' || settings === null) return null;
  const device = (settings as { device?: unknown }).device;
  if (typeof device !== 'object' || device === null) return null;
  const { id, name } = device as { id?: unknown; name?: unknown };
  return typeof id === 'string' && id.length > 0 && typeof name === 'string' ? { id, name } : null;
};

const TILE_ELEMENTS = {
  tileView: '[data-tile-view]',
  tileName: '[data-tile-name]',
  tileChip: '[data-tile-chip]',
  tileHero: '[data-tile-hero]',
  tileFigure: '[data-tile-figure]',
  tileFigureContext: '[data-tile-figure-context]',
  tilePower: '[data-tile-power]',
  tileReason: '[data-tile-reason]',
  tileFact: '[data-tile-fact]',
  tileTask: '[data-tile-task]',
  tileTaskGoal: '[data-tile-task-goal]',
  tileTaskChip: '[data-tile-task-chip]',
  tileTaskDeadline: '[data-tile-task-deadline]',
  tileTaskWhy: '[data-tile-task-why]',
  tileTaskNext: '[data-tile-task-next]',
  tileFoot: '[data-tile-foot]',
  tileMessage: '[data-tile-message]',
  tileAddTaskLabel: '[data-tile-add-task-label]',
} as const;

const resolveTargets = (d: Document): RenderTargets | null => {
  const flow = resolveFlowTargets(d);
  const root = d.getElementById('widget-root');
  const tileAddTaskBtn = d.querySelector('[data-tile-add-task]');
  const elements = Object.fromEntries(
    Object.entries(TILE_ELEMENTS).map(([key, selector]) => [key, d.querySelector(selector)]),
  );
  if (
    flow === null
    || !(root instanceof HTMLElement)
    || !(tileAddTaskBtn instanceof HTMLButtonElement)
    || Object.values(elements).some((el) => !(el instanceof HTMLElement))
  ) {
    return null;
  }
  return { ...flow, root, tileAddTaskBtn, ...(elements as Record<keyof typeof TILE_ELEMENTS, HTMLElement>) };
};

const fetchDevice = async (
  homeyRef: WidgetHomey | null,
  deviceId: string,
  reporter: WidgetErrorReporter,
  widgetWindow: Window,
): Promise<TileState | null> => {
  if (!homeyRef) return { kind: 'loading' };
  try {
    const payload = await homeyRef.api('POST', '/device', { deviceId }) as DeviceWidgetPayload;
    reporter.flush();
    return { kind: 'payload', payload };
  } catch (error) {
    // A host-orphaned instance reloads itself once; the page is going away.
    if (reloadIfOrphaned(error, widgetWindow)) return null;
    reporter.report('error', 'Failed to load device widget', error);
    return { kind: 'message', text: C.loadError };
  }
};

// `onReady` is called once, right after `Homey.ready()`.
export const createWidgetController = (
  targets: RenderTargets,
  widgetDocument: Document,
  widgetWindow: WidgetWindow,
  onReady: () => void,
): WidgetController => {
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let tile: TileState = { kind: 'loading' };
  let chosen: ChosenDevice | null = null;
  let usePreviewData = false;
  let destroyed = false;
  const reporter = widgetErrorReporter('device', () => homeyRef);

  const { root } = targets;
  const render = (): void => {
    root.dataset.view = flow.currentStep() ?? 'tile';
    renderTileView(targets, tile, chosen?.name ?? null, !flow.isOpen());
  };

  const flow = createSmartTaskCreateFlow(
    targets,
    widgetWindow,
    createSmartTaskCreateClient(() => homeyRef, () => usePreviewData, reporter),
    {
      onRender: () => render(),
      // A created task is the tile's to show; read the device again.
      reloadAfterCreate: () => loadAndRender(),
    },
  );

  const resolveTile = async (searchParams: URLSearchParams): Promise<TileState | null> => {
    if (usePreviewData) {
      return { kind: 'payload', payload: resolveDeviceWidgetPreviewPayload(searchParams.get('state')) };
    }
    chosen = readChosenDevice(homeyRef);
    if (homeyRef && chosen === null) return { kind: 'message', text: C.chooseDevice };
    return chosen === null ? { kind: 'loading' } : fetchDevice(homeyRef, chosen.id, reporter, widgetWindow);
  };

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    const searchParams = new URLSearchParams(widgetWindow.location.search);
    usePreviewData = searchParams.get('preview') === '1';
    applyPreviewTheme(widgetDocument, searchParams);
    const next = await resolveTile(searchParams);
    // Drop a torn-down, superseded or reloading read before touching the DOM.
    if (destroyed || loadId !== loadSequence || next === null) return;
    tile = next;
    render();
    if (!initialRenderDone && homeyRef?.ready) {
      homeyRef.ready();
      initialRenderDone = true;
      onReady();
    }
  };

  const refresh = createRefreshLoop({
    widgetWindow,
    widgetDocument,
    intervalMs: REFRESH_INTERVAL_MS,
    // A background read never disturbs a task being composed.
    onTick: () => {
      if (!flow.isOpen()) void loadAndRender();
    },
  });

  const handleClick = (event: Event): void => {
    if (flow.isOpen()) {
      flow.handleClick(event);
      return;
    }
    if (!(event.target instanceof Element) || !event.target.closest('[data-tile-add-task]')) return;
    if (tile.kind === 'payload' && tile.payload.state === 'ready' && tile.payload.createDevice) {
      flow.open(tile.payload.createDevice);
    }
  };

  const handleInput = (event: Event): void => flow.handleInput(event);

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
    flow.destroy();
    root.removeEventListener('click', handleClick);
    root.removeEventListener('input', handleInput);
  };

  root.addEventListener('click', handleClick);
  root.addEventListener('input', handleInput);
  return { bootstrap, destroy, loadAndRender };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => installHeightReportingWidget<RenderTargets, WidgetHomey>(
  widgetWindow, widgetDocument, resolveTargets, createWidgetController,
);
