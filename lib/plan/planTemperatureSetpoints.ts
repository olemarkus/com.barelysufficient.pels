import type {
  TemperatureSetpoints,
  TemperatureSetpointsByDevice,
} from '../../packages/planner-types/src/temperatureSetpoints';
import type { DevicePlanDevice, TemperatureKind } from './planTypes';

/**
 * A temperature device's setpoints for this build. The builder's seam resolves
 * an entry for every temperature device in the input set
 * (`TemperatureSetpointsByDevice`), so a reader that has narrowed to a
 * temperature device trusts the entry exists.
 */
export function temperatureSetpointsFor(
  setpoints: TemperatureSetpointsByDevice,
  deviceId: string,
): TemperatureSetpoints {
  return setpoints.get(deviceId)!;
}

/**
 * Whether the setpoint this plan commands a device it is not limiting asks the
 * device to work harder than the target it holds now: a resume rather than a
 * further step down. Picked by outcome — the surplus setpoint when surplus lifts
 * the device, the kept one otherwise — because comparing the two numbers is a
 * direction the planner is not told.
 */
export function unlimitedSetpointAddsDemand(
  setpoints: TemperatureSetpointsByDevice,
  device: DevicePlanDevice & TemperatureKind,
): boolean {
  const entry = temperatureSetpointsFor(setpoints, device.id);
  return device.surplusAbsorbActive === true ? entry.surplusAddsDemand : entry.keepAddsDemand;
}
