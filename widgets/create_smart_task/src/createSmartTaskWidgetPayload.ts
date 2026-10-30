import type { CreateSmartTaskCandidateDevice } from '../../../packages/contracts/src/widgetHostApi';
import {
  CREATE_SMART_TASK_WIDGET_COPY,
} from '../../../packages/shared-domain/src/smartTaskCopy/createEditCopy';
import { buildSmartTaskCandidateDevices } from '../../../lib/objectives/deferredObjectives/smartTaskCandidateDevices';
import type {
  CreateSmartTaskDevicesPayload,
} from './createSmartTaskWidgetTypes';

// Re-export under widget-local names so the renderer/tests keep a stable import
// surface; the strings themselves are sourced from shared-domain so runtime
// logging and the widget render identical copy.
export const EMPTY_NO_DEVICES_SUBTITLE = CREATE_SMART_TASK_WIDGET_COPY.emptyNoDevices;
export const EMPTY_NO_DEVICES_HINT = CREATE_SMART_TASK_WIDGET_COPY.emptyNoDevicesHint;

export type CreateSmartTaskWidgetInput = {
  devices: ReadonlyArray<CreateSmartTaskCandidateDevice>;
};

export const buildCreateSmartTaskDevicesPayload = (
  input: CreateSmartTaskWidgetInput,
): CreateSmartTaskDevicesPayload => {
  const chargerIds = new Set(input.devices.filter((device) => device.isEvCharger).map((device) => device.id));
  const devices = buildSmartTaskCandidateDevices(input.devices)
    // A relay's energy task is created from the "Add energy task" Flow card or
    // the Smart tasks page, not here: with no quick targets it would open on a
    // bare kWh stepper. A plugged-in charger with no battery level is offered
    // energy quick targets (`resolveSmartTaskCreationKind`), so it stays.
    .filter((device) => device.kind !== 'energy' || chargerIds.has(device.deviceId));

  if (devices.length === 0) {
    return { state: 'empty', subtitle: EMPTY_NO_DEVICES_SUBTITLE, hint: EMPTY_NO_DEVICES_HINT };
  }
  return { state: 'ready', devices };
};
