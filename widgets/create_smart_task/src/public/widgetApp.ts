import { CREATE_SMART_TASK_WIDGET_COPY } from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  applyPreviewTheme,
  type WidgetController as SharedWidgetController,
} from '../../../_shared/widgetRuntime';
import { widgetErrorReporter, type WidgetErrorReporter } from '../../../_shared/widgetClientLog';
import { closestDataValue } from '../../../_shared/widgetDom';
import {
  installHeightReportingWidget,
  type HeightReportingHomey,
  type HeightReportingWindow,
} from '../../../_shared/widgetHeight';
import { createSmartTaskCreateClient } from '../../../_shared/smartTaskCreate/flowClient';
import { createSmartTaskCreateFlow } from '../../../_shared/smartTaskCreate/flowController';
import { resolveFlowTargets } from '../../../_shared/smartTaskCreate/flowView';
import { resolveCreateSmartTaskPreviewPayload } from './previewPayloads';
import { renderPickerView, type RenderTargets } from './render';
import type { CreateSmartTaskDevicesPayload } from '../createSmartTaskWidgetTypes';

const C = CREATE_SMART_TASK_WIDGET_COPY;

export type WidgetWindow = HeightReportingWindow;
// Homey widget API client. This widget POSTs a body for its flow requests —
// `WidgetHomeyBase.api` already carries the optional body arg.
export type WidgetHomey = HeightReportingHomey;
export type WidgetController = SharedWidgetController<WidgetHomey>;

const resolveTargets = (d: Document): RenderTargets | null => {
  const flow = resolveFlowTargets(d);
  const root = d.getElementById('widget-root');
  const deviceTemplate = d.getElementById('device-template');
  const elements = {
    pickerView: d.querySelector('[data-picker-view]'),
    pickerPrompt: d.querySelector('[data-picker-prompt]'),
    pickerCaption: d.querySelector('[data-picker-caption]'),
    pickerList: d.querySelector('[data-device-list]'),
    pickerEmpty: d.querySelector('[data-picker-empty]'),
    pickerEmptyHint: d.querySelector('[data-picker-empty-hint]'),
  };
  const pickerRetryBtn = d.querySelector('[data-picker-retry]');
  if (
    flow === null
    || !(root instanceof HTMLElement)
    || !(deviceTemplate instanceof HTMLTemplateElement)
    || !(pickerRetryBtn instanceof HTMLButtonElement)
    || Object.values(elements).some((el) => !(el instanceof HTMLElement))
  ) {
    return null;
  }
  return {
    ...flow, root, deviceTemplate, pickerRetryBtn, ...(elements as Record<keyof typeof elements, HTMLElement>),
  };
};

// ─── Device list (the creation flow's requests live in the shared client) ────
//
// The canned preview payload is CONFINED to the `?preview=1` design-preview
// path. On a real boot with no API client yet the list surfaces a transient
// "connecting" state, never the canned sample devices.

const fetchDevices = async (
  homeyRef: WidgetHomey | null,
  usePreviewData: boolean,
  previewState: string | null,
  reporter: WidgetErrorReporter,
): Promise<CreateSmartTaskDevicesPayload> => {
  if (usePreviewData) return resolveCreateSmartTaskPreviewPayload(previewState);
  // Real boot, bridge not ready yet: a transient "connecting" state, never the
  // canned sample devices. Shared copy (not an inlined literal) per
  // `feedback_ui_text_shared_with_logs`.
  if (!homeyRef) return { state: 'empty', subtitle: C.notReady, hint: null };
  try {
    const payload = await homeyRef.api('GET', '/devices') as CreateSmartTaskDevicesPayload;
    // GET succeeded → the app is reachable; drain any backlog queued while down.
    reporter.flush();
    return payload;
  } catch (error) {
    reporter.report('error', 'Failed to load create_smart_task widget', error);
    // A real fetch that FAILED — the distinct `error` state, not `empty`. It
    // carries a tap-to-retry affordance (see render + resolveClickAction) so a
    // stuck load recovers in place. Shared copy (not an inlined literal) so the
    // load-failure subtitle stays in lock-step with the rest of the widget
    // vocabulary per `feedback_ui_text_shared_with_logs`.
    return { state: 'error' };
  }
};

type PickerClickAction = { kind: 'select-device'; deviceId: string } | { kind: 'retry-load' };

const resolvePickerClick = (eventTarget: EventTarget | null): PickerClickAction | null => {
  if (!(eventTarget instanceof Element)) return null;
  const deviceId = closestDataValue(eventTarget, '[data-device-button]', 'deviceId');
  if (deviceId) return { kind: 'select-device', deviceId };
  // Retry the device fetch in place after a load error (see the `error` payload
  // state) — re-runs loadAndRender so a stuck load recovers without a reopen.
  if (eventTarget.closest('[data-picker-retry]')) return { kind: 'retry-load' };
  return null;
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
  let devicesPayload: CreateSmartTaskDevicesPayload | null = null;
  let usePreviewData = false;
  let destroyed = false;
  const reporter = widgetErrorReporter('create_smart_task', () => homeyRef);

  const { root } = targets;
  const render = (): void => {
    root.dataset.view = flow.currentStep() ?? 'picker';
    renderPickerView(targets, devicesPayload, !flow.isOpen());
  };

  const flow = createSmartTaskCreateFlow(
    targets,
    widgetWindow,
    createSmartTaskCreateClient(() => homeyRef, () => usePreviewData, reporter),
    {
      onRender: () => render(),
      // A created task changes which devices can take a new one.
      reloadAfterCreate: () => loadAndRender(),
    },
  );

  const selectDevice = (deviceId: string): void => {
    if (!devicesPayload || devicesPayload.state !== 'ready') return;
    const device = devicesPayload.devices.find((entry) => entry.deviceId === deviceId);
    if (!device) return;
    flow.open(device);
  };

  const handleClick = (event: Event): void => {
    if (flow.isOpen()) {
      flow.handleClick(event);
      return;
    }
    const action = resolvePickerClick(event.target);
    if (action?.kind === 'select-device') selectDevice(action.deviceId);
    else if (action?.kind === 'retry-load') void loadAndRender();
  };

  const handleInput = (event: Event): void => flow.handleInput(event);

  const loadAndRender = async (): Promise<void> => {
    const loadId = ++loadSequence;
    const searchParams = new URLSearchParams(widgetWindow.location.search);
    usePreviewData = searchParams.get('preview') === '1';
    applyPreviewTheme(widgetDocument, searchParams);
    const payload = await fetchDevices(homeyRef, usePreviewData, searchParams.get('state'), reporter);
    // Drop a torn-down or superseded load before touching the DOM (latest-wins).
    if (destroyed || loadId !== loadSequence) return;
    devicesPayload = payload;
    // Only the device list depends on the payload; an open flow keeps its
    // captured device, so don't reset the user mid-flow.
    render();
    if (!initialRenderDone && homeyRef?.ready) {
      homeyRef.ready();
      initialRenderDone = true;
      onReady();
    }
  };

  const bootstrap = (homey: WidgetHomey | null): void => {
    if (homey && homey === homeyRef) return;
    homeyRef = homey;
    void loadAndRender();
  };

  const destroy = (): void => {
    destroyed = true;
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
