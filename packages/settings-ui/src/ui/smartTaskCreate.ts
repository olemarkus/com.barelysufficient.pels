import {
  SETTINGS_UI_SMART_TASK_CREATE_PATH,
  SETTINGS_UI_SMART_TASK_CREATE_PREVIEW_PATH,
  SETTINGS_UI_SMART_TASK_DEVICES_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import type {
  SettingsUiSmartTaskDevicesResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskUpdateResponse,
  SmartTaskCandidateDevice,
  SmartTaskCandidateRequest,
} from '../../../contracts/src/smartTaskEdit.ts';
import {
  composeSmartTaskCreateLandingLine,
  CREATE_SMART_TASK_WIDGET_COPY,
  resolveCreateSmartTaskRejectCopy,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { dispatchOpenDeviceDetail } from './cardActivation.ts';
import { buildDeadlineEditHref, buildDeadlineHref, followDeadlineHref } from './deadlineUrls.ts';
import {
  hasLoadedDeferredObjectiveSettings,
  loadDeferredObjectiveSettings,
} from './deferredObjectiveSettings.ts';
import { resolveAfterTaskLine } from './deviceStartRule.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';
import {
  parseSmartTaskGoal,
  SMART_TASK_READY_BY_PATTERN,
  toSmartTaskPreviewView,
  type SmartTaskPreviewView,
} from './smartTaskDraft.ts';
import type { SmartTaskEditPermissionKey, SmartTaskEditPermissions } from './smartTaskEdit.ts';
import { hasActiveDeadlineObjective, hasOpenSmartTask, state } from './state.ts';

// Controller for the Smart tasks page's New smart task flow: choose a device,
// set a goal and ready-by time, preview, create. It owns the flow's state and
// every request; the list orchestrator (`deadlinesList.ts`) owns the surface
// and paints the view (`views/SmartTaskCreate.tsx`) from a snapshot.
//
// It creates through the settings-UI create lane, which never replaces an open
// task: a device that has one is sent to that task instead.

const DEFAULT_READY_BY = '07:00';

/** Where the flow was opened from, and so where Back returns to. */
export type SmartTaskCreateOrigin =
  | { kind: 'smart_tasks' }
  | { kind: 'device'; deviceId: string; sourceTab: string };

export type SmartTaskCreateDraft = {
  goal: string;
  readyBy: string;
  permissions: SmartTaskEditPermissions;
};

export type SmartTaskCreateStep =
  | { kind: 'loading' }
  | { kind: 'load_error' }
  | { kind: 'pick'; devices: readonly SmartTaskCandidateDevice[]; openTaskDeviceIds: ReadonlySet<string> }
  | { kind: 'compose'; device: SmartTaskCandidateDevice; draft: SmartTaskCreateDraft }
  | {
    kind: 'preview';
    device: SmartTaskCandidateDevice;
    draft: SmartTaskCreateDraft;
    preview: SmartTaskPreviewView;
  };

export type SmartTaskCreateSnapshot = {
  origin: SmartTaskCreateOrigin;
  step: SmartTaskCreateStep;
  busy: 'idle' | 'preview' | 'create';
  errorLine: string | null;
};

/** Where Back goes from this snapshot; the view labels the button by it. */
export type SmartTaskCreateBack = 'edit_goal' | 'choose_device' | 'leave';

export const resolveSmartTaskCreateBack = (snapshot: SmartTaskCreateSnapshot): SmartTaskCreateBack => {
  if (snapshot.step.kind === 'preview') return 'edit_goal';
  if (snapshot.step.kind === 'compose' && snapshot.origin.kind === 'smart_tasks') return 'choose_device';
  return 'leave';
};

let snapshot: SmartTaskCreateSnapshot | null = null;
// The candidate list the flow loaded, kept for "Choose another device".
let loadedDevices: readonly SmartTaskCandidateDevice[] | null = null;
let generation = 0;
let paint: (current: SmartTaskCreateSnapshot | null) => void = () => {};
// Injected at boot (`initSmartTaskCreateController`): tab navigation imports
// the Smart tasks list, which imports this controller.
let openPanel: (panelId: string) => void = () => {};

/** The orchestrator's paint: the flow's surface from a snapshot, or the list once it closes. */
export const registerSmartTaskCreateRenderer = (
  renderer: (current: SmartTaskCreateSnapshot | null) => void,
): void => {
  paint = renderer;
};

export const getSmartTaskCreateSnapshot = (): SmartTaskCreateSnapshot | null => snapshot;

/**
 * Whether the flow is open for this device. The device page, opened over the
 * flow by "Change", treats such a device as one with a Smart task, and hides
 * its own Add smart task so the draft is not restarted.
 */
export const isSmartTaskCreateOpenFor = (deviceId: string): boolean => {
  const step = snapshot?.step;
  // The flow survives a tab switch, but only counts while its tab is showing:
  // a device page opened from elsewhere is not one opened over the flow.
  return state.activePanel === 'deadlines'
    && (step?.kind === 'compose' || step?.kind === 'preview')
    && step.device.deviceId === deviceId;
};

const update = (next: SmartTaskCreateSnapshot): void => {
  snapshot = next;
  paint(next);
};

const finish = (): void => {
  generation += 1;
  snapshot = null;
  loadedDevices = null;
  paint(null);
};

/** Leave the flow for the device's open task: its editor while it is in progress. */
const goToOpenTask = (deviceId: string): void => {
  finish();
  followDeadlineHref(hasActiveDeadlineObjective(deviceId)
    ? buildDeadlineEditHref(deviceId)
    : buildDeadlineHref(deviceId));
};

const initialDraft = (device: SmartTaskCandidateDevice): SmartTaskCreateDraft => ({
  goal: String(device.defaultGoal),
  readyBy: DEFAULT_READY_BY,
  permissions: { exemptFromBudget: false, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false },
});

// A device with an open task opens that task instead (`goToOpenTask`), so the
// picker says so on its row. Read when the step is entered.
const pickStep = (devices: readonly SmartTaskCandidateDevice[]): SmartTaskCreateStep => ({
  kind: 'pick',
  devices,
  openTaskDeviceIds: new Set(devices.map((device) => device.deviceId).filter((id) => hasOpenSmartTask(id))),
});

const composeStep = (
  device: SmartTaskCandidateDevice,
  draft: SmartTaskCreateDraft = initialDraft(device),
): SmartTaskCreateStep => ({ kind: 'compose', device, draft });

// An open task blocks a create, so the flow must know the stored tasks before
// it offers one. They load at boot; a boot load that failed is retried here.
const ensureStoredTasksLoaded = async (): Promise<boolean> => {
  if (!hasLoadedDeferredObjectiveSettings()) await loadDeferredObjectiveSettings();
  return hasLoadedDeferredObjectiveSettings();
};

const loadCandidates = async (origin: SmartTaskCreateOrigin): Promise<void> => {
  generation += 1;
  const current = generation;
  update({ origin, step: { kind: 'loading' }, busy: 'idle', errorLine: null });
  try {
    const [response, storedTasksLoaded] = await Promise.all([
      callApi<SettingsUiSmartTaskDevicesResponse>('GET', SETTINGS_UI_SMART_TASK_DEVICES_PATH),
      ensureStoredTasksLoaded(),
    ]);
    if (current !== generation) return;
    if (response.state !== 'ready' || !storedTasksLoaded) {
      update({ origin, step: { kind: 'load_error' }, busy: 'idle', errorLine: null });
      return;
    }
    loadedDevices = response.devices;
    if (origin.kind === 'device') {
      if (hasOpenSmartTask(origin.deviceId)) {
        goToOpenTask(origin.deviceId);
        return;
      }
      const device = response.devices.find((candidate) => candidate.deviceId === origin.deviceId);
      if (device) {
        update({ origin, step: composeStep(device), busy: 'idle', errorLine: null });
        return;
      }
    }
    update({ origin, step: pickStep(response.devices), busy: 'idle', errorLine: null });
  } catch (error) {
    if (current !== generation) return;
    update({ origin, step: { kind: 'load_error' }, busy: 'idle', errorLine: null });
    void logSettingsError('Failed to load smart task devices', error, 'smartTaskCreate');
  }
};

/** Open the flow: from the Smart tasks page, or for one device from its page. */
export const openSmartTaskCreate = (origin: SmartTaskCreateOrigin): void => {
  // The after-task line reads the device list. The Overview loads it at boot;
  // a session that opened straight into Smart tasks has not.
  if (!state.devicesLoaded) document.dispatchEvent(new CustomEvent('request-load-devices'));
  void loadCandidates(origin);
};

export const retrySmartTaskCreateLoad = (): void => {
  if (snapshot) void loadCandidates(snapshot.origin);
};

/**
 * Back: preview → compose, compose → the device list (only when the flow
 * started there), otherwise out of the flow to where it was opened from.
 */
export const backFromSmartTaskCreate = (): void => {
  const s = snapshot;
  if (!s || s.busy !== 'idle') return;
  const back = resolveSmartTaskCreateBack(s);
  if (back === 'edit_goal' && s.step.kind === 'preview') {
    update({ ...s, step: composeStep(s.step.device, s.step.draft), errorLine: null });
    return;
  }
  if (back === 'choose_device' && loadedDevices) {
    update({ ...s, step: pickStep(loadedDevices), errorLine: null });
    return;
  }
  finish();
  if (s.origin.kind === 'device') {
    openPanel(s.origin.sourceTab);
    dispatchOpenDeviceDetail(s.origin.deviceId, 'top');
  }
};

export const selectSmartTaskCreateDevice = (deviceId: string): void => {
  const s = snapshot;
  if (!s || s.step.kind !== 'pick') return;
  if (hasOpenSmartTask(deviceId)) {
    goToOpenTask(deviceId);
    return;
  }
  const device = s.step.devices.find((candidate) => candidate.deviceId === deviceId);
  if (device) update({ ...s, step: composeStep(device), errorLine: null });
};

const updateDraft = (patch: Partial<SmartTaskCreateDraft>): void => {
  const s = snapshot;
  if (!s || s.step.kind !== 'compose' || s.busy !== 'idle') return;
  update({ ...s, step: composeStep(s.step.device, { ...s.step.draft, ...patch }), errorLine: null });
};

export const setSmartTaskCreateGoal = (goal: string): void => updateDraft({ goal });
export const setSmartTaskCreateReadyBy = (readyBy: string): void => updateDraft({ readyBy });
export const setSmartTaskCreatePermission = (key: SmartTaskEditPermissionKey, value: boolean): void => {
  const s = snapshot;
  if (!s || s.step.kind !== 'compose') return;
  updateDraft({ permissions: { ...s.step.draft.permissions, [key]: value } });
};

const buildRequest = (
  device: SmartTaskCandidateDevice,
  draft: SmartTaskCreateDraft,
): SmartTaskCandidateRequest | null => {
  const target = parseSmartTaskGoal(draft.goal);
  if (!SMART_TASK_READY_BY_PATTERN.test(draft.readyBy) || target === null) return null;
  if (target < device.goalMin || target > device.goalMax) return null;
  return {
    deviceId: device.deviceId,
    kind: device.kind,
    target,
    readyByLocalTime: draft.readyBy,
    ...draft.permissions,
  };
};

// Only reached for a draft `buildRequest` refused: a valid ready-by time leaves
// the goal as the field at fault.
const invalidDraftLine = (draft: SmartTaskCreateDraft): string => (
  SMART_TASK_READY_BY_PATTERN.test(draft.readyBy)
    ? CREATE_SMART_TASK_WIDGET_COPY.invalidGoal
    : CREATE_SMART_TASK_WIDGET_COPY.invalidReadyBy
);

export const requestSmartTaskCreatePreview = async (): Promise<void> => {
  const s = snapshot;
  if (!s || s.step.kind !== 'compose' || s.busy !== 'idle') return;
  const { device, draft } = s.step;
  const request = buildRequest(device, draft);
  if (!request) {
    update({ ...s, errorLine: invalidDraftLine(draft) });
    return;
  }
  const current = generation;
  update({ ...s, busy: 'preview', errorLine: null });
  try {
    const response = await callApi<SettingsUiSmartTaskPreviewResponse>(
      'POST', SETTINGS_UI_SMART_TASK_CREATE_PREVIEW_PATH, request,
    );
    if (current !== generation) return;
    if (!response.ok) {
      if (response.reason === 'task_exists') {
        goToOpenTask(device.deviceId);
        return;
      }
      update({ ...s, busy: 'idle', errorLine: resolveCreateSmartTaskRejectCopy(response.reason) });
      return;
    }
    const preview = toSmartTaskPreviewView(response, composeSmartTaskCreateLandingLine({
      scheduledWindowLabel: response.scheduledWindowLabel,
      deadlineLabel: response.deadlineLabel,
    }));
    update({ ...s, step: { kind: 'preview', device, draft, preview }, busy: 'idle', errorLine: null });
  } catch (error) {
    if (current !== generation) return;
    update({ ...s, busy: 'idle', errorLine: CREATE_SMART_TASK_WIDGET_COPY.createError });
    void logSettingsError('Failed to preview new smart task', error, 'smartTaskCreate');
  }
};

export const submitSmartTaskCreate = async (): Promise<void> => {
  const s = snapshot;
  if (!s || s.step.kind !== 'preview' || s.busy !== 'idle') return;
  const { device, draft, preview } = s.step;
  const request = buildRequest(device, draft);
  if (!request) return;
  const current = generation;
  update({ ...s, busy: 'create', errorLine: null });
  try {
    // Echo the deadline the preview showed, so the task is saved for exactly
    // the moment the owner confirmed.
    const response = await callApi<SettingsUiSmartTaskUpdateResponse>(
      'POST', SETTINGS_UI_SMART_TASK_CREATE_PATH, { ...request, deadlineAtMs: preview.deadlineAtMs },
    );
    if (current !== generation) return;
    if (!response.ok) {
      if (response.reason === 'task_exists') {
        goToOpenTask(device.deviceId);
        return;
      }
      // A ready-by time that has passed since the preview needs a new one.
      const step = response.reason === 'deadline_passed' ? composeStep(device, draft) : s.step;
      update({ ...s, step, busy: 'idle', errorLine: resolveCreateSmartTaskRejectCopy(response.reason) });
      return;
    }
    finish();
    refreshPlanSurface();
    followDeadlineHref(buildDeadlineHref(device.deviceId));
  } catch (error) {
    if (current !== generation) return;
    update({ ...s, busy: 'idle', errorLine: CREATE_SMART_TASK_WIDGET_COPY.createError });
    void logSettingsError('Failed to create smart task', error, 'smartTaskCreate');
  }
};

/**
 * Who starts the device once the task is done (`deviceStartRule.ts`), or
 * `null` for a device the rule does not cover, or while the device list or a
 * setting it reads has not loaded.
 */
export const resolveSmartTaskCreateAfterTaskLine = (deviceId: string): string | null => {
  const device = state.latestDevices.find((candidate) => candidate.id === deviceId);
  return device ? resolveAfterTaskLine(device) : null;
};

/**
 * "Change": the device page opens over the flow, on Power-limit control, and
 * the flow repaints when it closes (`device-detail-closed`), with the draft kept.
 */
export const openSmartTaskCreateDeviceSettings = (): void => {
  const s = snapshot;
  if (!s || (s.step.kind !== 'compose' && s.step.kind !== 'preview')) return;
  dispatchOpenDeviceDetail(s.step.device.deviceId, 'power-limit');
};

type OpenSmartTaskCreateDetail = { deviceId: string; sourceTab: string };

/** The device page's Add smart task: open the flow for that device on the Smart tasks tab. */
export const dispatchOpenSmartTaskCreate = (deviceId: string, sourceTab: string): void => {
  document.dispatchEvent(new CustomEvent<OpenSmartTaskCreateDetail>(
    'open-smart-task-create',
    { detail: { deviceId, sourceTab } },
  ));
};

const repaint = (): void => {
  if (snapshot) paint(snapshot);
};

let listenersBound = false;

/**
 * Bind the flow's document listeners: the device page's Add smart task, and the
 * repaints when what the after-task line reads may have changed.
 */
export const initSmartTaskCreateController = (navigateToPanel: (panelId: string) => void): void => {
  openPanel = navigateToPanel;
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('open-smart-task-create', (event) => {
    const { deviceId, sourceTab } = (event as CustomEvent<OpenSmartTaskCreateDetail>).detail;
    openPanel('deadlines');
    openSmartTaskCreate({ kind: 'device', deviceId, sourceTab });
  });
  document.addEventListener('device-detail-closed', repaint);
  document.addEventListener('devices-updated', repaint);
};
