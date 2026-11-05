import type Homey from 'homey';
import type {
  SettingsUiSmartTaskCancelResponse,
  SettingsUiSmartTaskDevicesResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskUpdateResponse,
} from '../packages/contracts/src/smartTaskEdit';
import { buildSmartTaskCandidateDevices } from '../lib/objectives/deferredObjectives';
import { readPelsHost } from '../lib/app/pelsHost';
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

// Both lanes' ports: the running app (null during the boot window), the stored
// tasks, and the Homey clock.
const lanePorts = (homey: Homey.App['homey']): SmartTaskCreateLanePorts & SmartTaskEditLanePorts => ({
  host: readPelsHost(homey),
  store: homey.settings,
  clock: homey.clock,
});

export const previewSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => previewSmartTaskEdit(lanePorts(homey), body);

export const updateSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => updateSmartTask(lanePorts(homey), body);

export const cancelSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskCancelResponse => cancelSmartTask(lanePorts(homey), body);

export const getSettingsUiSmartTaskDevices = (
  { homey }: ApiContext,
): SettingsUiSmartTaskDevicesResponse => {
  const host = readPelsHost(homey);
  if (!host) return { state: 'unavailable' };
  const read = host.getCreateSmartTaskCandidateDevices();
  if (read.state !== 'ready') return { state: 'unavailable' };
  return { state: 'ready', devices: buildSmartTaskCandidateDevices(read.devices) };
};

export const previewSettingsUiNewSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => previewNewSmartTask(lanePorts(homey), body);

export const createSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => createNewSmartTask(lanePorts(homey), body);
