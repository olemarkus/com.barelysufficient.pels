import type {
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from '../../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../../packages/shared-domain/src/steppedLoadObservedState';
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

const buildDevice = (device: TargetDeviceSnapshot & SteppedLoadDescriptorProbe): CreateSmartTaskDevice | null => {
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
    // Gate-on-effect: the limit-lower-priority permission is inert on a binary
    // device (no higher step to promote to), so the compose toggle is offered
    // only for stepped-load devices. Mirrors
    // `AppSmartTaskApi.deviceSupportsLimitLowerPriority` exactly so the client's
    // visibility and the server's gate agree (preview ≡ persist). Deliberately
    // NOT gated on `priority === 1`: limiting lower-priority devices helps at any
    // priority, and swap selection already refuses anything not strictly lower.
    supportsLimitLowerPriority:
      device.controlModel === 'stepped_load'
      && isSteppedLoadSnapshot(device),
  };
};

export type CreateSmartTaskWidgetInput = {
  devices: ReadonlyArray<TargetDeviceSnapshot & SteppedLoadDescriptorProbe>;
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
