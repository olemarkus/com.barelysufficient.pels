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
