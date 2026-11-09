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
  matches: (device) => [device.ownerUri, device.driverId]
    .some((value) => value.toLowerCase().includes('sma.modbus')),
  supportsProductionLimits: false,
};
