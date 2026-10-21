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
import { resolveDetailTargets } from '../../../_shared/smartTaskDetail/detailRender';
import {
  renderDeviceView,
  resolveTileAction,
  type DeviceView,
  type RenderTargets,
  type TileState,
} from './render';
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
  tileTap: '[data-tile-tap]',
  tileChevron: '[data-tile-chevron]',
  tileActionText: '[data-tile-action-text]',
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
  tileMessage: '[data-tile-message]',
} as const;

const resolveTargets = (d: Document): RenderTargets | null => {
  const flow = resolveFlowTargets(d);
  const detail = resolveDetailTargets(d);
  const root = d.getElementById('widget-root');
  const elements = Object.fromEntries(
    Object.entries(TILE_ELEMENTS).map(([key, selector]) => [key, d.querySelector(selector)]),
  );
  if (
    flow === null
    || detail === null
    || !(root instanceof HTMLElement)
    || Object.values(elements).some((el) => !(el instanceof HTMLElement))
  ) {
    return null;
  }
  return { ...flow, ...detail, root, ...(elements as Record<keyof typeof TILE_ELEMENTS, HTMLElement>) };
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

// The tile is a role="button" element, so Enter and Space activate it.
const isActivationKey = (event: KeyboardEvent): boolean => event.key === 'Enter' || event.key === ' ';

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
  // The open task's detail panel is up (a tap on the tile opened it).
  let detailOpen = false;
  const reporter = widgetErrorReporter('device', () => homeyRef);

  const { root } = targets;
  // The detail panel stays up only while the task it shows is still open; a
  // read that finds it ended or gone drops back to the tile.
  const currentView = (): DeviceView => {
    if (flow.isOpen()) return 'flow';
    if (detailOpen && resolveTileAction(tile)?.kind !== 'open_task') detailOpen = false;
    return detailOpen ? 'detail' : 'tile';
  };

  const render = (): void => {
    // A refresh that closes the panel under the focused Back button hands focus
    // to the tile, not to the page.
    const backHadFocus = widgetDocument.activeElement === targets.detailBackBtn;
    const view = currentView();
    root.dataset.view = view === 'flow' ? flow.currentStep() ?? 'tile' : view;
    renderDeviceView(targets, tile, chosen?.name ?? null, view);
    if (backHadFocus && view === 'tile') targets.tileTap.focus();
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
    // A background read never disturbs a task being composed; an open detail
    // panel refreshes with it.
    onTick: () => {
      if (!flow.isOpen()) void loadAndRender();
    },
  });

  // A tap on the tile opens the open task's detail, or the creation flow for
  // this device when it has no open task.
  const activateTile = (): void => {
    const action = resolveTileAction(tile);
    if (action?.kind === 'open_task') {
      detailOpen = true;
      render();
      targets.detailBackBtn.focus();
      return;
    }
    if (action?.kind === 'start_task') flow.open(action.device);
  };

  const handleClick = (event: Event): void => {
    if (flow.isOpen()) {
      flow.handleClick(event);
      return;
    }
    if (!(event.target instanceof Element)) return;
    if (detailOpen) {
      if (!event.target.closest('[data-detail-back]')) return;
      detailOpen = false;
      render();
      return;
    }
    if (event.target.closest('[data-tile-tap]')) activateTile();
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (flow.isOpen() || detailOpen || event.target !== targets.tileTap || !isActivationKey(event)) return;
    event.preventDefault();
    activateTile();
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
    root.removeEventListener('keydown', handleKeydown);
  };

  root.addEventListener('click', handleClick);
  root.addEventListener('input', handleInput);
  root.addEventListener('keydown', handleKeydown);
  return { bootstrap, destroy, loadAndRender };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => installHeightReportingWidget<RenderTargets, WidgetHomey>(
  widgetWindow, widgetDocument, resolveTargets, createWidgetController,
);
