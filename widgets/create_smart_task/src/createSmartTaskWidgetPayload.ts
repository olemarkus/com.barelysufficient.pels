import type { CreateSmartTaskCandidateDevice } from '../../../packages/contracts/src/widgetHostApi';
import {
  CREATE_SMART_TASK_WIDGET_COPY,
} from '../../../packages/shared-domain/src/deadlineLabels';
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
  const devices = buildSmartTaskCandidateDevices(input.devices)
    // Energy tasks are created from the "Add energy task" Flow card or the
    // Smart tasks page, not here: the widget's picker, preview and goal stepper
    // are shaped for a level to reach, not an amount to deliver.
    .filter((device) => device.kind !== 'energy');

  if (devices.length === 0) {
    return { state: 'empty', subtitle: EMPTY_NO_DEVICES_SUBTITLE, hint: EMPTY_NO_DEVICES_HINT };
  }
  return { state: 'ready', devices };
};
