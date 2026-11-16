import { SETTINGS_UI_SMART_TASK_DEVICES_PATH } from '../../../../contracts/src/settingsUi/paths.ts';
import type {
  DeferredObjectiveSettingsEntry,
} from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type { SettingsUiSmartTaskDevicesResponse } from '../../../../contracts/src/smartTaskEdit.ts';
import { SMART_TASK_CREATE_PAGE_COPY } from '../../../../shared-domain/src/smartTaskCopy/createEditCopy.ts';
import { hasLoadedDeferredObjectiveSettings } from '../deferredObjectiveSettings.ts';
import { resolveOverrideSmartTaskBoxNote } from '../deviceOverrideDraft.ts';
import { DEVICE_OVERRIDE_CHANGED_EVENT, getActiveDeviceOverride } from '../deviceOverrideStore.ts';
import { callApi } from '../homey.ts';
import { isSmartTaskCreateOpenFor } from '../smartTaskCreate.ts';
import { formatOpenSmartTaskLine } from '../smartTaskSummary.ts';
import { hasOpenSmartTask, state } from '../state.ts';

/**
 * The Smart task row of the device page's Temporary card (`temporaryCard.ts`):
 * the device's open task with a way to it, or adding one when the device can
 * carry a task. The row is absent until it has something to offer, and when the
 * check fails. This module holds the row's state; the card paints it.
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
// The device whose page the box is on, while that page is open.
let shownDeviceId: string | null = null;

/** The device's open task, or the offer to add one. */
export type DeviceSmartTaskRow =
  | { kind: 'open'; deviceId: string; line: string }
  | { kind: 'add'; deviceId: string; line: string };

let row: DeviceSmartTaskRow | null = null;
let notify: () => void = () => {};

/** The Smart task row for the open device, or `null` when it has none. */
export const getDeviceSmartTaskRow = (): DeviceSmartTaskRow | null => row;

/** Called whenever the row changes. */
export const onDeviceSmartTaskRowChange = (listener: () => void): void => { notify = listener; };

const show = (next: DeviceSmartTaskRow | null): void => {
  row = next;
  notify();
};

const hide = (): void => show(null);

export const hideDeviceSmartTaskBox = (): void => {
  shownDeviceId = null;
  readGeneration += 1;
  candidates = null;
  hide();
};

const paintOpenTask = (deviceId: string, entry: DeferredObjectiveSettingsEntry): void => {
  const line = formatOpenSmartTaskLine(entry);
  const override = getActiveDeviceOverride(deviceId, Date.now());
  show({
    kind: 'open', deviceId,
    line: override ? `${line} · ${resolveOverrideSmartTaskBoxNote(override.untilMs, entry.deadlineAtMs)}` : line,
  });
};

/** Reuse the device page's server-resolved eligibility for charger settings. */
export const isDeviceSmartTaskCandidate = (deviceId: string): boolean => {
  const managed = state.managedMap[deviceId] === true;
  if (!managed) return false;
  if (candidates?.deviceId !== deviceId || candidates.managed !== managed) {
    void readCandidates(deviceId, managed);
    return false;
  }
  return candidates.read.state === 'resolved' && candidates.read.deviceIds.has(deviceId);
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
  document.dispatchEvent(new Event('device-smart-task-candidates-changed'));
  renderDeviceSmartTaskBox(deviceId);
};

export const renderDeviceSmartTaskBox = (deviceId: string): void => {
  shownDeviceId = deviceId;
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
    show({ kind: 'add', deviceId, line: SMART_TASK_CREATE_PAGE_COPY.addTaskHint });
    return;
  }
  hide();
};

// The open task's line says when an override holds the device, so it follows
// the override's reads and writes.
document.addEventListener(DEVICE_OVERRIDE_CHANGED_EVENT, (event) => {
  const { deviceId } = (event as CustomEvent<{ deviceId: string }>).detail;
  if (shownDeviceId === deviceId) renderDeviceSmartTaskBox(deviceId);
});
