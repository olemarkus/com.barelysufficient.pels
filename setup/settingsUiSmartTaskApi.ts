import type Homey from 'homey';
import type {
  SettingsUiSmartTaskCancelResponse,
  SettingsUiSmartTaskDevicesResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskRejectReason,
  SettingsUiSmartTaskUpdateResponse,
} from '../packages/contracts/src/smartTaskEdit';
import { buildSmartTaskCandidateDevices } from '../lib/objectives/deferredObjectives';
import { readPelsHost, type PelsHost } from '../lib/app/pelsHost';
import {
  createNewSmartTask,
  previewNewSmartTask,
  type SmartTaskCreateLanePorts,
} from '../lib/objectives/deferredObjectives/smartTaskCreateLane';
import {
  cancelSmartTask,
  previewSmartTaskEdit,
  updateSmartTask,
  type SmartTaskEditLanePorts,
} from '../lib/objectives/deferredObjectives/smartTaskEditLane';

// Settings-UI smart-task lanes: create (the Smart tasks page and the device
// page's Add smart task) and edit + clear (the task's detail page). Both are
// decided in `lib/objectives/deferredObjectives/` (`smartTaskCreateLane.ts`,
// `smartTaskEditLane.ts`) and only bound and forwarded here. Unlike the
// create_smart_task widget, create never replaces an open task: a device that
// has one answers `task_exists`, and the page offers that task instead.

type ApiContext = {
  homey: Homey.App['homey'];
};

const previewReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskPreviewResponse => ({
  ok: false,
  reason,
});

const updateReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskUpdateResponse => ({
  ok: false,
  reason,
});

// The edit lane's ports: the running app (null during the boot window), the
// stored tasks, and the Homey clock.
const editLanePorts = (homey: Homey.App['homey']): SmartTaskEditLanePorts => ({
  host: readPelsHost(homey),
  store: homey.settings,
  clock: homey.clock,
});

export const previewSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => previewSmartTaskEdit(editLanePorts(homey), body);

export const updateSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => updateSmartTask(editLanePorts(homey), body);

export const cancelSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskCancelResponse => cancelSmartTask(editLanePorts(homey), body);

export const getSettingsUiSmartTaskDevices = (
  { homey }: ApiContext,
): SettingsUiSmartTaskDevicesResponse => {
  const host = readPelsHost(homey);
  if (!host) return { state: 'unavailable' };
  const read = host.getCreateSmartTaskCandidateDevices();
  if (read.state !== 'ready') return { state: 'unavailable' };
  return { state: 'ready', devices: buildSmartTaskCandidateDevices(read.devices) };
};

// The create lane's ports: the running app, the stored tasks, and the Homey
// clock (`lib/objectives/deferredObjectives/smartTaskCreateLane.ts` decides).
const createLanePorts = (homey: Homey.App['homey'], host: PelsHost): SmartTaskCreateLanePorts => ({
  host,
  store: homey.settings,
  clock: homey.clock,
});

export const previewSettingsUiNewSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => {
  const host = readPelsHost(homey);
  if (!host) return previewReject('unavailable');
  return previewNewSmartTask(createLanePorts(homey, host), body);
};

export const createSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => {
  const host = readPelsHost(homey);
  if (!host) return updateReject('unavailable');
  return createNewSmartTask(createLanePorts(homey, host), body);
};
