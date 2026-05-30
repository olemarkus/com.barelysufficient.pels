import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import {
  CREATE_SMART_TASK_WIDGET_COPY,
} from '../../../packages/shared-domain/src/deadlineLabels';
import {
  resolveSmartTaskCurrentValue,
  resolveSmartTaskDefaultGoal,
  resolveSmartTaskDeviceKind,
  resolveSmartTaskGoalBounds,
} from '../../../packages/shared-domain/src/smartTaskDeviceKind';
import type {
  CreateSmartTaskDevice,
  CreateSmartTaskDevicesPayload,
} from './createSmartTaskWidgetTypes';

// Re-export under widget-local names so the renderer/tests keep a stable import
// surface; the strings themselves are sourced from shared-domain so runtime
// logging and the widget render identical copy.
export const EMPTY_NO_DEVICES_SUBTITLE = CREATE_SMART_TASK_WIDGET_COPY.emptyNoDevices;
export const EMPTY_NO_DEVICES_HINT = CREATE_SMART_TASK_WIDGET_COPY.emptyNoDevicesHint;

const buildDevice = (device: TargetDeviceSnapshot): CreateSmartTaskDevice | null => {
  const kind = resolveSmartTaskDeviceKind(device);
  if (kind === null) return null;
  const bounds = resolveSmartTaskGoalBounds(device, kind);
  const currentValue = resolveSmartTaskCurrentValue(device, kind);
  const name = device.name?.trim();
  return {
    deviceId: device.id,
    deviceName: name && name.length > 0 ? name : device.id,
    kind,
    unitSymbol: bounds.unit,
    goalMin: bounds.min,
    goalMax: bounds.max,
    goalStep: bounds.step,
    defaultGoal: resolveSmartTaskDefaultGoal({ kind, bounds, currentValue }),
    currentValue,
  };
};

export type CreateSmartTaskWidgetInput = {
  devices: ReadonlyArray<TargetDeviceSnapshot>;
};

export const buildCreateSmartTaskDevicesPayload = (
  input: CreateSmartTaskWidgetInput,
): CreateSmartTaskDevicesPayload => {
  const devices = input.devices
    .map(buildDevice)
    .filter((device): device is CreateSmartTaskDevice => device !== null)
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName));

  if (devices.length === 0) {
    return { state: 'empty', subtitle: EMPTY_NO_DEVICES_SUBTITLE, hint: EMPTY_NO_DEVICES_HINT };
  }
  return { state: 'ready', devices };
};
