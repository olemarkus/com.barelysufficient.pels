import { SETTINGS_UI_SMART_TASK_DEVICES_PATH } from '../../../../contracts/src/settingsUiApi.ts';
import type {
  DeferredObjectiveSettingsEntry,
} from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type { SettingsUiSmartTaskDevicesResponse } from '../../../../contracts/src/smartTaskEdit.ts';
import {
  deadlineLabels,
  formatSmartTaskGoalValue,
  SMART_TASK_CREATE_PAGE_COPY,
  SMART_TASK_LIST_ROW_LABELS,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { resolveObjectiveTargetValue } from '../../../../shared-domain/src/deferredObjectiveValues.ts';
import { formatSmartTaskListDateTime } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { resolveBrowserTimeZone } from '../deadlinePlanHistoryFetch.ts';
import { hasLoadedDeferredObjectiveSettings } from '../deferredObjectiveSettings.ts';
import { callApi } from '../homey.ts';
import { isSmartTaskCreateOpenFor } from '../smartTaskCreate.ts';
import { hasOpenSmartTask, state } from '../state.ts';

/**
 * The device page's Smart task box, at the end of the page: the device's open
 * task with a link to it, or an Add smart task action when the device can carry
 * one. Most homes never use Smart tasks, so the box stays quiet: it shows
 * nothing until it has something to offer, and nothing when the check fails.
 *
 * The open task comes from `state.deferredObjectiveSettings`, which the
 * settings-change router keeps current, so the box repaints on every plan push
 * without a request. Whether the device can carry a task is the app's candidate
 * list, read once per open of the device page and again when the device's
 * Managed setting changes, which is what puts a device on that list.
 */

type CandidateRead =
  | { state: 'loading' }
  | { state: 'resolved'; deviceIds: ReadonlySet<string> }
  | { state: 'unavailable' };

// The read this box holds, and the device and Managed state it was read for.
let candidates: { deviceId: string; managed: boolean; read: CandidateRead } | null = null;
let readGeneration = 0;

const box = (): HTMLElement | null => document.getElementById('device-detail-smart-task');

const paint = (body: string, action: HTMLElement): void => {
  const root = box();
  if (!root) return;
  const heading = document.createElement('h3');
  heading.className = 'pels-text-card-title';
  heading.textContent = SMART_TASK_CREATE_PAGE_COPY.boxTitle;
  const supporting = document.createElement('p');
  supporting.className = 'pels-card-supporting';
  supporting.textContent = body;
  root.replaceChildren(heading, supporting, action);
  root.hidden = false;
};

const hide = (): void => {
  const root = box();
  if (root) root.hidden = true;
};

export const hideDeviceSmartTaskBox = (): void => {
  readGeneration += 1;
  candidates = null;
  hide();
};

const textButton = (label: string, data: Record<string, string>): HTMLElement => {
  const button = document.createElement('md-text-button');
  button.textContent = label;
  Object.assign(button.dataset, data);
  return button;
};

const paintOpenTask = (deviceId: string, entry: DeferredObjectiveSettingsEntry): void => {
  const goal = formatSmartTaskGoalValue(resolveObjectiveTargetValue(entry), deadlineLabels(entry.kind).targetUnit);
  const readyBy = formatSmartTaskListDateTime(entry.deadlineAtMs, resolveBrowserTimeZone());
  paint(
    `${SMART_TASK_LIST_ROW_LABELS.target} ${goal} · ${SMART_TASK_LIST_ROW_LABELS.readyBy} ${readyBy}`,
    textButton(SMART_TASK_CREATE_PAGE_COPY.viewTask, { smartTaskView: deviceId }),
  );
};

const readCandidates = async (deviceId: string, managed: boolean): Promise<void> => {
  readGeneration += 1;
  const generation = readGeneration;
  candidates = { deviceId, managed, read: { state: 'loading' } };
  let read: CandidateRead;
  try {
    const response = await callApi<SettingsUiSmartTaskDevicesResponse>('GET', SETTINGS_UI_SMART_TASK_DEVICES_PATH);
    read = response.state === 'ready'
      ? { state: 'resolved', deviceIds: new Set(response.devices.map((device) => device.deviceId)) }
      : { state: 'unavailable' };
  } catch {
    read = { state: 'unavailable' };
  }
  if (generation !== readGeneration) return;
  candidates = { deviceId, managed, read };
  renderDeviceSmartTaskBox(deviceId);
};

export const renderDeviceSmartTaskBox = (deviceId: string): void => {
  // Until the stored tasks have loaded, an empty map reads like a device with
  // no task, which would offer Add over a task the page cannot see yet. While
  // the device's first task is being created (the page was opened over the
  // New smart task flow), Add would restart that draft.
  if (!hasLoadedDeferredObjectiveSettings() || isSmartTaskCreateOpenFor(deviceId)) {
    hide();
    return;
  }
  const entry = state.deferredObjectiveSettings.objectivesByDeviceId[deviceId];
  if (entry && hasOpenSmartTask(deviceId)) {
    paintOpenTask(deviceId, entry);
    return;
  }
  const managed = state.managedMap[deviceId] === true;
  if (candidates?.deviceId !== deviceId || candidates.managed !== managed) {
    hide();
    void readCandidates(deviceId, managed);
    return;
  }
  if (candidates.read.state === 'resolved' && candidates.read.deviceIds.has(deviceId)) {
    paint(
      SMART_TASK_CREATE_PAGE_COPY.addTaskHint,
      textButton(SMART_TASK_CREATE_PAGE_COPY.addTask, { smartTaskCreate: deviceId }),
    );
    return;
  }
  hide();
};
