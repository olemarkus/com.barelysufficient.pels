import { h, render } from 'preact';
import type { SettingsUiDevicesPayload } from '../../../../contracts/src/settingsUi/devices.ts';
import { SETTINGS_UI_DEVICES_PATH } from '../../../../contracts/src/settingsUi/paths.ts';
import { scheduleActionDeviceId } from '../../../../shared-domain/src/settings/schedules.ts';
import { DEVICE_OVERRIDE_CHANGED_EVENT } from '../deviceOverrideStore.ts';
import { callApi } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { resolveManagedState } from '../state.ts';
import {
  DeviceTemporaryCard, type TemporarySchedulesRow, type TemporarySmartTaskRow,
} from '../views/DeviceTemporaryCard.tsx';
import {
  deviceOverrideCardActions, getDeviceOverrideCardState, getDeviceOverrideScheduleLink,
  hideDeviceOverrideCard, onDeviceOverrideCardChange, renderDeviceOverrideCard,
} from './overrideCard.ts';
import {
  getDeviceSmartTaskRow, hideDeviceSmartTaskBox, isDeviceSmartTaskCandidate, onDeviceSmartTaskRowChange,
  renderDeviceSmartTaskBox,
} from './smartTaskBox.ts';

/**
 * The device page's Temporary card, directly under the status header: the
 * device's override, its Smart task and its schedules, the things that apply
 * for a limited time and end by themselves. Each row's state lives with its own
 * module (`overrideCard.ts`, `smartTaskBox.ts`); this one reads the device's
 * schedules and paints the three together. The card is hidden while it has no
 * row to show.
 */
type ScheduleCount = {
  deviceId: string;
  count: number;
  nextLabel: string;
  /** Schedules that are switched on and have a trigger left. */
  live: number;
  /** Of those, the ones the schedule owner says cannot run. */
  needsAttention: number;
};

let deviceId: string | null = null;
let schedules: ScheduleCount | null = null;
let readGeneration = 0;

const root = (): HTMLElement | null => document.getElementById('device-detail-temporary');

const smartTaskRow = (): TemporarySmartTaskRow | null => {
  const row = getDeviceSmartTaskRow();
  if (row === null) return null;
  return row.kind === 'open' ? row : { kind: 'add', deviceId: row.deviceId };
};

/** Offered for a device a schedule can act on, and for one that already has schedules. */
const schedulesRow = (current: string): TemporarySchedulesRow | null => {
  if (schedules?.deviceId !== current) return null;
  if (schedules.count === 0 && !isDeviceSmartTaskCandidate(current)) return null;
  return { ...schedules, managed: resolveManagedState(current), override: getDeviceOverrideScheduleLink() };
};

const paint = (): void => {
  const el = root();
  if (!el) return;
  if (deviceId === null) {
    el.hidden = true;
    return;
  }
  const props = {
    override: getDeviceOverrideCardState(), smartTask: smartTaskRow(), schedules: schedulesRow(deviceId),
    actions: deviceOverrideCardActions,
  };
  if (props.override === null && props.smartTask === null && props.schedules === null) {
    el.hidden = true;
    return;
  }
  render(h(DeviceTemporaryCard, props), el);
  el.hidden = false;
};

const readDeviceSchedules = async (current: string): Promise<void> => {
  readGeneration += 1;
  const generation = readGeneration;
  let next: ScheduleCount | null = null;
  try {
    // Schedules ride the devices payload for the Main home only; a meter area
    // has none to show, which is not a failure.
    const { schedules: read } = await callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH);
    if (read?.ok === true) {
      const entries = read.data.entries
        .filter((entry) => scheduleActionDeviceId(entry.schedule.action) === current);
      const due = entries.filter((entry) => entry.nextAtMs !== null)
        .sort((left, right) => (left.nextAtMs ?? 0) - (right.nextAtMs ?? 0))[0];
      next = {
        deviceId: current, count: entries.length, nextLabel: due?.nextLabel ?? '',
        live: entries.filter((entry) => entry.state !== 'off' && entry.state !== 'finished').length,
        needsAttention: entries.filter((entry) => entry.state === 'invalid').length,
      };
    }
  } catch (error) {
    void logSettingsError('Failed to read device schedules', error, 'device temporary card');
  }
  if (generation !== readGeneration || deviceId !== current) return;
  schedules = next;
  paint();
};

/** Paint the card for a device; a different device reads its schedules afresh. */
export const renderDeviceTemporaryCard = (current: string): void => {
  if (deviceId !== current) {
    deviceId = current;
    schedules = null;
    void readDeviceSchedules(current);
  }
  renderDeviceSmartTaskBox(current);
  renderDeviceOverrideCard(current);
  paint();
};

export const hideDeviceTemporaryCard = (): void => {
  readGeneration += 1;
  deviceId = null;
  schedules = null;
  hideDeviceSmartTaskBox();
  hideDeviceOverrideCard();
  paint();
};

onDeviceOverrideCardChange(paint);
onDeviceSmartTaskRowChange(paint);
// The Schedules row follows the app's list of schedulable devices, read by the Smart task row.
document.addEventListener('device-smart-task-candidates-changed', paint);
document.addEventListener(DEVICE_OVERRIDE_CHANGED_EVENT, paint);
