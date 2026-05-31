import {
  CREATE_SMART_TASK_READY_BY_DEFAULT_ID,
  CREATE_SMART_TASK_WIDGET_COPY,
  resolveCreateSmartTaskRejectCopy,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import { resolveCreateSmartTaskPreviewPayload } from './previewPayloads';
import { renderWidget, type RenderTargets, type ViewState } from './render';
import type {
  CreateSmartTaskCandidateRequest,
  CreateSmartTaskCreateResponse,
  CreateSmartTaskDevice,
  CreateSmartTaskDevicesPayload,
  CreateSmartTaskPreviewResponse,
} from '../createSmartTaskWidgetTypes';

const C = CREATE_SMART_TASK_WIDGET_COPY;
const CREATED_FLASH_MS = 1800;
const READY_BY_PRESET_LOCAL_TIME: Record<string, string> = {
  morning: '07:00',
  midday: '12:00',
  evening: '18:00',
  night: '22:00',
};

export type WidgetWindow = Window & {
  Homey?: unknown;
  onHomeyReady?: (homey: WidgetHomey) => void;
};

// Homey widget API client. Unlike the observe-only widgets, this widget POSTs a
// body for preview/create, so the signature includes the optional body arg.
export type WidgetHomey = {
  api: (method: string, path: string, body?: unknown) => Promise<unknown>;
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

// Preview-mode response (used when the widget runs with `?preview=1` or no
// Homey API is wired). Kept tiny and obviously fictional. Hours are floored to
// the top of the hour so the rendered window reads as a clean "HH:00–HH:00"
// range in the demo, matching how real hour-aligned plan buckets render.
const HOUR_MS = 60 * 60 * 1000;
// Fixed narrative evening (today 19:00 local) so the demo chart's hour ticks
// read coherently with the fixed "Scheduled 02:00–04:00" / "before 07:00" copy,
// regardless of when the preview is captured. Real responses carry
// backend-resolved (DST-safe) timestamps; this is `?preview=1`-only demo data.
const PREVIEW_NEXT_HOUR_MS = (() => {
  const base = new Date();
  base.setHours(19, 0, 0, 0);
  return base.getTime();
})();
// Demo price curve across the preview window (narratively 19:00 → 07:00): an
// evening level, an overnight trough, then the morning climb to the deadline.
// The two scheduled hours sit at the bottom of the trough (02:00–03:00) so the
// preview chart visibly "picked the cheap hours". øre/kWh; obviously fictional,
// confined to the `?preview=1` path. Index 0 = now (top of the next hour).
const PREVIEW_PRICE_CURVE = [92, 79, 74, 63, 59, 66, 51, 44, 48, 69, 81, 107, 119];
// Scheduled at the trough (indices 7 & 8 → "02:00" / "03:00").
const PREVIEW_SCHEDULED_INDEX = [7, 8];
const PREVIEW_RESPONSE: CreateSmartTaskPreviewResponse = {
  ok: true,
  deadlineAtMs: PREVIEW_NEXT_HOUR_MS + 12 * HOUR_MS,
  deadlineLabel: 'Tomorrow 07:00',
  // Server-formatted in real responses; a fixed demo window here.
  scheduledWindowLabel: '02:00–04:00',
  estimate: {
    status: 'on_track',
    scheduledHours: PREVIEW_SCHEDULED_INDEX.map((index) => ({
      startsAtMs: PREVIEW_NEXT_HOUR_MS + index * HOUR_MS,
      plannedKWh: 2,
    })),
    projectedFinishAtMs: PREVIEW_NEXT_HOUR_MS + 9 * HOUR_MS,
    energyEstimateKWh: 4,
    energyExpectedKWh: 3.6,
    costEstimate: 4.2,
    costUnit: 'kr',
    priceSeries: PREVIEW_PRICE_CURVE.map((price, index) => ({
      startsAtMs: PREVIEW_NEXT_HOUR_MS + index * HOUR_MS,
      price,
    })),
  },
};

const resolveTargets = (d: Document): RenderTargets | null => {
  const root = d.getElementById('widget-root');
  const deviceTemplate = d.getElementById('device-template');
  const readyByTemplate = d.getElementById('ready-by-template');
  const map = {
    pickerView: '[data-picker-view]',
    pickerPrompt: '[data-picker-prompt]',
    pickerCaption: '[data-picker-caption]',
    pickerList: '[data-device-list]',
    pickerEmpty: '[data-picker-empty]',
    pickerEmptyHint: '[data-picker-empty-hint]',
    composeView: '[data-compose-view]',
    composeTitle: '[data-compose-title]',
    goalLabel: '[data-goal-label]',
    goalValueEl: '[data-goal-value]',
    goalContextEl: '[data-goal-context]',
    readyByLabel: '[data-ready-by-label]',
    readyByList: '[data-ready-by-list]',
    readyByEchoEl: '[data-ready-by-echo]',
    previewView: '[data-preview-view]',
    previewTitle: '[data-preview-title]',
    previewCostEl: '[data-preview-cost]',
    previewCostSubtextEl: '[data-preview-cost-subtext]',
    previewChartEl: '[data-preview-chart]',
    previewWhenEl: '[data-preview-when]',
    previewEnergyEl: '[data-preview-energy]',
    previewCaveatEl: '[data-preview-caveat]',
    previewUnavailableEl: '[data-preview-unavailable]',
    previewErrorEl: '[data-preview-error]',
    createdView: '[data-created-view]',
    createdMsgEl: '[data-created-msg]',
  } as const;
  const buttons = {
    composeBackBtn: '[data-compose-back]',
    goalDecBtn: '[data-goal-dec]',
    goalIncBtn: '[data-goal-inc]',
    previewBtn: '[data-preview-btn]',
    previewBackBtn: '[data-preview-back]',
    createBtn: '[data-create-btn]',
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
    || !(readyByTemplate instanceof HTMLTemplateElement)
    || Object.values(generic).some((el) => !(el instanceof HTMLElement))
    || Object.values(btns).some((el) => !(el instanceof HTMLButtonElement))
  ) {
    return null;
  }
  return {
    root,
    deviceTemplate,
    readyByTemplate,
    ...(generic as Record<string, HTMLElement>),
    ...(btns as Record<string, HTMLButtonElement>),
  } as RenderTargets;
};

const initialComposeView = (device: CreateSmartTaskDevice): Extract<ViewState, { kind: 'compose' }> => ({
  kind: 'compose',
  device,
  goal: device.defaultGoal,
  readyById: CREATE_SMART_TASK_READY_BY_DEFAULT_ID,
});

// Pure view transitions (no closure state) so the controller's click handlers
// stay one-liners. Each returns the next view, or the current view unchanged
// when the action doesn't apply to the current state.
const steppedGoalView = (view: ViewState, direction: 1 | -1): ViewState => {
  if (view.kind !== 'compose') return view;
  const { device, goal } = view;
  const next = Math.round((goal + direction * device.goalStep) * 100) / 100;
  return { ...view, goal: Math.min(device.goalMax, Math.max(device.goalMin, next)) };
};

// "Back" steps preview→compose (keeping the candidate) or compose→picker.
const backView = (view: ViewState): ViewState => {
  if (view.kind === 'preview') {
    return { kind: 'compose', device: view.device, goal: view.goal, readyById: view.readyById };
  }
  return { kind: 'picker' };
};

const buildCandidateRequest = (
  device: CreateSmartTaskDevice,
  goal: number,
  readyById: string,
  // The previewed deadline, echoed back on create so the persisted task matches
  // the previewed window exactly (the server validates it before use). Omitted
  // for the preview call itself (the server resolves it there).
  deadlineAtMs?: number,
): CreateSmartTaskCandidateRequest => ({
  deviceId: device.deviceId,
  kind: device.kind,
  target: goal,
  readyByLocalTime: READY_BY_PRESET_LOCAL_TIME[readyById] ?? READY_BY_PRESET_LOCAL_TIME.morning,
  ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
});

// The deadline to echo back on create: the one the preview RESOLVED and showed
// the user, so the created task matches the previewed window exactly (the
// server re-validates it). Undefined for a failed preview — create is disabled
// in that case, so this only feeds an ok preview's create.
const previewedDeadline = (response: CreateSmartTaskPreviewResponse): number | undefined => (
  response.ok ? response.deadlineAtMs : undefined
);

// Discriminated action a click maps to. Pure resolution (no closure state) so
// the controller's dispatcher stays small and the mapping is unit-testable.
type ClickAction =
  | { kind: 'select-device'; deviceId: string }
  | { kind: 'select-ready-by'; readyById: string }
  | { kind: 'goal-dec' }
  | { kind: 'goal-inc' }
  | { kind: 'preview' }
  | { kind: 'create' }
  | { kind: 'back' };

const closestDataValue = (target: Element, selector: string, key: string): string | null => {
  const el = target.closest(selector);
  return el instanceof HTMLElement ? el.dataset[key] ?? null : null;
};

// ─── API calls (module-level so the controller closure stays small) ──────────
// Each helper swallows transport failures into the contract's `{ ok: false }`
// shape so the controller never has to try/catch.
//
// The canned `PREVIEW_*` payloads are CONFINED to the `?preview=1` design-
// preview path (`usePreviewData`). On a real boot with no API client yet —
// the SDK bridge hasn't supplied `homeyRef`, or it failed to load — the
// helpers must NOT pretend canned data is real: devices surface a transient
// "connecting" state and preview/create report `unavailable`. This is what
// stops a user from seeing a "Created" flash while nothing was actually
// created (the create button stays disabled and create can't report success
// without a real `/create` call). See `notReady` copy in shared-domain.

const fetchDevices = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
  previewState: string | null,
): Promise<CreateSmartTaskDevicesPayload> => {
  if (usePreviewData) return resolveCreateSmartTaskPreviewPayload(previewState);
  // Real boot, bridge not ready yet: a transient "connecting" state, never the
  // canned sample devices. Shared copy (not an inlined literal) per
  // `feedback_ui_text_shared_with_logs`.
  if (!homeyRef) return { state: 'empty', subtitle: C.notReady, hint: null };
  try {
    return await homeyRef.api('GET', '/devices') as CreateSmartTaskDevicesPayload;
  } catch (error) {
    console.error('Failed to load create_smart_task widget', error);
    // Shared copy (not an inlined literal) so the load-failure subtitle stays in
    // lock-step with the rest of the widget vocabulary per
    // `feedback_ui_text_shared_with_logs`.
    return { state: 'empty', subtitle: C.loadError, hint: null };
  }
};

const fetchPreview = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
  request: CreateSmartTaskCandidateRequest,
): Promise<CreateSmartTaskPreviewResponse> => {
  if (usePreviewData) return PREVIEW_RESPONSE;
  if (!homeyRef) return { ok: false, reason: 'unavailable' };
  try {
    return await homeyRef.api('POST', '/preview', request) as CreateSmartTaskPreviewResponse;
  } catch (error) {
    console.error('Failed to preview smart task', error);
    return { ok: false, reason: 'unavailable' };
  }
};

const submitCreate = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
  request: CreateSmartTaskCandidateRequest,
): Promise<CreateSmartTaskCreateResponse> => {
  if (usePreviewData) return { ok: true };
  // Never report success without a real `/create` round-trip. With no API
  // client there is nothing to create against, so report `unavailable` rather
  // than an optimistic `{ ok: true }`.
  if (!homeyRef) return { ok: false, reason: 'unavailable' };
  try {
    return await homeyRef.api('POST', '/create', request) as CreateSmartTaskCreateResponse;
  } catch (error) {
    console.error('Failed to create smart task', error);
    return { ok: false, reason: 'unavailable' };
  }
};

export const resolveClickAction = (eventTarget: EventTarget | null): ClickAction | null => {
  if (!(eventTarget instanceof Element)) return null;
  const deviceId = closestDataValue(eventTarget, '[data-device-button]', 'deviceId');
  if (deviceId) return { kind: 'select-device', deviceId };
  const readyById = closestDataValue(eventTarget, '[data-ready-by]', 'readyById');
  if (readyById) return { kind: 'select-ready-by', readyById };
  if (eventTarget.closest('[data-goal-dec]')) return { kind: 'goal-dec' };
  if (eventTarget.closest('[data-goal-inc]')) return { kind: 'goal-inc' };
  if (eventTarget.closest('[data-preview-btn]')) return { kind: 'preview' };
  if (eventTarget.closest('[data-create-btn]')) return { kind: 'create' };
  if (eventTarget.closest('[data-compose-back]') || eventTarget.closest('[data-preview-back]')) {
    return { kind: 'back' };
  }
  return null;
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
  let devicesPayload: CreateSmartTaskDevicesPayload | null = null;
  let view: ViewState = { kind: 'picker' };
  let interactionBound = false;
  let usePreviewData = false;
  let createdResetTimer: number | null = null;
  let destroyed = false;
  // Latest-request-wins token (bumped on `setView`): a stale preview/create that
  // resolves after the user moved on is dropped, not applied. See runPreview.
  let requestSeq = 0;

  const render = (): void => {
    renderWidget(targets, devicesPayload, view);
  };

  // Single mutation seam: set the view and re-render. Every view change bumps
  // the request token so any in-flight preview/create that resolves afterwards
  // is recognised as stale and dropped (latest-request-wins).
  const setView = (next: ViewState): void => {
    view = next;
    requestSeq += 1;
    render();
  };

  const runPreview = async (): Promise<void> => {
    if (view.kind !== 'compose') return;
    const { device, goal, readyById } = view;
    const token = ++requestSeq;
    const response = await fetchPreview(homeyRef, usePreviewData, buildCandidateRequest(device, goal, readyById));
    // Drop a preview that resolved after navigation/device-switch (stale).
    if (token !== requestSeq || view.kind !== 'compose') return;
    view = { kind: 'preview', device, goal, readyById, response, submitting: false, error: null };
    render();
  };

  const runCreate = async (): Promise<void> => {
    if (view.kind !== 'preview') return;
    const { device, goal, readyById } = view;
    const request = buildCandidateRequest(device, goal, readyById, previewedDeadline(view.response));
    view = { ...view, submitting: true, error: null };
    const token = ++requestSeq;
    render();
    const result = await submitCreate(homeyRef, usePreviewData, request);
    // Same latest-request-wins guard: a create that resolves after the user
    // backed out / switched candidates must not flip the now-different view.
    if (token !== requestSeq || view.kind !== 'preview') return;
    // Success → the `created` flash (success label only here, after `ok:true`).
    // Otherwise back to the preview with a retryable error: `deadline_passed`
    // gets a bespoke "preview again" line, everything else (write_conflict /
    // unavailable / …) the generic submit-failure copy (resolved in shared-domain).
    view = result.ok
      ? { kind: 'created' }
      : { ...view, submitting: false, error: resolveCreateSmartTaskRejectCopy(result.reason) };
    render();
    if (result.ok) scheduleCreatedReset();
  };

  const scheduleCreatedReset = (): void => {
    if (createdResetTimer !== null) widgetWindow.clearTimeout(createdResetTimer);
    createdResetTimer = widgetWindow.setTimeout(() => {
      if (destroyed) return; // torn down during the success flash — don't resurrect a render
      view = { kind: 'picker' };
      void loadAndRender();
    }, CREATED_FLASH_MS);
  };

  const selectDevice = (deviceId: string): void => {
    if (!devicesPayload || devicesPayload.state !== 'ready') return;
    const device = devicesPayload.devices.find((entry) => entry.deviceId === deviceId);
    if (device) setView(initialComposeView(device));
  };

  const handleClick = (event: Event): void => {
    const action = resolveClickAction(event.target);
    if (action === null) return;
    switch (action.kind) {
      case 'select-device': selectDevice(action.deviceId); return;
      case 'select-ready-by':
        if (view.kind === 'compose') setView({ ...view, readyById: action.readyById }); return;
      case 'goal-dec': setView(steppedGoalView(view, -1)); return;
      case 'goal-inc': setView(steppedGoalView(view, 1)); return;
      case 'preview': void runPreview(); return;
      case 'create': void runCreate(); return;
      case 'back': setView(backView(view)); return;
      default: {
        const unhandled: never = action; // exhaustiveness guard: a new ClickAction is a type error here
        void unhandled;
      }
    }
  };

  const bindInteraction = (): void => {
    if (interactionBound) return;
    targets.root.addEventListener('click', handleClick);
    interactionBound = true;
  };

  const unbindInteraction = (): void => {
    if (!interactionBound) return;
    targets.root.removeEventListener('click', handleClick);
    interactionBound = false;
  };

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    const searchParams = new URLSearchParams(widgetWindow.location.search);
    usePreviewData = searchParams.get('preview') === '1';
    maybeApplyPreviewTheme(widgetDocument, searchParams);
    const payload = await fetchDevices(homeyRef, usePreviewData, searchParams.get('state'));
    // Drop a torn-down or superseded load before touching the DOM (latest-wins).
    if (destroyed || loadId !== loadSequence) return;
    devicesPayload = payload;
    // Only the picker view depends on the device list; in-progress compose/
    // preview keep their captured device, so don't reset the user mid-flow.
    if (view.kind === 'picker' || payload.state === 'ready') render();
    if (!initialRenderDone && homeyRef?.ready) {
      homeyRef.ready();
      initialRenderDone = true;
    }
  };

  const bootstrap = (homey: WidgetHomey | null): void => {
    if (homey && homey === homeyRef) return;
    homeyRef = homey;
    bindInteraction();
    void loadAndRender();
  };

  const destroy = (): void => {
    destroyed = true;
    if (createdResetTimer !== null) {
      widgetWindow.clearTimeout(createdResetTimer);
      createdResetTimer = null;
    }
    unbindInteraction();
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
