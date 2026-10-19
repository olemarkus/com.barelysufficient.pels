import {
  CREATE_SMART_TASK_WIDGET_COPY,
  resolveCreateSmartTaskRejectCopy,
} from '../../../packages/shared-domain/src/deadlineLabels';
import { renderFlow } from './flowRender';
import {
  assertUnhandledClick,
  clickedView,
  isViewClickAction,
  resolveFlowClickAction,
} from './flowClicks';
import {
  backView,
  buildCandidateRequest,
  editedInputView,
  flowStartView,
  quickTargetsLoadedView,
  submittableRequest,
} from './flowTransitions';
import type { SmartTaskCreateClient } from './flowClient';
import type { FlowTargets, FlowView } from './flowView';
import type { CreateSmartTaskDevice } from './types';

const C = CREATE_SMART_TASK_WIDGET_COPY;
const CREATED_FLASH_MS = 1800;

/**
 * The smart-task creation flow as one unit a widget hosts: quick targets, the
 * goal form, the preview and the created flash, over the flow's own markup.
 * The host opens it on a device; it closes when the user steps back out of its
 * first step, or once a created flash has shown and the host has reloaded. The
 * host then shows its own view again (the device list, or the device tile).
 * While open, the host routes its clicks and inputs here.
 */
export type SmartTaskCreateFlow = {
  open(device: CreateSmartTaskDevice): void;
  isOpen(): boolean;
  // The step on screen, for the host's `data-view`; null while closed.
  currentStep(): FlowView['kind'] | null;
  handleClick(event: Event): void;
  handleInput(event: Event): void;
  destroy(): void;
};

export type SmartTaskCreateFlowHost = {
  // The flow rendered a step (including asynchronously, when a response lands).
  onRender(): void;
  // A task was created: reload what the host shows. The created flash stays up
  // until this settles, so the host never shows its view from before the task
  // (a device tile still offering "+ Smart task", the device still listed).
  reloadAfterCreate(): Promise<void>;
};

export const createSmartTaskCreateFlow = (
  targets: FlowTargets,
  widgetWindow: Window,
  client: SmartTaskCreateClient,
  host: SmartTaskCreateFlowHost,
): SmartTaskCreateFlow => {
  let view: FlowView | null = null;
  let destroyed = false;
  let flashTimer: number | null = null;
  // Latest-request-wins token (bumped on every view change): a stale
  // quick-target, preview or create response that resolves after the user moved
  // on is dropped, not applied.
  let requestSeq = 0;

  const render = (): void => {
    renderFlow(targets, view);
    host.onRender();
  };

  const close = (): void => {
    view = null;
    requestSeq += 1;
    render();
  };

  // Single mutation seam: set the view and re-render.
  const setView = (next: FlowView | null): void => {
    if (next === view) return;
    if (next === null) {
      close();
      return;
    }
    view = next;
    requestSeq += 1;
    render();
  };

  // Time the quick targets for the device on the quick step.
  const loadQuickTargets = async (): Promise<void> => {
    if (view?.kind !== 'quick' || view.quick.kind !== 'loading') return;
    const token = ++requestSeq;
    const response = await client.quickTargets(view.device.deviceId);
    if (destroyed || token !== requestSeq || view?.kind !== 'quick') return;
    view = quickTargetsLoadedView(view, response);
    render();
  };

  const enterView = (next: FlowView | null): void => {
    setView(next);
    if (view?.kind === 'quick' && view.quick.kind === 'loading') void loadQuickTargets();
  };

  const runPreview = async (): Promise<void> => {
    if (view?.kind !== 'compose') return;
    if (!targets.goalValueEl.reportValidity() || !targets.readyByInput.reportValidity()) return;
    const request = buildCandidateRequest(view);
    if (request === null) return;
    const token = ++requestSeq;
    const { previewBtn } = targets;
    previewBtn.disabled = true;
    previewBtn.textContent = C.previewing;
    const response = await client.preview(request);
    // Drop a preview that resolved after navigation (stale).
    if (destroyed || token !== requestSeq || view?.kind !== 'compose') return;
    // Spread the compose view forward so device/goal/ready-by + the opt-in
    // permissions all carry into the preview state unchanged.
    view = { ...view, kind: 'preview', goal: request.target, response, submitting: false, error: null };
    render();
  };

  const startCreatedFlash = (): void => {
    if (flashTimer !== null) widgetWindow.clearTimeout(flashTimer);
    flashTimer = widgetWindow.setTimeout(() => {
      flashTimer = null;
      if (destroyed) return;
      const token = requestSeq;
      void host.reloadAfterCreate().then(() => {
        // Still on this created flash (not torn down, not reopened meanwhile).
        if (!destroyed && token === requestSeq && view?.kind === 'created') close();
      });
    }, CREATED_FLASH_MS);
  };

  // Create from the preview, or straight from a quick target. Success shows the
  // `created` flash (the success label appears only after `ok: true`);
  // otherwise the same step shows a retryable error: `deadline_passed` gets a
  // bespoke "preview again" line, everything else (write_conflict /
  // unavailable / …) the generic submit-failure copy (resolved in shared-domain).
  const submit = async (): Promise<void> => {
    if (view === null) return;
    const request = submittableRequest(view);
    if (request === null || (view.kind !== 'quick' && view.kind !== 'preview')) return;
    const kind = view.kind;
    view = { ...view, submitting: true, error: null };
    const token = ++requestSeq;
    render();
    const result = await client.create(request);
    if (destroyed || token !== requestSeq || view?.kind !== kind) return;
    view = result.ok
      ? { kind: 'created' }
      : { ...view, submitting: false, error: resolveCreateSmartTaskRejectCopy(result.reason) };
    render();
    if (result.ok) startCreatedFlash();
  };

  const handleClick = (event: Event): void => {
    if (view === null) return;
    const action = resolveFlowClickAction(event.target);
    if (action === null) return;
    if (isViewClickAction(action)) {
      setView(clickedView(action, view, targets));
      return;
    }
    switch (action.kind) {
      case 'preview': void runPreview(); break;
      case 'submit': void submit(); break;
      case 'back': enterView(backView(view)); break;
      default: assertUnhandledClick(action);
    }
  };

  return {
    open: (device) => enterView(flowStartView(device)),
    isOpen: () => view !== null,
    currentStep: () => view?.kind ?? null,
    handleClick,
    handleInput: (event) => {
      if (view !== null) setView(editedInputView(view, event.target, targets));
    },
    destroy: () => {
      destroyed = true;
      if (flashTimer !== null) widgetWindow.clearTimeout(flashTimer);
      flashTimer = null;
    },
  };
};
