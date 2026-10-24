import type { DeviceAdapter } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// OSO inCharge 1.0.11 (`drivers/water-heater`): a cloud-polled water heater
// registered as class `other`. Its `onoff` is not a switch. The value reads
// the cloud's "element is heating" flag (the same field as its
// `water_heater_heating`), so a hot, idle tank reads off, and a write sends one
// of OSO's timed force commands: off lasts an hour, on forces heating and
// overrides OSO's own scheduling. Neither can be cancelled. `target_temperature`
// is the real control: a write sets OSO's 24-hour temperature profile to that
// one value, which holds until the next write. So PELS reads the heater as a
// setpoint-only water heater: class `heater`, no `onoff`, limited and resumed
// through its target, with `measure_power` as its draw.
const OSO_WATER_HEATER_DRIVER_ID = 'homey:app:no.osoincharge:water-heater';
const HEATING_FLAG = 'onoff';

const isOsoWaterHeater = (device: HomeyDeviceLike): boolean => device.driverId === OSO_WATER_HEATER_DRIVER_ID;

const withoutHeatingFlag = (capabilityObj: DeviceCapabilityMap): DeviceCapabilityMap => (
  Object.fromEntries(Object.entries(capabilityObj).filter(([capabilityId]) => capabilityId !== HEATING_FLAG))
);

export const osoAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isOsoWaterHeater,
  identity: (device) => ({ ...device, class: 'heater' }),
  overlay: (_device, capabilities, capabilityObj) => ({
    kind: 'standard',
    capabilities: capabilities.filter((capabilityId) => capabilityId !== HEATING_FLAG),
    capabilityObj: withoutHeatingFlag(capabilityObj),
  }),
};
