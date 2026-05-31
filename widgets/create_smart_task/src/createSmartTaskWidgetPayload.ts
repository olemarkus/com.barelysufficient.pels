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
import {
  compareSmartTaskPickerRows,
  resolveSmartTaskDeviceGroup,
} from '../../../packages/shared-domain/src/smartTaskDevicePickerOrder';
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
    group: resolveSmartTaskDeviceGroup({ kind }),
    unitSymbol: bounds.unit,
    goalMin: bounds.min,
    goalMax: bounds.max,
    goalStep: bounds.step,
    defaultGoal: resolveSmartTaskDefaultGoal({ kind, bounds, currentValue }),
    currentValue,
    // Gate-on-effect: the limit-lower-priority permission only changes the plan
    // for a stepped-load device at top priority (the planner's `fullyReserved`
    // floor is `priority === 1`). The stepped predicate mirrors app.ts
    // `deviceSupportsLimitLowerPriority`; the extra `priority === 1` keeps the
    // compose toggle from ever being offered where it would be a no-op.
    supportsLimitLowerPriority:
      device.controlModel === 'stepped_load'
      && device.steppedLoadProfile?.model === 'stepped_load'
      && device.priority === 1,
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
    // Group by device family (heating devices → EV chargers), then by name
    // within each group, so the managed-device subset reads as a deliberately
    // organised list rather than an arbitrary alphabetical mix.
    .sort(compareSmartTaskPickerRows);

  if (devices.length === 0) {
    return { state: 'empty', subtitle: EMPTY_NO_DEVICES_SUBTITLE, hint: EMPTY_NO_DEVICES_HINT };
  }
  return { state: 'ready', devices };
};
