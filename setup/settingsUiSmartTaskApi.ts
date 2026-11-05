import type {
  SettingsUiSmartTaskCancelResponse,
  SettingsUiSmartTaskDevicesResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskUpdateResponse,
} from '../packages/contracts/src/smartTaskEdit';
import type { HomeyRuntime } from '../lib/ports/homeyRuntime';
import { readPelsHost } from '../lib/app/pelsHost';
import { readSmartTaskCandidateDevices } from '../lib/objectives/deferredObjectives/smartTaskCandidateDevices';
import {
  createNewSmartTask, previewNewSmartTask,
} from '../lib/objectives/deferredObjectives/smartTaskCreateLane';
import {
  cancelSmartTask, previewSmartTaskEdit, updateSmartTask,
} from '../lib/objectives/deferredObjectives/smartTaskEditLane';

type ApiContext = {
  homey: HomeyRuntime & { app?: unknown; clock: { getTimezone(): string } };
};

// All request lanes share the same startup host, settings store and clock.
const requestPorts = (homey: ApiContext['homey']) => ({
  host: readPelsHost(homey),
  store: homey.settings,
  clock: homey.clock,
});

export const previewSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => previewSmartTaskEdit(requestPorts(homey), body);

export const updateSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => updateSmartTask(requestPorts(homey), body);

export const cancelSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskCancelResponse => cancelSmartTask(requestPorts(homey), body);

export const getSettingsUiSmartTaskDevices = (
  { homey }: ApiContext,
): SettingsUiSmartTaskDevicesResponse => readSmartTaskCandidateDevices(readPelsHost(homey));

export const previewSettingsUiNewSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => previewNewSmartTask(requestPorts(homey), body);

export const createSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => createNewSmartTask(requestPorts(homey), body);
