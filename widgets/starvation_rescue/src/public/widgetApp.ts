import {
  STARVATION_RESCUE_WIDGET_COPY,
  resolveStarvationRescueRejectCopy,
} from '../../../../packages/shared-domain/src/planStarvation';
import {
  applyPreviewTheme,
  createRefreshLoop,
  installWidget as installSharedWidget,
  type WidgetController as SharedWidgetController,
  type WidgetHomeyBase,
  type WidgetWindowBase,
} from '../../../_shared/widgetRuntime';
import { PREVIEW_STARVATION_RESCUE_DEVICES } from './previewPayloads';
import { renderWidget, type RenderTargets, type ViewState } from './render';
import type {
  StarvationRescueCreateResponse,
  StarvationRescueDevice,
  StarvationRescueDevicesPayload,
  StarvationRescuePreviewResponse,
} from '../starvationRescueWidgetTypes';

const C = STARVATION_RESCUE_WIDGET_COPY;
const REFRESH_INTERVAL_MS = 10 * 1000;
const DONE_FLASH_MS = 1800;

export type WidgetWindow = WidgetWindowBase;

export type WidgetHomey = WidgetHomeyBase;

export type WidgetController = SharedWidgetController<WidgetHomey>;

const HOUR_MS = 60 * 60 * 1000;
const PREVIEW_NEXT_HOUR_MS = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
// Design-preview confirm response, confined to the `?preview=1` path.
const PREVIEW_RESPONSE: StarvationRescuePreviewResponse = {
  ok: true,
  deadlineAtMs: PREVIEW_NEXT_HOUR_MS + 3 * HOUR_MS,
  deadlineLabel: 'Today 17:00',
  scheduledWindowLabel: '14:00–16:00',
  estimate: {
    status: 'on_track',
    scheduledHours: [
      { startsAtMs: PREVIEW_NEXT_HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: PREVIEW_NEXT_HOUR_MS + HOUR_MS, plannedKWh: 1.5 },
    ],
    projectedFinishAtMs: PREVIEW_NEXT_HOUR_MS + 2 * HOUR_MS,
    energyEstimateKWh: 3,
    energyExpectedKWh: 2.7,
    costEstimate: 3.1,
    costUnit: 'kr',
  },
};

const resolveTargets = (d: Document): RenderTargets | null => {
  const root = d.getElementById('widget-root');
  const deviceTemplate = d.getElementById('device-template');
  const map = {
    listView: '[data-list-view]',
    listTitleEl: '[data-list-title]',
    listEl: '[data-device-list]',
    listMoreEl: '[data-list-more]',
    listEmptyEl: '[data-list-empty]',
    confirmView: '[data-confirm-view]',
    confirmTitle: '[data-confirm-title]',
    confirmConsequenceEl: '[data-confirm-consequence]',
    confirmCostEl: '[data-confirm-cost]',
    confirmAtCapEl: '[data-confirm-at-cap]',
    confirmChartEl: '[data-confirm-chart]',
    confirmWhenEl: '[data-confirm-when]',
    confirmEnergyEl: '[data-confirm-energy]',
    confirmUnavailableEl: '[data-confirm-unavailable]',
    confirmCaveatEl: '[data-confirm-caveat]',
    confirmPermsEl: '[data-confirm-perms]',
    confirmPermsTitleEl: '[data-confirm-perms-title]',
    confirmPermsListEl: '[data-confirm-perms-list]',
    confirmErrorEl: '[data-confirm-error]',
    doneView: '[data-done-view]',
    doneMsgEl: '[data-done-msg]',
  } as const;
  const buttons = {
    confirmBackBtn: '[data-confirm-back]',
    confirmBtn: '[data-confirm-btn]',
  } as const;

  const generic = Object.fromEntries(
    Object.entries(map).map(([k, sel]) => [k, d.querySelector(sel)]),
  );
  const btns = Object.fromEntries(
    Object.entries(buttons).map(([k, sel]) => [k, d.querySelector(sel)]),
  );

  if (
    !(root instanceof HTMLElement)
    || !(deviceTemplate instanceof HTMLTemplateElement)
    || Object.values(generic).some((el) => !(el instanceof HTMLElement))
    || Object.values(btns).some((el) => !(el instanceof HTMLButtonElement))
  ) {
    return null;
  }
  return {
    root,
    deviceTemplate,
    ...(generic as Record<string, HTMLElement>),
    ...(btns as Record<string, HTMLButtonElement>),
  } as RenderTargets;
};

type ClickAction =
  | { kind: 'rescue'; deviceId: string }
  | { kind: 'confirm' }
  | { kind: 'back' };

const closestDataValue = (target: Element, selector: string, key: string): string | null => {
  const el = target.closest(selector);
  return el instanceof HTMLElement ? el.dataset[key] ?? null : null;
};

export const resolveClickAction = (eventTarget: EventTarget | null): ClickAction | null => {
  if (!(eventTarget instanceof Element)) return null;
  const deviceId = closestDataValue(eventTarget, '[data-rescue-button]', 'deviceId');
  if (deviceId) return { kind: 'rescue', deviceId };
  if (eventTarget.closest('[data-confirm-btn]')) return { kind: 'confirm' };
  if (eventTarget.closest('[data-confirm-back]')) return { kind: 'back' };
  return null;
};

// ─── API calls (module-level so the controller closure stays small) ──────────
// Each helper swallows transport failures into the contract's `{ ok: false }` /
// empty shape so the controller never has to try/catch. On a real boot with no
// API client yet, the helpers must NOT pretend canned data is real: the list
// surfaces a transient "connecting" state and preview/create report
// `unavailable` (no false "rescued" flash without a real round-trip).

const fetchDevices = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
): Promise<StarvationRescueDevicesPayload> => {
  if (usePreviewData) return PREVIEW_STARVATION_RESCUE_DEVICES;
  if (!homeyRef) return { state: 'empty', subtitle: C.notReady };
  try {
    return await homeyRef.api('GET', '/devices') as StarvationRescueDevicesPayload;
  } catch (error) {
    console.error('Failed to load starvation_rescue widget', error);
    return { state: 'empty', subtitle: C.loadError };
  }
};

const fetchPreview = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
  deviceId: string,
): Promise<StarvationRescuePreviewResponse> => {
  if (usePreviewData) return PREVIEW_RESPONSE;
  if (!homeyRef) return { ok: false, reason: 'unavailable' };
  try {
    return await homeyRef.api('POST', '/preview', { deviceId }) as StarvationRescuePreviewResponse;
  } catch (error) {
    console.error('Failed to preview starvation rescue', error);
    return { ok: false, reason: 'unavailable' };
  }
};

const submitRescue = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
  deviceId: string,
  // Echo the deadline the PREVIEW resolved so the server persists exactly what
  // the user saw (not a fresh now+3h) — see StarvationRescueRequest.
  deadlineAtMs: number,
): Promise<StarvationRescueCreateResponse> => {
  // Design preview: the fixture schedules from the next hour on (all future), so
  // the honest flash is "queued".
  if (usePreviewData) return { ok: true, runsCurrentHour: false };
  if (!homeyRef) return { ok: false, reason: 'unavailable' };
  try {
    return await homeyRef.api('POST', '/rescue', { deviceId, deadlineAtMs }) as StarvationRescueCreateResponse;
  } catch (error) {
    console.error('Failed to create starvation rescue', error);
    return { ok: false, reason: 'unavailable' };
  }
};

const previewAllowsRescue = (response: StarvationRescuePreviewResponse | null): response is Extract<
  StarvationRescuePreviewResponse,
  { ok: true }
> => response?.ok === true
  && response.estimate.status !== 'unavailable'
  && response.estimate.status !== 'cannot_meet';

export const createWidgetController = (params: {
  targets: RenderTargets;
  widgetDocument: Document;
  widgetWindow: WidgetWindow;
}): WidgetController => {
  const { targets, widgetDocument, widgetWindow } = params;
  let homeyRef: WidgetHomey | null = null;
  let initialRenderDone = false;
  let loadSequence = 0;
  let devicesPayload: StarvationRescueDevicesPayload | null = null;
  let view: ViewState = { kind: 'list' };
  let listenersBound = false;
  let usePreviewData = false;
  let doneResetTimer: number | null = null;
  let destroyed = false;
  // Latest-request-wins token: a slow preview/create that resolves after the
  // user backed out must not clobber the current view.
  let requestSeq = 0;

  const render = (): void => {
    renderWidget(targets, devicesPayload, view);
  };

  const setView = (next: ViewState): void => {
    view = next;
    requestSeq += 1;
    render();
  };

  const findDevice = (deviceId: string): StarvationRescueDevice | null => {
    if (!devicesPayload || devicesPayload.state !== 'ready') return null;
    return devicesPayload.devices.find((entry) => entry.deviceId === deviceId) ?? null;
  };

  const openRescue = (deviceId: string): void => {
    const device = findDevice(deviceId);
    if (!device) return;
    setView({ kind: 'confirm', device, response: null, submitting: false, error: null });
    void runPreview(device);
  };

  const runPreview = async (device: StarvationRescueDevice): Promise<void> => {
    const token = ++requestSeq;
    const response = await fetchPreview(homeyRef, usePreviewData, device.deviceId);
    // Drop a preview that resolved after navigation (stale).
    if (token !== requestSeq || view.kind !== 'confirm') return;
    view = { ...view, response };
    render();
  };

  const runRescue = async (): Promise<void> => {
    if (view.kind !== 'confirm') return;
    const { device, response } = view;
    // Only commit once a successful preview resolved — its `deadlineAtMs` is the
    // exact deadline we echo back so the server persists what the user saw. The
    // confirm button is already disabled until then; this guards the contract.
    if (!previewAllowsRescue(response)) return;
    const deadlineAtMs = response.deadlineAtMs;
    view = { ...view, submitting: true, error: null };
    const token = ++requestSeq;
    render();
    const result = await submitRescue(homeyRef, usePreviewData, device.deviceId, deadlineAtMs);
    if (token !== requestSeq || view.kind !== 'confirm') return;
    // Success → the done flash (success label only after `ok:true`). Otherwise
    // stay on the confirm view with a retryable error line.
    view = result.ok
      ? { kind: 'done', ranNow: result.runsCurrentHour }
      : { ...view, submitting: false, error: resolveStarvationRescueRejectCopy(result.reason) };
    render();
    if (result.ok) scheduleDoneReset();
  };

  const scheduleDoneReset = (): void => {
    if (doneResetTimer !== null) widgetWindow.clearTimeout(doneResetTimer);
    doneResetTimer = widgetWindow.setTimeout(() => {
      if (destroyed) return;
      view = { kind: 'list' };
      void loadAndRender();
    }, DONE_FLASH_MS);
  };

  const handleClick = (event: Event): void => {
    const action = resolveClickAction(event.target);
    if (action === null) return;
    if (action.kind === 'rescue') { openRescue(action.deviceId); return; }
    if (action.kind === 'confirm') { void runRescue(); return; }
    setView({ kind: 'list' }); // 'back'
    void loadAndRender();
  };

  // Refresh ONLY the list view — neither the periodic poll nor a visibility
  // regain may disturb an in-progress confirm flow.
  const reloadListOnly = (): void => { if (view.kind === 'list') void loadAndRender(); };

  // List-only on both the periodic tick and the visibility regain (shared loop).
  const refresh = createRefreshLoop({
    widgetWindow,
    widgetDocument,
    intervalMs: REFRESH_INTERVAL_MS,
    onTick: reloadListOnly,
  });

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    const searchParams = new URLSearchParams(widgetWindow.location.search);
    usePreviewData = searchParams.get('preview') === '1';
    applyPreviewTheme(widgetDocument, searchParams);
    const payload = await fetchDevices(homeyRef, usePreviewData);
    if (destroyed) return;
    if (loadId === loadSequence) {
      devicesPayload = payload;
      // Only the list view depends on the device list; an in-progress confirm
      // keeps its captured device, so don't reset the user mid-flow.
      if (view.kind === 'list') render();
    }
    if (!initialRenderDone && homeyRef?.ready) {
      homeyRef.ready();
      initialRenderDone = true;
    }
  };

  const bootstrap = (homey: WidgetHomey | null): void => {
    if (homey && homey === homeyRef) return;
    homeyRef = homey;
    if (!listenersBound) {
      targets.root.addEventListener('click', handleClick);
      refresh.bindVisibility();
      refresh.start();
      listenersBound = true;
    }
    void loadAndRender();
  };

  const destroy = (): void => {
    destroyed = true;
    refresh.stop();
    if (doneResetTimer !== null) widgetWindow.clearTimeout(doneResetTimer);
    doneResetTimer = null;
    if (!listenersBound) return;
    targets.root.removeEventListener('click', handleClick);
    listenersBound = false;
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
