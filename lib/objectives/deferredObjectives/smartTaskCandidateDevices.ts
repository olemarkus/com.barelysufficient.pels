import type { CreateSmartTaskCandidateDevice } from '../../../packages/contracts/src/widgetHostApi';
import type { SmartTaskCandidateDevice } from '../../../packages/contracts/src/smartTaskEdit';
import {
  resolveSmartTaskCurrentValue,
  resolveSmartTaskDefaultGoal,
  resolveDefaultSmartTaskKind,
  resolveSmartTaskGoalBounds,
  supportsSmartTaskKind,
} from '../../../packages/shared-domain/src/smartTaskDeviceKind';
import { deviceSupportsLimitLowerPriority } from './limitGrantGate';
import {
  compareSmartTaskPickerRows,
  resolveSmartTaskDeviceGroup,
} from '../../../packages/shared-domain/src/smartTaskDevicePickerOrder';

const buildCandidateDevice = (
  // The host's candidate type, which carries the observed SoC bag
  // `resolveSmartTaskCurrentValue` reads (without it this parameter has no such
  // property, so a shape change there compiles silently, which is how the goal
  // stepper came to seed EV chargers from `null`) and the resolved identity the
  // kind gate reads.
  device: CreateSmartTaskCandidateDevice,
): SmartTaskCandidateDevice | null => {
  const kind = resolveDefaultSmartTaskKind(device);
  // The creation gate every path asks: an energy task also needs a live power
  // reading to count its progress from.
  if (kind === null || !supportsSmartTaskKind(device, kind)) return null;
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
    // Gate-on-effect: the limit-lower-priority permission is inert on a binary
    // device (no higher step to promote to), so the compose toggle is offered
    // only where the write's own gate keeps the grant (preview ≡ persist).
    // Deliberately NOT gated on `priority === 1`: limiting lower-priority
    // devices helps at any priority, and swap selection already refuses
    // anything not strictly lower.
    supportsLimitLowerPriority: deviceSupportsLimitLowerPriority(device),
  };
};

/**
 * The devices a smart task can be created on, as both creation surfaces list
 * them: the New smart task widget and the settings UI's Smart tasks page. One
 * row per device a task can be created on now, grouped by device family (heating
 * devices, then EV chargers) and by name within each group, so the list reads
 * as deliberately organised rather than an arbitrary alphabetical mix.
 */
export const buildSmartTaskCandidateDevices = (
  devices: readonly CreateSmartTaskCandidateDevice[],
): SmartTaskCandidateDevice[] => devices
  .map(buildCandidateDevice)
  .filter((device): device is SmartTaskCandidateDevice => device !== null)
  .sort((a, b) => compareSmartTaskPickerRows(
    { group: resolveSmartTaskDeviceGroup(a), deviceName: a.deviceName },
    { group: resolveSmartTaskDeviceGroup(b), deviceName: b.deviceName },
  ));
