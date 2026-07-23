import {
  SETTINGS_UI_SMART_TASK_CANCEL_PATH,
  SETTINGS_UI_SMART_TASK_PREVIEW_PATH,
  SETTINGS_UI_SMART_TASK_UPDATE_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import type {
  SettingsUiSmartTaskCancelRequest,
  SettingsUiSmartTaskCancelResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskUpdateResponse,
  SmartTaskCandidateRequest,
} from '../../../contracts/src/smartTaskEdit.ts';
import type { DeferredObjectiveSettingsKind } from '../../../contracts/src/deferredObjectiveSettings.ts';
import {
  composeSmartTaskDraftLandingLine,
  CREATE_SMART_TASK_WIDGET_COPY,
  SMART_TASK_EDIT_COPY,
  formatDeadlineCostMetaLine,
  resolveSmartTaskEditRejectCopy,
  resolveSmartTaskPreviewStatusCopy,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast } from './toast.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';

// Module-scope controller for the smart-task detail page's edit/clear lane.
// The detail page re-renders its whole Preact root on every debounced runtime
// refresh (and the load-state branch can flip `ready` → `pending` mid-edit),
// so an open editor's draft must NOT live in component state — it would be
// unmounted and lost. Like `budgetAdjustController.ts`, the draft lives here
// and every render (whatever triggered it) repaints the editor from this
// state; the view stays a thin renderer per `views/AGENTS.md`.

const PREVIEW_DEBOUNCE_MS = 400;
// Same auto-revert window as the other two-step confirm buttons
// (BudgetOverview's discard confirm) so armed danger actions behave uniformly.
const CLEAR_CONFIRM_REVERT_MS = 5000;

const READY_BY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type SmartTaskEditContext = {
  deviceId: string;
  kind: DeferredObjectiveSettingsKind;
  unit: string;
  min: number;
  max: number;
  step: number;
  // Baselines are captured ONCE when the editor opens (the ready-by rendered
  // from the task's deadline in the Homey timezone), so later background boot
  // refreshes can never overwrite what the user is typing.
  baselineReadyBy: string;
  baselineTarget: number;
  // The task's current absolute deadline. Echoed on a save whose ready-by is
  // UNCHANGED, so a quick target-only save keeps the exact same deadline
  // instead of letting the server re-resolve the HH:mm — which would silently
  // roll an about-to-expire task to tomorrow.
  baselineDeadlineAtMs: number;
};

export type SmartTaskEditPreviewView = {
  deadlineAtMs: number;
  // "If you save: runs 02:00–04:00 · Ready by Tomorrow 07:00" — both halves
  // formatted server-side in the Homey timezone, prefixed as explicitly
  // conditional (`composeSmartTaskDraftLandingLine`). This is the honest
  // pre-save display of where the typed HH:mm actually lands (today vs rolled
  // to tomorrow) without contradicting the hero's current plan.
  whenLine: string;
  costLine: string | null;
  // Feasibility verdict (cannot finish / at risk / unavailable reason). Null
  // when the projection is an ordinary healthy estimate.
  verdictLine: string | null;
  caveat: string;
};

export type SmartTaskEditBusy = 'clearing' | 'idle' | 'previewing' | 'saving';

export type SmartTaskEditSnapshot = {
  context: SmartTaskEditContext;
  // `target` is the RAW input text, parsed only at validation/submit time —
  // binding the field to a parsed number would strip intermediate typing
  // states ("20." re-rendering as "20", a lone "-" clearing the field).
  draft: { readyBy: string; target: string };
  dirty: boolean;
  valid: boolean;
  busy: SmartTaskEditBusy;
  preview: SmartTaskEditPreviewView | null;
  errorLine: string | null;
  clearArmed: boolean;
};

type ControllerState = SmartTaskEditSnapshot | null;

let state: ControllerState = null;
let revision = 0;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let clearRevertTimer: ReturnType<typeof setTimeout> | null = null;
let renderRequested: () => void = () => {};
let requestClose: () => void = () => {};
let refreshBoot: () => void = () => {};

export const initSmartTaskEditController = (hooks: {
  render: () => void;
  requestClose: () => void;
  // Re-fetches the detail page's own boot payload (bootstrap/devices/prices).
  // Needed on the task-ended path: `refreshPlanSurface` only bumps the
  // Overview plan surface, not this page's cached boot.
  refreshBoot: () => void;
}): void => {
  renderRequested = hooks.render;
  requestClose = hooks.requestClose;
  refreshBoot = hooks.refreshBoot;
};

export const getSmartTaskEditSnapshot = (): SmartTaskEditSnapshot | null => state;

const parseTarget = (raw: string): number | null => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const isValidDraft = (s: SmartTaskEditSnapshot): boolean => {
  const target = parseTarget(s.draft.target);
  return READY_BY_PATTERN.test(s.draft.readyBy)
    && target !== null
    && target >= s.context.min
    && target <= s.context.max;
};

// Dirtiness compares the PARSED target ("65." is still the baseline 65), so
// intermediate typing that doesn't change the value can't arm Save by itself.
const isDirtyDraft = (s: SmartTaskEditSnapshot): boolean => (
  s.draft.readyBy !== s.context.baselineReadyBy
  || parseTarget(s.draft.target) !== s.context.baselineTarget
);

const disarmClearTimer = (): void => {
  if (clearRevertTimer !== null) {
    clearTimeout(clearRevertTimer);
    clearRevertTimer = null;
  }
};

const cancelPendingPreview = (): void => {
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
};

const buildRequestBody = (s: SmartTaskEditSnapshot): SmartTaskCandidateRequest => ({
  deviceId: s.context.deviceId,
  kind: s.context.kind,
  // Callers gate on `isValidDraft`, so the NaN fallback is unreachable; if it
  // ever leaked, the server's shape guard rejects it as invalid_request.
  target: parseTarget(s.draft.target) ?? Number.NaN,
  readyByLocalTime: s.draft.readyBy,
});

const toPreviewView = (
  response: Extract<SettingsUiSmartTaskPreviewResponse, { ok: true }>,
): SmartTaskEditPreviewView => ({
  deadlineAtMs: response.deadlineAtMs,
  // Explicitly conditional ("If you save: runs …") — the hero above still
  // shows the CURRENT plan, so the draft's window/cost must never read as an
  // already-committed schedule beside it.
  whenLine: composeSmartTaskDraftLandingLine({
    scheduledWindowLabel: response.scheduledWindowLabel,
    deadlineLabel: response.deadlineLabel,
  }),
  costLine: response.estimate.costEstimate !== null && response.estimate.costUnit
    ? formatDeadlineCostMetaLine({
      plannedTotalCost: response.estimate.costEstimate,
      deliveredCost: null,
      costUnit: response.estimate.costUnit,
    })
    : null,
  verdictLine: resolveSmartTaskPreviewStatusCopy(
    response.estimate.status,
    response.estimate.unavailableReason,
  ),
  caveat: CREATE_SMART_TASK_WIDGET_COPY.estimateCaveat,
});

const runPreview = async (): Promise<void> => {
  const s = state;
  if (!s || !isValidDraft(s) || !isDirtyDraft(s)) return;
  const requestRevision = revision;
  s.busy = 'previewing';
  renderRequested();
  try {
    const response = await callApi<SettingsUiSmartTaskPreviewResponse>(
      'POST',
      SETTINGS_UI_SMART_TASK_PREVIEW_PATH,
      buildRequestBody(s),
    );
    if (revision !== requestRevision || state !== s) return;
    if (response.ok) {
      s.preview = toPreviewView(response);
      // Deliberately does NOT clear `errorLine`: draft edits already clear it
      // (`applyDraftChange`), so an error still standing here belongs to the
      // deadline_passed re-preview flow — the rejection copy and the fresh
      // landing line must coexist so the user sees both why the save failed
      // and where a retry now lands.
    } else {
      const reason = 'reason' in response ? response.reason : undefined;
      s.preview = null;
      // A failed preview never blocks saving (the server re-resolves on save);
      // it only loses the readout. `task_not_found` is terminal, though — the
      // task ended while editing, so close instead of previewing a ghost.
      if (reason === 'task_not_found') {
        await handleTaskEnded();
        return;
      }
      s.errorLine = resolveSmartTaskEditRejectCopy(reason);
    }
  } catch (error) {
    if (revision !== requestRevision || state !== s) return;
    s.preview = null;
    await logSettingsError('Failed to preview smart task edit', error, 'smartTaskEdit.preview');
  } finally {
    if (revision === requestRevision && state === s) {
      s.busy = 'idle';
      renderRequested();
    }
  }
};

const schedulePreview = (): void => {
  cancelPendingPreview();
  const s = state;
  if (!s || !isValidDraft(s) || !isDirtyDraft(s)) return;
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void runPreview();
  }, PREVIEW_DEBOUNCE_MS);
};

export const openSmartTaskEditor = (context: SmartTaskEditContext): void => {
  disarmClearTimer();
  cancelPendingPreview();
  revision += 1;
  state = {
    context,
    draft: { readyBy: context.baselineReadyBy, target: String(context.baselineTarget) },
    dirty: false,
    valid: true,
    busy: 'idle',
    preview: null,
    errorLine: null,
    clearArmed: false,
  };
  renderRequested();
};

export const closeSmartTaskEditor = (): void => {
  disarmClearTimer();
  cancelPendingPreview();
  revision += 1;
  state = null;
  renderRequested();
};

const applyDraftChange = (patch: Partial<SmartTaskEditSnapshot['draft']>): void => {
  const s = state;
  if (!s || s.busy === 'saving' || s.busy === 'clearing') return;
  // The revision bump below invalidates any in-flight preview; its `finally`
  // then skips the busy reset, so reset here — otherwise reverting the draft
  // to clean (or invalid) mid-flight strands a permanent "Updating estimate…".
  if (s.busy === 'previewing') s.busy = 'idle';
  s.draft = { ...s.draft, ...patch };
  s.preview = null;
  s.errorLine = null;
  s.clearArmed = false;
  disarmClearTimer();
  revision += 1;
  s.dirty = isDirtyDraft(s);
  s.valid = isValidDraft(s);
  renderRequested();
  schedulePreview();
};

export const setSmartTaskEditReadyBy = (value: string): void => {
  applyDraftChange({ readyBy: value.trim() });
};

export const setSmartTaskEditTarget = (rawValue: string): void => {
  applyDraftChange({ target: rawValue.trim() });
};

// The task ended (completed/expired/cleared elsewhere) while the editor was
// open. Close the editor, tell the user honestly, and refresh the surface so
// the page re-resolves to its completed/absent state.
const handleTaskEnded = async (): Promise<void> => {
  closeSmartTaskEditor();
  // Both surfaces: the sibling Smart-tasks list (plan surface) AND this
  // page's own boot payload — without the re-boot the detail page would
  // rerender the ended task from the stale cached boot, edit offer included.
  refreshPlanSurface();
  refreshBoot();
  await showToast(SMART_TASK_EDIT_COPY.taskEnded, 'warn');
};

// Shared rejected-write handling: `task_not_found` is terminal (the task ended
// while editing → close + refresh), everything else returns the editor to idle
// with the reason's copy inline.
const settleRejectedWrite = async (
  reason: string | undefined,
  errorLine: string,
): Promise<void> => {
  if (reason === 'task_not_found') {
    await handleTaskEnded();
    return;
  }
  const s = state;
  if (!s) return;
  s.busy = 'idle';
  s.clearArmed = false;
  s.errorLine = errorLine;
  renderRequested();
};

// Rejected save: the shared settle handling, plus the deadline_passed
// specifics — drop the stale echo and immediately re-preview, so the fresh
// "If you save: … Ready by Tomorrow HH:mm" landing line (and its echoed
// deadline) is on screen BEFORE the next save. Without this, re-tapping Save
// would send no echo and the server would re-resolve the past HH:mm to
// tomorrow silently — the exact roll the deadline_passed lane exists to
// prevent.
const settleRejectedSave = async (reason: string | undefined): Promise<void> => {
  const s = state;
  if (!s) return;
  if (reason === 'deadline_passed') s.preview = null;
  await settleRejectedWrite(reason, resolveSmartTaskEditRejectCopy(reason));
  if (reason === 'deadline_passed' && state === s) void runPreview();
};

// Echo an absolute deadline whenever one is honestly known, so the server
// re-validates it instead of silently re-resolving the HH:mm: the previewed
// deadline when the preview is still for this draft (any edit nulls it),
// else — for an UNCHANGED ready-by (target-only save, possibly before the
// debounced preview landed) — the task's current deadline. Only a save with
// an edited ready-by and no preview yet sends the bare HH:mm; there the
// next-future-occurrence resolution is exactly what the user just typed.
// Callers capture the body BEFORE the revision bump that invalidates
// in-flight previews.
const buildSaveBody = (s: SmartTaskEditSnapshot): SmartTaskCandidateRequest => {
  const readyByUnchanged = s.draft.readyBy === s.context.baselineReadyBy;
  const echoedDeadlineAtMs = s.preview?.deadlineAtMs
    ?? (readyByUnchanged ? s.context.baselineDeadlineAtMs : undefined);
  return echoedDeadlineAtMs !== undefined
    ? { ...buildRequestBody(s), deadlineAtMs: echoedDeadlineAtMs }
    : buildRequestBody(s);
};

export const submitSmartTaskUpdate = async (): Promise<void> => {
  const s = state;
  if (!s || (s.busy !== 'idle' && s.busy !== 'previewing')) return;
  if (!isValidDraft(s) || !isDirtyDraft(s)) return;
  cancelPendingPreview();
  const body = buildSaveBody(s);
  revision += 1;
  const requestRevision = revision;
  s.busy = 'saving';
  s.errorLine = null;
  renderRequested();
  try {
    const response = await callApi<SettingsUiSmartTaskUpdateResponse>(
      'POST',
      SETTINGS_UI_SMART_TASK_UPDATE_PATH,
      body,
    );
    if (state !== s) return;
    if (!response.ok) {
      await settleRejectedSave('reason' in response ? response.reason : undefined);
      return;
    }
    closeSmartTaskEditor();
    // The write's own notify/rebuild also pushes a realtime `plan_updated`
    // that re-fetches this page; the explicit bump covers the sibling
    // surfaces (Smart-tasks list) immediately.
    refreshPlanSurface();
    await showToast(SMART_TASK_EDIT_COPY.updated, 'ok');
  } catch (error) {
    if (state === s && revision === requestRevision) {
      s.busy = 'idle';
      s.errorLine = SMART_TASK_EDIT_COPY.updateError;
      renderRequested();
    }
    await logSettingsError('Failed to save smart task edit', error, 'smartTaskEdit.update');
  }
};

// First tap of the two-step clear: arm the confirm label and start the shared
// auto-revert window.
const armClearConfirm = (): void => {
  const s = state;
  if (!s) return;
  s.clearArmed = true;
  renderRequested();
  disarmClearTimer();
  clearRevertTimer = setTimeout(() => {
    clearRevertTimer = null;
    const current = state;
    if (current && current.clearArmed) {
      current.clearArmed = false;
      renderRequested();
    }
  }, CLEAR_CONFIRM_REVERT_MS);
};

// Two-step clear: first tap arms (auto-reverts after the shared confirm
// window), second tap commits. On success the page closes back to the
// Smart-tasks list — the detail route now points at an absent task.
export const requestSmartTaskClear = async (): Promise<void> => {
  const s = state;
  if (!s || s.busy === 'saving' || s.busy === 'clearing') return;
  if (!s.clearArmed) {
    armClearConfirm();
    return;
  }
  disarmClearTimer();
  cancelPendingPreview();
  // Invalidate any in-flight preview so its late response can't overwrite the
  // clearing state.
  revision += 1;
  s.busy = 'clearing';
  s.errorLine = null;
  renderRequested();
  try {
    const body: SettingsUiSmartTaskCancelRequest = { deviceId: s.context.deviceId };
    const response = await callApi<SettingsUiSmartTaskCancelResponse>(
      'POST',
      SETTINGS_UI_SMART_TASK_CANCEL_PATH,
      body,
    );
    if (state !== s) return;
    if (!response.ok) {
      const reason = 'reason' in response ? response.reason : undefined;
      await settleRejectedWrite(reason, SMART_TASK_EDIT_COPY.clearError);
      return;
    }
    closeSmartTaskEditor();
    refreshPlanSurface();
    requestClose();
    await showToast(SMART_TASK_EDIT_COPY.cleared, 'ok');
  } catch (error) {
    if (state === s) {
      s.busy = 'idle';
      s.clearArmed = false;
      s.errorLine = SMART_TASK_EDIT_COPY.clearError;
      renderRequested();
    }
    await logSettingsError('Failed to clear smart task', error, 'smartTaskEdit.clear');
  }
};

// The separate-meter detail state has no editor to open, but it must retain
// the existing two-step Clear action. Seed the controller on the first tap,
// then route through the same confirmation and cancel write as the editable
// lane. A matching snapshot may already exist if the device moved meters
// while its editor was open; keep it because the cancel write only needs the
// device identity.
export const beginSmartTaskClear = async (
  context: SmartTaskEditContext,
): Promise<void> => {
  if (state?.context.deviceId !== context.deviceId) {
    openSmartTaskEditor(context);
  }
  await requestSmartTaskClear();
};
