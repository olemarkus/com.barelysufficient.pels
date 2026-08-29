import type { DeviceControlModel } from '../packages/contracts/src/types';

/**
 * What the per-device "Disable temperature control" setting denies, in one
 * place.
 *
 * The setting names ONE axis: anything PELS would write to the
 * `target_temperature` capability. `temperature_target` is that axis by name, so
 * a flagged device falls back to its binary axis. `stepped_load` and
 * `binary_power` are different axes and survive untouched — a stepped water
 * heater whose setpoint another Flow owns keeps its ladder and can still be
 * trimmed to a lower rung instead of only being switched off.
 *
 * Owner ruling: the flag is about the capability, not about the device. Price,
 * boost, modes, smart tasks and shed-by-setpoint are all denied because each of
 * them writes that capability; step and binary control are not.
 *
 * This module exists so the decorator (`decorateSnapshotWithDeviceControl`) and
 * the plan projection (`projectEffectiveControlDevice` in `appInit/toPlanDevice`)
 * resolve the denial through ONE function. They used to hold independent copies
 * of the rewrite, and the copies disagreed: the plan side also wiped the stepped
 * cluster, `targetPowerConfig` and `controlAdapter`.
 */
export const resolveTemperatureDeniedControlModel = (
  controlModel: DeviceControlModel | undefined,
): DeviceControlModel | undefined => (
  controlModel === 'temperature_target' ? 'binary_power' : controlModel
);

/**
 * The device as everything downstream of control resolution should see it.
 *
 * A flagged device comes out as a PLAIN non-temperature device: no target axis,
 * no temperature facet, `deviceType: 'onoff'`. That is the whole point — nothing
 * past this projection needs a concept of "temperature control disabled", and
 * nothing past it should ask. `isTemperaturePlanDevice` is then the only question
 * anyone has to answer, and it answers correctly for both reasons a device might
 * have no setpoint.
 *
 * Strictly the temperature axis. The step cluster, `targetPowerConfig` and
 * `controlAdapter` stay: they carry no setpoint write, and clearing them left a
 * flagged stepped device with no ladder (so PELS could only switch it off) and
 * no native stepped wiring.
 *
 * NOT applied to the snapshot the settings UI reads. There, `deviceType` still
 * means "this device HAS a temperature capability" — which is what renders the
 * toggle in the first place, and the saved targets beneath it
 * (`supportsTemperatureDevice` vs `supportsTemperatureControlDevice`).
 */
export const projectTemperatureDeniedDevice = <T extends {
  temperatureControlDisabled?: boolean;
  controlModel?: DeviceControlModel;
}>(device: T): T => {
  if (device.temperatureControlDisabled !== true) return device;
  // The spread yields `T & { targets: []; temperature: undefined; deviceType:
  // 'onoff'; ... }`, which the `: T` return annotation clamps back to `T`. The
  // four overridden keys are narrowed to values the caller's own type already
  // admits, so no caller loses information; spelling that as a mapped return
  // type would force a union on every caller for no gain.
  return {
    ...device,
    targets: [],
    temperature: undefined,
    deviceType: 'onoff',
    controlModel: resolveTemperatureDeniedControlModel(device.controlModel),
  };
};
