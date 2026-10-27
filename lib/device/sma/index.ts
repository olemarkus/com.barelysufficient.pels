import type { DeviceAdapter } from '../deviceAdapter';
import { plainDeviceAdapter } from '../standardDeviceAdapter';

/**
 * sma.modbus target_power writes persistent inverter parameters. Repeated
 * curtailment must use that app's volatile percentage action instead. Until
 * that operation has a binding, this integration remains observation-only.
 * Source: https://github.com/ricott/sma.modbus/blob/master/lib/devices/inverter.js
 */
export const smaAdapter: DeviceAdapter = {
  ...plainDeviceAdapter,
  matches: (device) => [device.ownerUri, device.driverUri, device.driverId,
    device.driver?.owner_uri, device.driver?.uri, device.driver?.id]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes('sma.modbus')),
  supportsProductionLimits: false,
};
