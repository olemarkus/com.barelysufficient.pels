import { OVERRIDE_COPY } from '../../../../packages/shared-domain/src/settings/deviceOverrideDraft';
import { DEVICE_WIDGET_COPY } from '../../../../packages/shared-domain/src/smartTaskCopy/widgetCopy';
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
import { createOverrideEditor, resolveOverrideEditorTargets, type OverrideEditorTargets } from './overrideEditor';
import type { DeviceOverride } from '../../../../packages/shared-domain/src/settings/deviceOverrides';
import type {
  DeviceWidgetOverrideCommand, DeviceWidgetOverrideResponse, DeviceWidgetPayload,
} from '../deviceWidgetTypes';

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

type WidgetTargets = RenderTargets & { override: OverrideEditorTargets };

const resolveTargets = (d: Document): WidgetTargets | null => {
  const flow = resolveFlowTargets(d);
  const detail = resolveDetailTargets(d);
  const override = resolveOverrideEditorTargets(d);
  const root = d.getElementById('widget-root');
  const elements = Object.fromEntries(
    Object.entries(TILE_ELEMENTS).map(([key, selector]) => [key, d.querySelector(selector)]),
  );
  if (
    flow === null
    || detail === null
    || override === null
    || !(root instanceof HTMLElement)
    || Object.values(elements).some((el) => !(el instanceof HTMLElement))
  ) {
    return null;
  }
  return { ...flow, ...detail, override, root, ...(elements as Record<keyof typeof TILE_ELEMENTS, HTMLElement>) };
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

const loadTile = (
  searchParams: URLSearchParams,
  homey: WidgetHomey | null,
  chosen: ChosenDevice | null,
  reporter: WidgetErrorReporter,
  widgetWindow: Window,
): TileState | null | Promise<TileState | null> => {
  if (searchParams.get('preview') === '1') {
    return { kind: 'payload', payload: resolveDeviceWidgetPreviewPayload(searchParams.get('state')) };
  }
  if (chosen !== null) return fetchDevice(homey, chosen.id, reporter, widgetWindow);
  return homey ? { kind: 'message', text: C.chooseDevice } : { kind: 'loading' };
};

const readTileOverride = (tile: TileState) => {
  if (tile.kind !== 'payload' || tile.payload.state !== 'ready' || !tile.payload.override) return null;
  return { deviceId: tile.payload.device.id, override: tile.payload.override };
};

const withActiveOverride = (tile: TileState, deviceId: string, active: DeviceOverride | null): TileState => {
  if (tile.kind !== 'payload' || tile.payload.state !== 'ready'
    || tile.payload.device.id !== deviceId || !tile.payload.override) return tile;
  return { kind: 'payload', payload: { ...tile.payload, override: { ...tile.payload.override, active } } };
};

const changeOverride = async (
  homey: WidgetHomey | null,
  command: DeviceWidgetOverrideCommand,
  reporter: WidgetErrorReporter,
  widgetWindow: Window,
): Promise<DeviceWidgetOverrideResponse> => {
  if (!homey) return { ok: false, error: OVERRIDE_COPY.saveFailed };
  try {
    return await homey.api('POST', '/override', command) as DeviceWidgetOverrideResponse;
  } catch (error) {
    if (!reloadIfOrphaned(error, widgetWindow)) reporter.report('error', 'Could not save the override', error);
    return { ok: false, error: OVERRIDE_COPY.saveFailed };
  }
};

const resolveDeviceView = (flowOpen: boolean, overrideOpen: boolean, detailOpen: boolean): DeviceView => {
  if (flowOpen) return 'flow';
  if (overrideOpen) return 'override';
  return detailOpen ? 'detail' : 'tile';
};

// The tile is a role="button" element, so Enter and Space activate it.
const isActivationKey = (event: KeyboardEvent): boolean => event.key === 'Enter' || event.key === ' ';

// `onReady` is called once, right after `Homey.ready()`.
export const createWidgetController = (
  targets: WidgetTargets,
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
  const render = (): void => {
    // A refresh that closes the panel under the focused Back button hands focus
    // to the tile, not to the page.
    const backHadFocus = widgetDocument.activeElement === targets.detailBackBtn;
    if (detailOpen && resolveTileAction(tile)?.kind !== 'open_task') detailOpen = false;
    const view = resolveDeviceView(flow.isOpen(), override.isOpen(), detailOpen);
    root.dataset.view = view === 'flow' ? flow.currentStep() ?? 'tile' : view;
    renderDeviceView(targets, tile, chosen?.name ?? null, view);
    override.render(readTileOverride(tile), root.dataset.view);
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

  const override = createOverrideEditor(targets.override, {
    readCurrent: () => readTileOverride(tile),
    change: (command) => changeOverride(homeyRef, command, reporter, widgetWindow),
    update(command, reply) {
      if (reply.ok) {
        ++loadSequence;
        tile = withActiveOverride(tile, command.deviceId, reply.active);
      } else if (reply.refresh) void loadAndRender();
    },
    onViewChange: render,
    focusTile: () => targets.tileView.focus(),
  });

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    const searchParams = new URLSearchParams(widgetWindow.location.search);
    usePreviewData = searchParams.get('preview') === '1';
    applyPreviewTheme(widgetDocument, searchParams);
    if (!usePreviewData) chosen = readChosenDevice(homeyRef);
    const next = await loadTile(searchParams, homeyRef, chosen, reporter, widgetWindow);
    // Drop a torn-down, superseded or reloading read before touching the DOM.
    if (destroyed || loadId !== loadSequence || next === null || override.isOpen()) return;
    tile = next;
    render();
    if (!initialRenderDone && homeyRef?.ready) {
      homeyRef.ready();
      initialRenderDone = true;
      onReady();
    }
  };

  const refresh = createRefreshLoop({
    widgetWindow, widgetDocument, intervalMs: REFRESH_INTERVAL_MS,
    // A background read never disturbs a task being composed; an open detail
    // panel refreshes with it.
    onTick: () => {
      if (!flow.isOpen() && !override.isOpen()) void loadAndRender();
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
    override.destroy();
    root.removeEventListener('click', handleClick);
    root.removeEventListener('input', flow.handleInput);
    root.removeEventListener('keydown', handleKeydown);
  };

  root.addEventListener('click', handleClick);
  root.addEventListener('input', flow.handleInput);
  root.addEventListener('keydown', handleKeydown);
  return { bootstrap, destroy, loadAndRender };
};

export const installWidget = (
  widgetWindow: WidgetWindow,
  widgetDocument: Document,
): WidgetController | null => installHeightReportingWidget<WidgetTargets, WidgetHomey>(
  widgetWindow, widgetDocument, resolveTargets, createWidgetController,
);
